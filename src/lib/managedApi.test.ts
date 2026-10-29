import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules() })

describe('server managed API profiles', () => {
  it('accepts an empty browser Key only for managed OpenAI requests through the proxy', async () => {
    vi.stubEnv('VITE_SERVER_MANAGED_API', 'true')
    vi.stubEnv('VITE_API_PROXY_AVAILABLE', 'true')
    const { createDefaultOpenAIProfile, validateApiProfile } = await import('./apiProfiles')
    const profile = { ...createDefaultOpenAIProfile(), apiProxy: true, apiKey: '' }
    expect(validateApiProfile(profile)).toBeNull()
    expect(validateApiProfile({ ...profile, apiProxy: false })).toBe('缺少 API Key')
    expect(validateApiProfile({ ...profile, provider: 'fal' })).toBe('缺少 API Key')
  })

  it('preserves the existing requirement for personal deployments', async () => {
    vi.stubEnv('VITE_SERVER_MANAGED_API', 'false')
    const { createDefaultOpenAIProfile, validateApiProfile } = await import('./apiProfiles')
    expect(validateApiProfile({ ...createDefaultOpenAIProfile(), apiProxy: true, apiKey: '' })).toBe('缺少 API Key')
  })
})
