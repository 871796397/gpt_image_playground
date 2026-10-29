import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest'
import worker from './index.mjs'

let signingKey
let publicKey
const origin = 'https://imgae.godling.uk'
const env = { APP_ORIGIN: origin, ACCESS_ISSUER: 'https://test.cloudflareaccess.com', ACCESS_AUD: 'gallery-audience', OPENAI_API_KEY: 'server-only-test-key' }
const encode = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url')

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])
  signingKey = pair.privateKey
  publicKey = { ...await crypto.subtle.exportKey('jwk', pair.publicKey), kid: 'test-key' }
})
afterEach(() => vi.unstubAllGlobals())

async function headers(claims = {}) {
  const head = encode({ alg: 'RS256', kid: 'test-key' })
  const body = encode({ iss: env.ACCESS_ISSUER, aud: [env.ACCESS_AUD], email: 'owner@example.com', exp: Date.now() / 1000 + 3600, ...claims })
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', signingKey, new TextEncoder().encode(`${head}.${body}`))
  return { 'Cf-Access-Jwt-Assertion': `${head}.${body}.${Buffer.from(signature).toString('base64url')}`, Origin: origin }
}

function mockNetwork(upstream = () => Response.json({ data: [{ b64_json: 'image' }] })) {
  const fetchMock = vi.fn(async (url, init) => String(url).endsWith('/cdn-cgi/access/certs') ? Response.json({ keys: [publicKey] }) : upstream(url, init))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function bucket() {
  const values = new Map()
  return {
    values,
    async put(key, value, options) { values.set(key, { value, options }) },
    async get(key) {
      const item = values.get(key)
      return item && { body: item.value, httpMetadata: item.options.httpMetadata, json: async () => JSON.parse(item.value) }
    },
    async list() { return { objects: [...values.keys()].filter((key) => key.startsWith('tasks/')).sort().map((key) => ({ key })), truncated: false } },
  }
}

describe('Cloudflare shared service', () => {
  it('rejects unauthenticated requests before accessing OpenAI or storage', async () => {
    const fetchMock = mockNetwork()
    const response = await worker.fetch(new Request(`${origin}/api/shared-gallery`), env)
    expect(response.status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects expired, wrong audience and forged Access assertions', async () => {
    mockNetwork()
    for (const claims of [{ exp: 0 }, { aud: ['other'] }, { iss: 'https://attacker.example' }]) {
      expect((await worker.fetch(new Request(`${origin}/api/health`, { headers: await headers(claims) }), env)).status).toBe(401)
    }
    const forged = await headers()
    const parts = forged['Cf-Access-Jwt-Assertion'].split('.')
    parts[2] = (parts[2][0] === 'A' ? 'B' : 'A') + parts[2].slice(1)
    forged['Cf-Access-Jwt-Assertion'] = parts.join('.')
    expect((await worker.fetch(new Request(`${origin}/api/health`, { headers: forged }), env)).status).toBe(401)
  })

  it('injects the secret only for the fixed OpenAI endpoint and strips client credentials', async () => {
    const fetchMock = mockNetwork()
    const response = await worker.fetch(new Request(`${origin}/api-proxy/images/generations`, { method: 'POST', headers: { ...await headers(), Authorization: 'Bearer untrusted', 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'gpt-image-2.5-sunburst', prompt: 'test', n: 1 }) }), env)
    expect(response.status).toBe(200)
    const [url, init] = fetchMock.mock.calls.find(([url]) => String(url).includes('api.openai.com'))
    expect(url).toBe('https://api.openai.com/v1/images/generations')
    expect(init.headers.get('Authorization')).toBe(`Bearer ${env.OPENAI_API_KEY}`)
    expect(init.redirect).toBe('manual')
    expect(JSON.parse(init.body).safety_identifier).toMatch(/^[a-f0-9]{64}$/)
    expect(await response.text()).not.toContain(env.OPENAI_API_KEY)
  })

  it('rejects arbitrary proxy paths, unsupported models and cross-origin writes', async () => {
    mockNetwork()
    const auth = await headers()
    for (const [path, model, source, status] of [['images/generations', 'unapproved', origin, 400], ['https://attacker.example', 'gpt-image-2.5-sunburst', origin, 404], ['images/generations', 'gpt-image-2.5-sunburst', 'https://evil.example', 403]]) {
      const result = await worker.fetch(new Request(`${origin}/api-proxy/${path}`, { method: 'POST', headers: { ...auth, Origin: source, 'Content-Type': 'application/json' }, body: JSON.stringify({ model }) }), env)
      expect(result.status).toBe(status)
    }
  })

  it('does not follow upstream redirects with the server secret', async () => {
    mockNetwork(() => new Response(null, { status: 302, headers: { Location: 'https://other.example' } }))
    const result = await worker.fetch(new Request(`${origin}/api-proxy/images/generations`, { method: 'POST', headers: { ...await headers(), 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'gpt-image-2.5-sunburst' }) }), env)
    expect(result.status).toBe(502)
    expect(result.headers.get('Location')).toBeNull()
  })

  it('publishes once, lists across members, and protects image reads', async () => {
    mockNetwork()
    const storage = bucket()
    const deployment = { ...env, GALLERY: storage }
    const publish = async () => {
      const form = new FormData()
      form.set('task', JSON.stringify({ id: 'local-task', createdAt: 1000, prompt: 'shared prompt', model: 'gpt-image-2.5-sunburst', author: 'forged@example.com' }))
      form.append('images', new Blob(['PNG sample'], { type: 'image/png' }), 'output.png')
      return worker.fetch(new Request(`${origin}/api/shared-gallery`, { method: 'POST', headers: await headers(), body: form }), deployment)
    }
    const result = await publish()
    expect(result.status).toBe(201)
    await publish()
    const page = await worker.fetch(new Request(`${origin}/api/shared-gallery`, { headers: await headers({ email: 'friend@example.com' }) }), deployment)
    const list = await page.json()
    expect(list.items).toHaveLength(1)
    expect(list.items[0].author).toBe('owner@example.com')
    expect(list.items[0].prompt).toBe('shared prompt')
    const image = await worker.fetch(new Request(`${origin}${list.items[0].images[0]}`, { headers: await headers({ email: 'friend@example.com' }) }), deployment)
    expect(image.headers.get('Content-Type')).toBe('image/png')
    expect(await image.text()).toBe('PNG sample')
    expect((await worker.fetch(new Request(`${origin}${list.items[0].images[0]}`), deployment)).status).toBe(401)
    expect(storage.values.size).toBe(2)
  })
})
