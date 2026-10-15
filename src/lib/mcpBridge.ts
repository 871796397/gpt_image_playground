import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { splitBatchPrompts } from './batchPrompts'
import { getActiveApiProfile, normalizeSettings, splitModelList, validateApiProfile } from './apiProfiles'
import { storeImage } from './db'
import { ensureImageCached } from './imageCache'
import { isPresetConfigOnlyEnabled, isPresetConfigParamsLocked, isPresetProfile } from './presetConfig'
import { retryTask, submitTask, useStore } from '../store'
import type { InputImage, TaskParams, TaskRecord } from '../types'

/** 仅客户端：本地 MCP 服务的设置，保存在本机数据库中，不随备份导出 */
export interface McpStatus {
  enabled: boolean
  port: number
  token: string
  /** 生图失败后的自动重试次数，0 为不重试 */
  maxRetries: number
  /** 两次重试之间等待的秒数 */
  retryInterval: number
  running: boolean
  error: string | null
}

export const getMcpStatus = () => invoke<McpStatus>('mcp_get')

export const setMcpStatus = (
  opts: Pick<McpStatus, 'enabled' | 'port' | 'maxRetries' | 'retryInterval'> & { regenerateToken?: boolean },
) => invoke<McpStatus>('mcp_set', { ...opts, regenerateToken: opts.regenerateToken ?? false })

interface McpRequest {
  id: number
  tool: string
  arguments: Record<string, unknown>
}

interface McpReply {
  text: string
  images: Array<{ mime: string; data: string }>
}

const MAX_IMAGES_PER_TASK = 4
const MAX_PROMPTS_PER_CALL = 8
const MAX_IMAGES_PER_CALL = 16

/** 重试也没用的错误：鉴权、额度、内容审核、配置缺失，直接把错误交给 Agent */
const NO_RETRY_PATTERN = /api key|apikey|unauthorized|forbidden|\b40[13]\b|billing|quota|insufficient|balance|safety|moderation|content[_ ]policy|policy violation|余额|额度|审核|违规|API 配置/i

const QUALITIES = ['auto', 'low', 'medium', 'high', 'xhigh', 'max']
const OUTPUT_FORMATS = ['png', 'jpeg', 'webp']

function splitDataUrl(dataUrl: string) {
  const match = dataUrl.match(/^data:([^;,]+);base64,(.*)$/s)
  return match ? { mime: match[1], data: match[2] } : null
}

/** 参数缺省或不是数字时用 fallback，否则取整并限制在范围内 */
function clampInt(value: unknown, min: number, max: number, fallback: number) {
  const num = Number(value)
  if (value == null || !Number.isFinite(num)) return fallback
  return Math.min(max, Math.max(min, Math.floor(num)))
}

async function readImages(ids: string[]) {
  const images: McpReply['images'] = []
  for (const id of ids) {
    const dataUrl = await ensureImageCached(id)
    const parts = dataUrl && splitDataUrl(dataUrl)
    if (parts) images.push(parts)
  }
  return images
}

function waitForTask(taskId: string) {
  const find = () => useStore.getState().tasks.find((task) => task.id === taskId)
  return new Promise<TaskRecord | undefined>((resolve) => {
    const settled = (task?: TaskRecord) => !task || task.status !== 'running'
    if (settled(find())) return resolve(find())
    const unsubscribe = useStore.subscribe(() => {
      if (!settled(find())) return
      unsubscribe()
      resolve(find())
    })
  })
}

// 提交要借用应用的输入区，所以提交之间串行；任务一旦创建就各自运行，生成过程互相并行
let submitQueue: Promise<unknown> = Promise.resolve()

function submitSerially(prompt: string, params: Partial<TaskParams>, inputImages: InputImage[]) {
  const run = submitQueue.then(async () => {
    const before = useStore.getState()
    if (before.batchProgress) throw new Error('应用正在批量提交任务，请稍后重试')
    // 借用后立即还原，用户正在编辑的提示词和参考图不受影响
    const draft = { prompt: before.prompt, inputImages: before.inputImages, params: before.params, maskDraft: before.maskDraft }
    before.clearMaskDraft()
    before.setPrompt(prompt)
    before.setInputImages(inputImages)
    before.setParams(params)
    try {
      const taskId = await submitTask()
      if (!taskId) throw new Error('应用没有创建任务，请检查应用中的提示或 API 配置')
      return taskId
    } finally {
      const state = useStore.getState()
      state.setPrompt(draft.prompt)
      state.setInputImages(draft.inputImages)
      state.setParams(draft.params)
      if (draft.maskDraft) state.setMaskDraft(draft.maskDraft)
    }
  })
  submitQueue = run.catch(() => undefined)
  return run
}

interface JobResult {
  task?: TaskRecord
  retries: number
  error?: string
}

/** 提交一个任务并等它结束；失败时按设置原地重试，鉴权、额度、审核类错误不重试 */
async function runJob(
  prompt: string,
  params: Partial<TaskParams>,
  inputImages: InputImage[],
  maxRetries: number,
  retryInterval: number,
): Promise<JobResult> {
  let retries = 0
  try {
    let taskId = await submitSerially(prompt, params, inputImages)
    for (;;) {
      const task = await waitForTask(taskId)
      if (!task) throw new Error('任务在完成前被删除')
      if (task.status !== 'error' && task.outputImages.length) return { task, retries }
      const error = task.error || '生成失败，没有返回图片'
      const retryable = retries < maxRetries && !task.falRecoverable && !task.customRecoverable && !NO_RETRY_PATTERN.test(error)
      if (!retryable) return { task, retries, error }
      retries += 1
      await new Promise((resolve) => setTimeout(resolve, retryInterval * 1000))
      const next = await retryTask(task, { overwrite: true })
      if (!next) throw new Error('任务在重试前被删除')
      taskId = next
    }
  } catch (err) {
    return { retries, error: err instanceof Error ? err.message : String(err) }
  }
}

async function generateImage(args: Record<string, unknown>): Promise<McpReply> {
  const fromList = Array.isArray(args.prompts)
    ? args.prompts.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
    : []
  const single = typeof args.prompt === 'string' ? args.prompt.trim() : ''
  const prompts = fromList.length ? fromList : single ? [single] : []
  if (!prompts.length) throw new Error('prompt 或 prompts 不能为空')
  if (prompts.length > MAX_PROMPTS_PER_CALL) throw new Error(`prompts 最多 ${MAX_PROMPTS_PER_CALL} 条`)

  const settings = normalizeSettings(useStore.getState().settings)
  const profileError = validateApiProfile(getActiveApiProfile(settings))
  if (profileError) throw new Error(`应用中的 API 配置不完整：${profileError}`)
  if (settings.showBatchPrompt && settings.batchPromptEnabled && prompts.some((item) => splitBatchPrompts(item).length > 1)) {
    throw new Error('应用开启了批量提示词，提示词中的分隔符会被拆成多个任务；请去掉分隔符后重试，或改用 prompts 传多条')
  }

  const params = parseParams(args)
  params.n = params.n ?? 1
  if (prompts.length * params.n > MAX_IMAGES_PER_CALL) {
    throw new Error(`一次调用最多生成 ${MAX_IMAGES_PER_CALL} 张图片（prompts 条数 × n），请拆成多次调用`)
  }

  const references = Array.isArray(args.reference_images) ? args.reference_images : []
  const inputImages: InputImage[] = []
  for (const item of references) {
    if (typeof item !== 'string' || !splitDataUrl(item)) throw new Error('reference_images 中有无法识别的图片')
    inputImages.push({ id: await storeImage(item), dataUrl: item })
  }

  const status = await getMcpStatus()
  const maxRetries = clampInt(args.max_retries, 0, 20, status.maxRetries)
  const retryInterval = clampInt(args.retry_interval, 1, 600, status.retryInterval)
  const results = await Promise.all(prompts.map((prompt) => runJob(prompt, params, inputImages, maxRetries, retryInterval)))

  const images: McpReply['images'] = []
  const lines: string[] = []
  for (const [idx, result] of results.entries()) {
    const label = prompts.length > 1 ? `[${idx + 1}] ` : ''
    const retried = result.retries ? `（自动重试 ${result.retries} 次）` : ''
    if (result.task?.outputImages.length && result.task.status !== 'error') {
      const taskImages = await readImages(result.task.outputImages)
      images.push(...taskImages)
      const failed = result.task.outputErrors?.length ? `；另有 ${result.task.outputErrors.length} 张失败` : ''
      lines.push(`${label}任务 ${result.task.id} 完成${retried}，共 ${taskImages.length} 张${failed}。image id：${result.task.outputImages.join('、')}`)
    } else {
      lines.push(`${label}失败${retried}：${result.error}${result.task ? `（任务 ${result.task.id}）` : ''}`)
    }
  }
  if (!images.length) throw new Error(lines.join('\n'))
  return { text: lines.join('\n'), images }
}

function listHistory(args: Record<string, unknown>): McpReply {
  const limit = Math.min(50, Math.max(1, Math.floor(Number(args.limit) || 10)))
  const items = useStore.getState().tasks.slice(0, limit).map((task) => ({
    task_id: task.id,
    status: task.status,
    prompt: task.prompt,
    size: task.params.size,
    quality: task.params.quality,
    model: task.apiModel,
    created_at: new Date(task.createdAt).toISOString(),
    image_ids: task.outputImages,
    error: task.error,
  }))
  return { text: JSON.stringify(items, null, 2), images: [] }
}

async function getImage(args: Record<string, unknown>): Promise<McpReply> {
  const id = typeof args.image_id === 'string' ? args.image_id : ''
  const images = await readImages(id ? [id] : [])
  if (!images.length) throw new Error('找不到这张图片')
  return { text: `image id：${id}`, images }
}

async function getState(): Promise<McpReply> {
  const { settings, params } = useStore.getState()
  const normalized = normalizeSettings(settings)
  const profile = getActiveApiProfile(normalized)
  const mcp = await getMcpStatus()
  const state = {
    active_profile: profile.name,
    api_profiles: normalized.profiles.map((item) => ({
      id: item.id,
      name: item.name,
      provider: item.provider,
      models: splitModelList(item.model),
      api_mode: item.apiMode,
      active: item.id === normalized.activeProfileId,
    })),
    provider: profile.provider,
    model: profile.model,
    api_mode: profile.apiMode,
    default_params: params,
    auto_retry: { max_retries: mcp.maxRetries, retry_interval_seconds: mcp.retryInterval },
  }
  return { text: JSON.stringify(state, null, 2), images: [] }
}

async function setActiveProfile(args: Record<string, unknown>): Promise<McpReply> {
  const query = typeof args.profile === 'string' ? args.profile.trim() : ''
  const settings = normalizeSettings(useStore.getState().settings)
  const profile = settings.profiles.find((item) => item.id === query)
    ?? settings.profiles.find((item) => item.name.trim().toLowerCase() === query.toLowerCase())
  if (!query || !profile) {
    throw new Error(`找不到 API 配置「${query}」，可用的有：${settings.profiles.map((item) => item.name).join('、')}`)
  }
  if (isPresetConfigOnlyEnabled() && !isPresetProfile(profile.id)) throw new Error('应用只允许使用预置的 API 配置')
  const model = typeof args.model === 'string' ? args.model.trim() : ''
  if (model && !splitModelList(profile.model).includes(model)) {
    throw new Error(`配置「${profile.name}」没有模型「${model}」，可用的有：${splitModelList(profile.model).join('、')}`)
  }
  const state = useStore.getState()
  state.setReusedTaskApiProfile(null)
  state.setSettings({
    activeProfileId: profile.id,
    profiles: model
      ? settings.profiles.map((item) => item.id === profile.id ? { ...item, selectedModel: model } : item)
      : settings.profiles,
  })
  const active = getActiveApiProfile(useStore.getState().settings)
  return { text: `已切换到 API 配置「${active.name}」，模型 ${active.model}`, images: [] }
}

/** 校验并解析生图参数，只返回传入的字段；generate_image 和 set_default_params 共用 */
function parseParams(args: Record<string, unknown>): Partial<TaskParams> {
  const patch: Partial<TaskParams> = {}
  if (args.size !== undefined) {
    if (typeof args.size !== 'string' || !args.size.trim()) throw new Error('size 必须是非空字符串')
    patch.size = args.size.trim()
  }
  if (args.quality !== undefined) {
    if (typeof args.quality !== 'string' || !QUALITIES.includes(args.quality)) throw new Error(`quality 只能是 ${QUALITIES.join('、')}`)
    patch.quality = args.quality as TaskParams['quality']
  }
  if (args.output_format !== undefined) {
    if (typeof args.output_format !== 'string' || !OUTPUT_FORMATS.includes(args.output_format)) throw new Error(`output_format 只能是 ${OUTPUT_FORMATS.join('、')}`)
    patch.output_format = args.output_format as TaskParams['output_format']
  }
  if (args.moderation !== undefined) {
    if (args.moderation !== 'auto' && args.moderation !== 'low') throw new Error('moderation 只能是 auto、low')
    patch.moderation = args.moderation
  }
  if (args.output_compression !== undefined) {
    patch.output_compression = args.output_compression === null ? null : clampInt(args.output_compression, 0, 100, 100)
  }
  if (args.n !== undefined) patch.n = clampInt(args.n, 1, MAX_IMAGES_PER_TASK, 1)
  if (args.transparent_output !== undefined) {
    if (typeof args.transparent_output !== 'boolean') throw new Error('transparent_output 必须是 true 或 false')
    patch.transparent_output = args.transparent_output
    const format = patch.output_format ?? useStore.getState().params.output_format
    if (args.transparent_output && format !== 'png' && format !== 'webp') {
      throw new Error('透明背景只支持 png 或 webp 格式，请同时指定 output_format')
    }
  }
  return patch
}

function setDefaultParams(args: Record<string, unknown>): McpReply {
  if (isPresetConfigParamsLocked()) throw new Error('应用锁定了预置参数，不能修改')
  const patch = parseParams(args)
  if (!Object.keys(patch).length) throw new Error('没有要修改的参数')
  useStore.getState().setParams(patch)
  return { text: `已更新默认参数：${JSON.stringify(useStore.getState().params, null, 2)}`, images: [] }
}

async function runTool(request: McpRequest): Promise<McpReply> {
  switch (request.tool) {
    case 'generate_image':
      return generateImage(request.arguments)
    case 'list_history':
      return listHistory(request.arguments)
    case 'get_image':
      return getImage(request.arguments)
    case 'get_state':
      return getState()
    case 'set_active_profile':
      return setActiveProfile(request.arguments)
    case 'set_default_params':
      return setDefaultParams(request.arguments)
    default:
      throw new Error(`未知工具：${request.tool}`)
  }
}

/** 启动时调用一次：接收 Rust 侧转来的 MCP 调用，执行后回传结果 */
export function installMcpBridge() {
  void listen<McpRequest>('mcp-request', ({ payload }) => {
    const run = async () => {
      try {
        const result = await runTool(payload)
        await invoke('mcp_respond', { id: payload.id, result })
      } catch (err) {
        await invoke('mcp_respond', { id: payload.id, error: err instanceof Error ? err.message : String(err) })
      }
    }
    run().catch((err) => console.error('回传 MCP 结果失败：', err))
  }).catch((err) => console.error('注册 MCP 请求监听失败：', err))
}
