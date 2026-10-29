// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { TaskRecord } from '../types'

const mock = vi.hoisted(() => ({ listener: null as null | ((state: { tasks: TaskRecord[] }, previous: { tasks: TaskRecord[] }) => void), share: vi.fn().mockResolvedValue(undefined), toast: vi.fn() }))
vi.mock('../lib/managedApi', () => ({ managedApiEnabled: true }))
vi.mock('../lib/sharedGallery', () => ({ shareTask: mock.share }))
vi.mock('../store', () => ({ useStore: {
  getState: () => ({ tasks: [], showToast: mock.toast }),
  subscribe: (fn: typeof mock.listener) => { mock.listener = fn; return () => { mock.listener = null } },
} }))
import { useSharedGallerySync } from './useSharedGallerySync'

function Harness() { useSharedGallerySync(true); return null }

it('shares completed gallery transitions and first-time Agent outputs, without uploading unchanged history', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  localStorage.clear()
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(<Harness />))
  const gallery = { id: 'gallery', status: 'done', outputImages: ['gallery-image'] } as TaskRecord
  const agent = { id: 'agent', status: 'done', outputImages: ['agent-image'], sourceMode: 'agent' } as TaskRecord
  await act(async () => {
    mock.listener?.({ tasks: [gallery] }, { tasks: [{ ...gallery, status: 'running', outputImages: [] }] })
    await new Promise((resolve) => setTimeout(resolve, 0))
    mock.listener?.({ tasks: [agent, gallery] }, { tasks: [gallery] })
    await new Promise((resolve) => setTimeout(resolve, 0))
    mock.listener?.({ tasks: [agent, gallery] }, { tasks: [agent, gallery] })
  })
  expect(mock.share.mock.calls.map(([task]) => task.id)).toEqual(['gallery', 'agent'])
  expect(JSON.parse(localStorage.getItem('shared-gallery-pending-v1') || 'null')).toEqual([])
  await act(async () => root.unmount())
  host.remove()
  expect(mock.listener).toBeNull()
})
