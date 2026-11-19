// Is this tab running the UI the server has now? A tab keeps the code it loaded until it is reloaded, so after a deploy an
// open tab can show things the new code has fixed. Each build names its entry script by a hash of its content
// (/assets/index-<hash>.js), so comparing that name in the server's index.html with this page's says whether a newer one
// is there. Checked when the live connection comes back (a deploy restarts the console), when the tab is shown again,
// and every 10 minutes.
import { live } from './live'
import { createStore } from './store'

export const updateStore = createStore(false)

/** The entry script's path in an index.html, or null (the dev server's /src/main.tsx counts too, and never changes). */
export function entryOf(html: string): string | null {
  for (const m of html.matchAll(/<script\b[^>]*>/gi)) {
    const tag = m[0]
    if (!/\btype=["']?module\b/i.test(tag)) continue
    const src = /\bsrc=["']([^"']+)["']/i.exec(tag)
    if (src) return src[1]
  }
  return null
}

function ownEntry(): string | null {
  const el = document.querySelector<HTMLScriptElement>('script[type="module"][src]')
  return el ? path(el.getAttribute('src') ?? '') : null
}

const path = (src: string) => new URL(src, 'http://x').pathname

export async function checkForUpdate(fetcher: typeof fetch = fetch, mine: string | null = ownEntry()): Promise<boolean> {
  if (!mine || updateStore.get()) return updateStore.get()
  try {
    const r = await fetcher('/', { cache: 'no-store', credentials: 'same-origin' })
    if (!r.ok) return false
    const theirs = entryOf(await r.text())
    if (theirs && path(theirs) !== mine) updateStore.set(true)
  } catch {
    /* offline or restarting: the next check will tell */
  }
  return updateStore.get()
}

let started = false
export function watchForUpdates(): void {
  if (started) return
  started = true
  let wasOpen = false
  live.status.subscribe(() => {
    const s = live.status.get()
    if (s === 'open' && wasOpen) void checkForUpdate()
    if (s === 'open') wasOpen = true
  })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void checkForUpdate()
  })
  setInterval(() => void checkForUpdate(), 10 * 60_000)
}
