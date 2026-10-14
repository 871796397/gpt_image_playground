import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { splitBatchPrompts } from './batchPrompts'
import { getActiveApiProfile, normalizeSettings, validateApiProfile } from './apiProfiles'
import { storeImage } from './db'
import { ensureImageCached } from './imageCache'
import { submitTask, useStore } from '../store'
import type { TaskParams, TaskRecord } from '../types'

/** 仅客户端：本地 MCP 服务的设置，保存在本机数据库中，不随备份导出 */
export interface McpStatus {
  enabled: boolean
  port: number
  token: string
  running: boolean
  error: string | null
}

export const getMcpStatus = () => invoke<McpStatus>('mcp_get')

export const setMcpStatus = (enabled: boolean, port: number, regenerateToken = false) =>
  invoke<McpStatus>('mcp_set', { enabled, port, regenerateToken })

interface McpRequest {
  id: number
  tool: string
  arguments: Record<string, unknown>
}

interface McpReply {
  text: string
  images: Array<{ mime: string; data: string }>
}

const MAX_IMAGES_PER_CALL = 4

function splitDataUrl(dataUrl: string) {
  const match = dataUrl.match(/^data:([^;,]+);base64,(.*)$/s)
  return match ? { mime: match[1], data: match[2] } : null
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

async function generateImage(args: Record<string, unknown>): Promise<McpReply> {
  const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
  if (!prompt) throw new Error('prompt 不能为空')
  const settings = normalizeSettings(useStore.getState().settings)
  const profileError = validateApiProfile(getActiveApiProfile(settings))
  if (profileError) throw new Error(`应用中的 API 配置不完整：${profileError}`)
  if (settings.showBatchPrompt && settings.batchPromptEnabled && splitBatchPrompts(prompt).length > 1) {
    throw new Error('应用开启了批量提示词，提示词中的分隔符会被拆成多个任务；请去掉分隔符后重试')
  }

  const params: Partial<TaskParams> = {}
  if (typeof args.size === 'string' && args.size) params.size = args.size
  if (typeof args.quality === 'string') params.quality = args.quality as TaskParams['quality']
  if (typeof args.output_format === 'string') params.output_format = args.output_format as TaskParams['output_format']
  params.n = Math.min(MAX_IMAGES_PER_CALL, Math.max(1, Math.floor(Number(args.n) || 1)))

  const references = Array.isArray(args.reference_images) ? args.reference_images : []
  const inputImages = []
  for (const item of references) {
    if (typeof item !== 'string' || !splitDataUrl(item)) throw new Error('reference_images 中有无法识别的图片')
    inputImages.push({ id: await storeImage(item), dataUrl: item })
  }

  // 生成走应用当前的输入区状态：借用后立即还原，用户正在编辑的提示词和参考图不受影响
  const before = useStore.getState()
  const draft = { prompt: before.prompt, inputImages: before.inputImages, params: before.params, maskDraft: before.maskDraft }
  const knownTaskIds = new Set(before.tasks.map((task) => task.id))
  before.clearMaskDraft()
  before.setPrompt(prompt)
  before.setInputImages(inputImages)
  before.setParams(params)
  let created: TaskRecord | undefined
  try {
    await submitTask()
    created = useStore.getState().tasks.find((task) => !knownTaskIds.has(task.id))
  } finally {
    const state = useStore.getState()
    state.setPrompt(draft.prompt)
    state.setInputImages(draft.inputImages)
    state.setParams(draft.params)
    if (draft.maskDraft) state.setMaskDraft(draft.maskDraft)
  }
  if (!created) throw new Error('应用没有创建任务，请检查应用中的提示或 API 配置')

  const task = await waitForTask(created.id)
  if (!task) throw new Error('任务在完成前被删除')
  if (task.status === 'error' || !task.outputImages.length) throw new Error(task.error || '生成失败，没有返回图片')
  const images = await readImages(task.outputImages)
  const failed = task.outputErrors?.length ? `；另有 ${task.outputErrors.length} 张失败` : ''
  return {
    text: `任务 ${task.id} 完成，共 ${images.length} 张${failed}。image id：${task.outputImages.join('、')}`,
    images,
  }
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

function getState(): McpReply {
  const { settings, params } = useStore.getState()
  const profile = getActiveApiProfile(normalizeSettings(settings))
  const state = {
    api_profile: profile.name,
    provider: profile.provider,
    model: profile.selectedModel || profile.model,
    api_mode: profile.apiMode,
    default_params: params,
  }
  return { text: JSON.stringify(state, null, 2), images: [] }
}

// 只有生成要占用应用的输入区，生成之间串行；读取类工具不排队，生成进行中也能立即返回
let queue: Promise<unknown> = Promise.resolve()

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
    const done = payload.tool === 'generate_image' ? (queue = queue.then(run)) : run()
    done.catch((err) => console.error('回传 MCP 结果失败：', err))
  }).catch((err) => console.error('注册 MCP 请求监听失败：', err))
}
