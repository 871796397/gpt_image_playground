export async function probeUpstream(env) {
  const [upstream, trace] = await Promise.all([
    fetch('https://api.openai.com/v1/models/gpt-image-2.5-sunburst', { headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` }, redirect: 'manual', signal: AbortSignal.timeout(10000) }),
    fetch('https://www.cloudflare.com/cdn-cgi/trace', { redirect: 'manual', signal: AbortSignal.timeout(10000) }).then((r) => r.text()).catch(() => ''),
  ])
  const result = await upstream.json().catch(() => ({}))
  const location = Object.fromEntries(trace.split('\n').filter((line) => line.includes('=')).map((line) => line.split('=')))
  return { upstreamStatus: upstream.status, upstreamCode: result.error?.code || null, upstreamRay: upstream.headers.get('cf-ray'), upstreamRequestId: upstream.headers.get('x-request-id'), traceColo: location.colo || null, traceCountry: location.loc || null }
}

// 无公开 HTTP 入口，也不持久化请求；只接收已认证 Worker 的内部调用。
export class OpenAIBackend {
  constructor(_state, env) { this.env = env }

  async fetch(request) {
    const url = new URL(request.url)
    if (url.origin !== 'https://openai-backend.internal') return new Response(null, { status: 404 })
    if (url.pathname === '/diagnose' && request.method === 'GET') return Response.json(await probeUpstream(this.env))
    if (request.method !== 'POST' || !['/images/generations', '/images/edits', '/responses'].includes(url.pathname)) return new Response(null, { status: 404 })
    const headers = new Headers({ Authorization: `Bearer ${this.env.OPENAI_API_KEY}` })
    const contentType = request.headers.get('Content-Type')
    if (contentType) headers.set('Content-Type', contentType)
    return fetch(`https://api.openai.com/v1${url.pathname}`, { method: 'POST', headers, body: request.body, redirect: 'manual', signal: request.signal })
  }
}

export function getBackend(env) {
  const namespace = env.OPENAI_BACKEND.jurisdiction('us')
  return namespace.get(namespace.idFromName('openai-v1'), { locationHint: 'enam' })
}
