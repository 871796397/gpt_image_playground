const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } })
const imageModels = new Set(['gpt-image-2.5-sunburst', 'gpt-image-2.5-flare', 'gpt-image-2'])
let certCache

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status }
}

function decode64(value) {
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
}

export async function authenticate(request, env) {
  const token = request.headers.get('Cf-Access-Jwt-Assertion')
  if (!token || !env.ACCESS_AUD || !env.ACCESS_ISSUER) throw new ApiError(401, '请重新登录后使用')
  try {
    const [head, body, signature] = token.split('.')
    const header = JSON.parse(new TextDecoder().decode(decode64(head)))
    const claims = JSON.parse(new TextDecoder().decode(decode64(body)))
    const now = Date.now() / 1000
    if (header.alg !== 'RS256' || claims.iss !== env.ACCESS_ISSUER || claims.exp <= now || !Number.isFinite(claims.exp) || (claims.nbf && claims.nbf > now + 30) || !claims.email || !Array.isArray(claims.aud) || !claims.aud.includes(env.ACCESS_AUD)) throw new Error('Invalid claims')
    if (!certCache || certCache.issuer !== env.ACCESS_ISSUER || certCache.expires < Date.now() || !certCache.keys.some((k) => k.kid === header.kid)) {
      const response = await fetch(`${env.ACCESS_ISSUER}/cdn-cgi/access/certs`)
      if (!response.ok) throw new Error('Certificate lookup failed')
      certCache = { issuer: env.ACCESS_ISSUER, expires: Date.now() + 3600000, keys: (await response.json()).keys }
    }
    const jwk = certCache.keys.find((k) => k.kid === header.kid)
    if (!jwk) throw new Error('Unknown key')
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
    if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, decode64(signature), new TextEncoder().encode(`${head}.${body}`))) throw new Error('Invalid signature')
    return claims.email.toLowerCase()
  } catch {
    throw new ApiError(401, '登录已失效，请刷新页面重新登录')
  }
}

async function digest(value) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), (b) => b.toString(16).padStart(2, '0')).join('')
}

async function readBody(request) {
  if (!request.body) throw new ApiError(400, '请求内容为空')
  const reader = request.body.getReader()
  const chunks = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > 55 * 1024 * 1024) { await reader.cancel(); throw new ApiError(413, '上传内容过大') }
    chunks.push(value)
  }
  return new Response(new Blob(chunks), { headers: { 'Content-Type': request.headers.get('Content-Type') || '' } })
}

async function proxy(request, env, email, path) {
  if (request.method !== 'POST' || !['images/generations', 'images/edits', 'responses'].includes(path)) throw new ApiError(404, '接口不存在')
  if (!env.OPENAI_API_KEY) throw new ApiError(503, '管理员尚未配置生图服务')
  const safetyId = await digest(email)
  const multipart = request.headers.get('Content-Type')?.includes('multipart/form-data')
  const input = await readBody(request)
  const body = multipart ? await input.formData() : await input.json()
  if (!multipart && (!body || typeof body !== 'object' || Array.isArray(body))) throw new ApiError(400, '请求格式无效')
  const model = multipart ? body.get('model') : body.model
  if (path === 'responses' ? model !== 'gpt-6.1-sol' : !imageModels.has(model)) throw new ApiError(400, '此共享服务不支持该模型')
  const count = Number(multipart ? body.get('n') ?? 1 : body.n ?? 1)
  if (!Number.isInteger(count) || count < 1 || count > 10) throw new ApiError(400, '单次最多生成 10 张图片')
  if (path === 'responses') {
    if (body.tools?.some((tool) => tool.type === 'image_generation' && tool.model && !imageModels.has(tool.model))) throw new ApiError(400, '不支持该图像模型')
    body.store = false
  }
  if (multipart) body.set('safety_identifier', safetyId)
  else body.safety_identifier = safetyId
  const headers = new Headers({ Authorization: `Bearer ${env.OPENAI_API_KEY}` })
  if (!multipart) headers.set('Content-Type', 'application/json')
  const response = await fetch(`https://api.openai.com/v1/${path}`, { method: 'POST', headers, body: multipart ? body : JSON.stringify(body), signal: request.signal, redirect: 'manual' })
  if (response.status >= 300 && response.status < 400) throw new ApiError(502, '官方 API 返回了异常重定向，请联系管理员')
  if (!response.ok) {
    const error = await response.json().catch(() => ({}))
    const code = error.error?.code
    const message = response.status === 401 ? '官方 API Key 无效，请联系管理员'
      : response.status === 429 ? '官方 API 额度不足或请求过多，请稍后重试或联系管理员'
        : response.status === 403 ? '此项目尚无该模型使用权限，请联系管理员'
          : error.error?.message?.replaceAll(env.OPENAI_API_KEY, '[redacted]') || '官方生图服务暂时不可用'
    return json({ error: { message, code } }, response.status)
  }
  return new Response(response.body, { status: response.status, headers: { 'Content-Type': response.headers.get('Content-Type') || 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } })
}

async function gallery(request, env, email, url) {
  if (!env.GALLERY) throw new ApiError(503, '共享图库尚未连接存储')
  if (url.pathname.startsWith('/api/shared-gallery/image/')) {
    if (request.method !== 'GET') throw new ApiError(405, '不支持此操作')
    const key = decodeURIComponent(url.pathname.slice('/api/shared-gallery/image/'.length))
    if (!/^images\/[a-f0-9]{64}\/\d+\.(png|jpeg|webp)$/.test(key)) throw new ApiError(404, '图片不存在')
    const object = await env.GALLERY.get(key)
    if (!object) throw new ApiError(404, '图片不存在')
    return new Response(object.body, { headers: { 'Content-Type': object.httpMetadata.contentType, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } })
  }
  if (url.pathname !== '/api/shared-gallery') throw new ApiError(404, '接口不存在')
  if (request.method === 'GET') {
    const result = await env.GALLERY.list({ prefix: 'tasks/', limit: 24, cursor: url.searchParams.get('cursor') || undefined })
    const objects = await Promise.all(result.objects.map((item) => env.GALLERY.get(item.key)))
    const items = await Promise.all(objects.filter(Boolean).map((item) => item.json()))
    return json({ items, cursor: result.truncated ? result.cursor : null, viewer: email })
  }
  if (request.method !== 'POST') throw new ApiError(405, '不支持此操作')
  const form = await (await readBody(request)).formData()
  let task
  try { task = JSON.parse(form.get('task')) } catch { throw new ApiError(400, '作品信息无效') }
  if (!task || typeof task.id !== 'string' || task.id.length > 200 || !task.id || typeof task.prompt !== 'string' || task.prompt.length > 32000 || !Number.isSafeInteger(task.createdAt) || task.createdAt < 0 || task.createdAt > Date.now() + 60000) throw new ApiError(400, '作品信息无效')
  const files = form.getAll('images')
  if (!files.length || files.length > 10 || files.some((f) => typeof f === 'string' || !['image/png', 'image/jpeg', 'image/webp'].includes(f.type) || f.size > 20 * 1024 * 1024 || !f.size)) throw new ApiError(400, '只支持 PNG、JPEG、WebP 图片，每张最多 20MB，单次最多 10 张')
  if (files.reduce((sum, f) => sum + f.size, 0) > 50 * 1024 * 1024) throw new ApiError(413, '作品总大小不能超过 50MB')
  const id = await digest(`${email}:${task.id}`)
  const key = `tasks/${String(9999999999999 - task.createdAt).padStart(13, '0')}/${id}.json`
  const images = await Promise.all(files.map(async (file, idx) => {
    const type = file.type.split('/')[1]
    const imageKey = `images/${id}/${idx}.${type}`
    await env.GALLERY.put(imageKey, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } })
    return `/api/shared-gallery/image/${encodeURIComponent(imageKey)}`
  }))
  const item = { id, prompt: task.prompt, model: String(task.model || '').slice(0, 100), createdAt: task.createdAt, author: email, images }
  await env.GALLERY.put(key, JSON.stringify(item), { httpMetadata: { contentType: 'application/json' } })
  return json(item, 201)
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api-proxy/')) return env.ASSETS.fetch(request)
    const requestId = crypto.randomUUID()
    try {
      if (url.origin !== env.APP_ORIGIN) throw new ApiError(403, '请从正式网站访问')
      const email = await authenticate(request, env)
      if (request.method !== 'GET' && request.headers.get('Origin') !== env.APP_ORIGIN) throw new ApiError(403, '请求来源无效，请刷新后重试')
      if (Number(request.headers.get('Content-Length')) > 55 * 1024 * 1024) throw new ApiError(413, '上传内容过大')
      if (url.pathname === '/api/health') return json({ ready: Boolean(env.OPENAI_API_KEY && env.GALLERY), sharedGallery: Boolean(env.GALLERY) })
      if (url.pathname.startsWith('/api-proxy/')) return await proxy(request, env, email, url.pathname.slice('/api-proxy/'.length))
      return await gallery(request, env, email, url)
    } catch (error) {
      if (error instanceof ApiError) return json({ error: { message: error.message }, requestId }, error.status)
      if (error instanceof SyntaxError || error instanceof TypeError && request.method !== 'GET' && !request.headers.get('Content-Type')) return json({ error: { message: '请求格式无效' }, requestId }, 400)
      console.error(JSON.stringify({ level: 'error', requestId, path: url.pathname, type: error?.name || 'Error', message: String(error?.message || 'Unknown error').replaceAll(env.OPENAI_API_KEY || '[unset]', '[redacted]').slice(0, 200) }))
      return json({ error: { message: '服务处理失败，请稍后重试' }, requestId }, 500)
    }
  },
}
