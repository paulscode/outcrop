import { useQuery } from '@tanstack/react-query'
import { MessagesSquare, RotateCw, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/menu'
import { Empty, Panel, Skeleton } from '@/components/ui/misc'
import { getOptional } from '@/lib/api'

/**
 * Where Strata's own chat page can be opened through the console.  The backend hands out a short-lived, session-bound
 * view (`GET /api/strata-view` -> {url: "/strata/<key>/"}); an older backend proxies it at `/strata/`.  Null: not available.
 * It is shown only framed, in a sandbox: never as a page of its own, where its scripts would be top-level.
 */
async function strataView(): Promise<string | null> {
  const v = await getOptional<{ url: string }>('/api/strata-view')
  if (v?.url && v.url.startsWith('/')) return v.url
  try {
    const r = await fetch('/strata/', { method: 'GET', credentials: 'same-origin', cache: 'no-store' })
    const ct = r.headers.get('content-type') ?? ''
    // the console answers unknown paths with its own index.html (it loads /theme.js): that is not Strata's page
    if (r.ok && ct.includes('text/html')) {
      const text = await r.text()
      if (!text.includes('/theme.js')) return '/strata/'
    }
  } catch {
    /* not available */
  }
  return null
}

export default function StrataChat() {
  const q = useQuery({ queryKey: ['strata-view'], queryFn: strataView, staleTime: 6 * 3600_000, refetchOnWindowFocus: false })
  const [nonce, setNonce] = useState(0)

  return (
    <div className="flex h-[calc(100dvh-10.5rem)] min-h-[520px] flex-col gap-3 md:h-[calc(100dvh-7.5rem)]">
      <Panel className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <MessagesSquare className="mt-0.5 size-4 shrink-0 text-faint" aria-hidden />
          <div className="min-w-0 text-[13px] leading-relaxed">
            <p className="font-medium text-fg">Strata’s own chat page</p>
            <p className="text-muted">
              The engine’s built-in chat, for a quick question without an app.
              {q.data ? ' Served through the console, so it needs no token. ' : ' '}
              {q.data ? (
              <Tip content="The page runs in a sandbox with an opaque origin: its scripts cannot read the console's cookie or call the console's API. The view's link works for 12 hours and only while you are signed in.">
                <span className="inline-flex cursor-help items-center gap-1 text-faint underline decoration-dotted underline-offset-2">
                  <ShieldCheck className="size-3" aria-hidden /> Sandboxed
                </span>
              </Tip>
              ) : null}
            </p>
          </div>
        </div>
        {q.data ? (
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={() => setNonce((n) => n + 1)} aria-label="Reload the chat page">
              <RotateCw /> Reload
            </Button>
          </div>
        ) : null}
      </Panel>

      {q.isPending ? (
        <Panel className="flex-1 p-4" aria-busy="true" aria-label="Loading Strata's page">
          <Skeleton className="h-full min-h-[400px] w-full" />
        </Panel>
      ) : q.data ? (
        <Panel className="flex-1 overflow-hidden p-0">
          <iframe
            key={nonce}
            src={q.data}
            title="Strata chat"
            className="block h-full min-h-[400px] w-full rounded-xl bg-sunken"
            sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads"
            referrerPolicy="no-referrer"
            data-testid="strata-frame"
          />
        </Panel>
      ) : (
        <Panel className="flex flex-1 items-center justify-center">
          <Empty icon={<MessagesSquare />} title="Strata’s page is not available through this console">
            <p>This console version is too old to show the engine’s chat page: update the console.</p>
          </Empty>
        </Panel>
      )}
    </div>
  )
}
