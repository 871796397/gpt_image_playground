import { useEffect } from 'react'
import type { TaskRecord } from '../types'
import { useStore } from '../store'
import { managedApiEnabled } from '../lib/managedApi'
import { shareTask } from '../lib/sharedGallery'

const pendingKey = 'shared-gallery-pending-v1'
const pending = new Map<string, TaskRecord>()
let uploading = false

function savePending() {
  try { localStorage.setItem(pendingKey, JSON.stringify([...pending.keys()])) } catch (error) { console.warn('保存待同步作品失败', error) }
}

async function uploadPending() {
  if (uploading) return
  uploading = true
  try {
    while (pending.size) {
      const entry = pending.entries().next().value
      if (!entry) break
      const [id, task] = entry
      try {
        await shareTask(task)
        if (pending.get(id) === task) pending.delete(id)
        savePending()
      } catch (error) {
        console.warn('共享作品同步失败', error)
        useStore.getState().showToast(`作品已保存在本机，共享同步失败：${error instanceof Error ? error.message : '网络异常'}。可在共享图库重试。`, 'error')
        break
      }
    }
  } finally { uploading = false }
}

export function retrySharedGallerySync() { void uploadPending() }

export function useSharedGallerySync(ready: boolean) {
  useEffect(() => {
    if (!ready || !managedApiEnabled) return
    try {
      const ids: unknown = JSON.parse(localStorage.getItem(pendingKey) || '[]')
      if (Array.isArray(ids)) for (const id of ids) {
        const task = useStore.getState().tasks.find((item) => item.id === id)
        if (task?.status === 'done' && task.outputImages.length) pending.set(task.id, task)
      }
    } catch (error) { console.warn('读取待同步作品失败', error) }
    void uploadPending()
    const unsubscribe = useStore.subscribe((state, previous) => {
      if (state.tasks === previous.tasks) return
      const old = new Map(previous.tasks.map((task) => [task.id, task]))
      for (const task of state.tasks) {
        if (task.status !== 'done' || !task.outputImages.length) continue
        const before = old.get(task.id)
        if (before?.status === 'done' && before.outputImages.join() === task.outputImages.join()) continue
        pending.set(task.id, task)
      }
      if (pending.size) { savePending(); void uploadPending() }
    })
    window.addEventListener('online', retrySharedGallerySync)
    return () => { unsubscribe(); window.removeEventListener('online', retrySharedGallerySync) }
  }, [ready])
}
