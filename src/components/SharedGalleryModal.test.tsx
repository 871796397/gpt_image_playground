// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ get: vi.fn(), remove: vi.fn(), retry: vi.fn() }))
vi.mock('../lib/sharedGallery', () => ({ getSharedGallery: mocks.get, deleteSharedGalleryItem: mocks.remove }))
vi.mock('../hooks/useSharedGallerySync', () => ({ retrySharedGallerySync: mocks.retry }))
import SharedGalleryModal from './SharedGalleryModal'

afterEach(() => { vi.clearAllMocks() })

it('requires confirmation, retains a work on cancel, and removes remotely deleted works on refresh', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const item = { id: 'owned', prompt: 'owned work', author: 'owner@example.com', model: 'test', createdAt: 1000, images: ['/image'], canDelete: true }
  const friend = { ...item, id: 'friend', prompt: 'friend work', canDelete: false }
  mocks.get.mockResolvedValue({ items: [item, friend], cursor: null })
  mocks.remove.mockResolvedValue(undefined)
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const button = (text: string) => [...document.querySelectorAll('button')].find((node) => node.textContent === text)!
  try {
    await act(async () => root.render(<SharedGalleryModal onClose={() => {}} />))
    expect([...document.querySelectorAll('button')].filter((node) => node.textContent === '删除共享作品')).toHaveLength(1)
    await act(async () => button('删除共享作品').click())
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull()
    expect(mocks.remove).not.toHaveBeenCalled()
    await act(async () => button('取消').click())
    expect(document.querySelectorAll('article')).toHaveLength(2)
    await act(async () => button('删除共享作品').click())
    await act(async () => button('确认删除').click())
    expect(mocks.remove).toHaveBeenCalledWith(item)
    expect(document.querySelectorAll('article')).toHaveLength(1)
    mocks.get.mockResolvedValue({ items: [], cursor: null })
    await act(async () => button('刷新 / 重试同步').click())
    expect(document.querySelectorAll('article')).toHaveLength(0)
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})
