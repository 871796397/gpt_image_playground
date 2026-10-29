import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { getSharedGallery, type SharedGalleryItem } from '../lib/sharedGallery'
import { retrySharedGallerySync } from '../hooks/useSharedGallerySync'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'
import { usePreventBackgroundScroll } from '../hooks/usePreventBackgroundScroll'

export default function SharedGalleryModal({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<SharedGalleryItem[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const activeRequest = useRef<AbortController | null>(null)
  useCloseOnEscape(true, onClose)
  usePreventBackgroundScroll(true, scrollRef)
  const load = useCallback(async (nextCursor?: string) => {
    activeRequest.current?.abort()
    const controller = new AbortController()
    activeRequest.current = controller
    setBusy(true)
    try {
      const page = await getSharedGallery(nextCursor, controller.signal)
      setItems((previous) => {
        const merged = new Map([...previous, ...page.items].map((item) => [item.id, item]))
        return [...merged.values()].sort((a, b) => b.createdAt - a.createdAt)
      })
      setCursor((previous) => nextCursor || !previous ? page.cursor : previous)
      setError('')
    } catch (err) {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : '共享图库读取失败')
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }, [])
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    closeRef.current?.focus()
    const refresh = () => { if (!document.hidden) void load() }
    refresh()
    const timer = window.setInterval(refresh, 15000)
    window.addEventListener('shared-gallery-changed', refresh)
    return () => {
      clearInterval(timer)
      activeRequest.current?.abort()
      window.removeEventListener('shared-gallery-changed', refresh)
      previous?.focus()
    }
  }, [load])

  return createPortal(
    <div role="dialog" aria-modal="true" aria-labelledby="shared-gallery-title" className="fixed inset-0 z-[80] flex flex-col bg-gray-50 text-gray-900 dark:bg-gray-950 dark:text-gray-100" onKeyDown={(event) => {
      if (event.key !== 'Tab') return
      const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), a[href]')]
      const first = controls[0]
      const last = controls[controls.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }}>
      <div className="safe-area-top border-b border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
        <div className="safe-area-x mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 py-4">
          <div><h2 id="shared-gallery-title" className="text-lg font-semibold">共享图库</h2><p className="mt-1 text-xs text-gray-500">所有登录成员可查看新生成的作品、提示词和作者，每 15 秒更新。删除本地作品不影响共享图库。</p></div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => { retrySharedGallerySync(); void load() }} disabled={busy} className="rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:opacity-50 dark:border-gray-700">{busy ? '正在更新…' : '刷新 / 重试同步'}</button>
            <button ref={closeRef} type="button" onClick={onClose} className="rounded-lg bg-gray-900 px-3 py-2 text-sm text-white dark:bg-gray-100 dark:text-gray-900">返回工作台</button>
          </div>
        </div>
      </div>
      <div ref={scrollRef} className="safe-area-x mx-auto w-full max-w-7xl flex-1 overflow-y-auto py-6">
        {error && <p role="alert" className="mb-4 rounded-xl bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/30 dark:text-red-200">{error}</p>}
        {!items.length && !busy && !error && <p className="py-20 text-center text-gray-500">还没有共享作品。回到工作台生成第一张，完成后会自动出现在这里。</p>}
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((item) => <article key={item.id} className="overflow-hidden rounded-2xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
            <div className="grid gap-1">
              {item.images.map((url, index) => <a key={url} href={url} target="_blank" rel="noreferrer" aria-label={`查看 ${item.author} 的作品 ${index + 1}`}><img src={url} alt={item.prompt} loading="lazy" className="aspect-square w-full bg-gray-100 object-contain dark:bg-gray-800" /></a>)}
            </div>
            <div className="space-y-2 p-4">
              <p className="break-words text-xs font-medium text-blue-600 dark:text-blue-300">{item.author}</p>
              <p className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-sm">{item.prompt}</p>
              <p className="text-xs text-gray-500">{new Date(item.createdAt).toLocaleString()} · {item.model}</p>
              <div className="flex flex-wrap gap-3">{item.images.map((url, index) => <a key={url} href={url} download={`shared-${item.id}-${index + 1}`} className="text-xs text-blue-600 underline dark:text-blue-300">下载图片 {index + 1}</a>)}</div>
            </div>
          </article>)}
        </div>
        {cursor && <div className="py-6 text-center"><button type="button" disabled={busy} onClick={() => void load(cursor)} className="rounded-xl border border-gray-300 px-5 py-2 text-sm dark:border-gray-700">加载更多</button></div>}
      </div>
    </div>, document.body,
  )
}
