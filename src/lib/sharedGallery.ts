import type { TaskRecord } from '../types'
import { getImage } from './db'
import { dataUrlToBlob } from './canvasImage'

export interface SharedGalleryItem {
  id: string
  prompt: string
  model: string
  author: string
  createdAt: number
  images: string[]
}

export interface SharedGalleryPage {
  items: SharedGalleryItem[]
  cursor: string | null
  viewer: string
}

async function readResponse<T>(response: Response): Promise<T> {
  if (response.redirected || !response.headers.get('Content-Type')?.includes('application/json')) throw new Error('登录已失效，请刷新页面重新登录')
  const body = await response.json()
  if (!response.ok) throw new Error(body.error?.message || '共享图库暂时不可用')
  return body as T
}

export async function getSharedGallery(cursor?: string, signal?: AbortSignal) {
  return readResponse<SharedGalleryPage>(await fetch(`/api/shared-gallery${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, { signal, cache: 'no-store' }))
}

export async function shareTask(task: TaskRecord) {
  const form = new FormData()
  form.set('task', JSON.stringify({ id: task.id, prompt: task.prompt, model: task.apiModel, createdAt: task.createdAt }))
  for (const id of task.outputImages) {
    const image = await getImage(id)
    if (!image) throw new Error('本机作品图片缺失，无法同步')
    form.append('images', await dataUrlToBlob(image.dataUrl), `${id}.${image.dataUrl.split(';')[0].split('/')[1]}`)
  }
  await readResponse<SharedGalleryItem>(await fetch('/api/shared-gallery', { method: 'POST', body: form }))
  window.dispatchEvent(new Event('shared-gallery-changed'))
}
