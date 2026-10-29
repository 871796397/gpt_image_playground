import type { ApiProfile } from '../types'
import { shouldUseApiProxy } from './devProxy'
import { readRuntimeEnv } from './runtimeEnv'

export const managedApiEnabled = readRuntimeEnv(import.meta.env.VITE_SERVER_MANAGED_API) === 'true'

export function isManagedApiProfile(profile: ApiProfile) {
  return managedApiEnabled && profile.provider === 'openai' && shouldUseApiProxy(profile.apiProxy)
}
