import { Link, useRouterState } from '@tanstack/react-router'
import { AlertTriangle, ArrowRight, Loader2, RefreshCw, ShieldOff, WifiOff } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { closeApi } from '@/lib/actions'
import { clock, dur, hm } from '@/lib/format'
import { gatewayStore, switchStore, useConnStatus } from '@/lib/live'
import { useServerState } from '@/lib/queries'
import { useStore } from '@/lib/store'
import { cn, useNow } from '@/lib/utils'
import { Button } from '../ui/button'
import { LiveRegion } from '../ui/misc'
import { Ring } from '../viz/basic'
import { switchProgress } from '@/lib/switching'
import { updateStore } from '@/lib/version'

/** The API's auth mode, from the gateway's live state (falls back to /api/state). */
export function useAuthMode() {
  const { data: st } = useServerState()
  const gw = useStore(gatewayStore)
  const now = useNow(1000)
  const g = gw?.auth
  const mode = g?.mode ?? st?.auth.mode ?? 'enforced'
  const until = (g?.until ?? st?.auth.until) || null
  const open = mode === 'open' && !!until && until > now
  const addresses = (g?.addresses ?? st?.auth.addresses ?? []) as string[]
  const listeners = (g?.listeners ?? st?.auth.listeners ?? []) as string[]
  // the window's start is not in the live state; the setting has it (access page) - estimate from the first time seen
  return { open, until, left: until ? until - now : 0, addresses, listeners, now }
}

const openedAt = new Map<number, number>()
export function windowFraction(until: number | null, now: number, at?: number): number {
  if (!until) return 0
  let start = at
  if (!start) {
    if (!openedAt.has(until)) openedAt.set(until, now)
    start = openedAt.get(until)!
  }
  const total = Math.max(60, until - start)
  return Math.max(0, Math.min(1, (until - now) / total))
}

function scopeText(addresses: string[], listeners: string[]) {
  const who = addresses.length ? `only ${addresses.join(', ')}` : 'the whole LAN'
  const where =
    !listeners.length || (listeners.includes('openai') && listeners.includes('ollama'))
      ? 'both ports'
      : listeners.includes('ollama')
        ? 'the Ollama port only'
        : 'the OpenAI/Anthropic port only'
  return `${who}, ${where}`
}

/** The amber "API open" banner, on every page while the API accepts requests without a token. */
export function AuthBanner() {
  const { open, until, left, addresses, listeners, now } = useAuthMode()
  const [busy, setBusy] = useState(false)
  const prev = useRef(open)
  const [announce, setAnnounce] = useState('')
  useEffect(() => {
    if (prev.current !== open) {
      setAnnounce(open ? `The API is open until ${hm(until)}` : 'The API is closed: tokens are required again')
      prev.current = open
    }
  }, [open, until])
  return (
    <>
      <LiveRegion message={announce} />
      <div
        className={cn('grid transition-[grid-template-rows,opacity] duration-300 ease-out', open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0')}
        aria-hidden={!open}
      >
        <div className="overflow-hidden">
        {open ? (
            <div
              className="flex items-center gap-3 border-b border-warn/30 bg-warn-bg px-4 py-2 text-[13px] sm:px-6"
              data-testid="auth-banner"
            >
              <Ring fraction={windowFraction(until, now)} size={26} stroke={3} label="time left in the open window">
                <ShieldOff className="size-3 text-warn" aria-hidden />
              </Ring>
              <div className="min-w-0 flex-1 leading-snug">
                <span className="font-semibold text-warn">The API is open.</span>{' '}
                <span className="text-fg">
                  Requests without a token are allowed until <span className="num">{hm(until)}</span>
                </span>
                <span className="hidden text-muted md:inline"> · {scopeText(addresses, listeners)}</span>
              </div>
              <span className="num shrink-0 text-[13px] font-medium text-warn" data-testid="auth-countdown" aria-label={`${dur(left)} left`}>
                {clock(left)}
              </span>
              <Button
                size="sm"
                variant="warn"
                loading={busy}
                onClick={async () => {
                  setBusy(true)
                  await closeApi()
                  setBusy(false)
                }}
              >
                Close now
              </Button>
            </div>
        ) : null}
        </div>
      </div>
    </>
  )
}

/** A slim strip on every page (but Presets) while a preset switch runs. */
export function SwitchStrip() {
  const sw = useStore(switchStore)
  const path = useRouterState({ select: (s) => s.location.pathname })
  const now = useNow(1000)
  const active = sw && (sw.status === 'running' || sw.status === 'waiting')
  if (!active || path.startsWith('/presets')) return null
  const p = switchProgress(sw, now)
  return (
    <div className="flex items-center gap-3 border-b border-line bg-panel px-4 py-2 text-[13px] sm:px-6" role="status">
      <Loader2 className="size-4 shrink-0 animate-spin text-warn" aria-hidden />
      <div className="min-w-0 flex-1 truncate">
        <span className="font-medium">{sw.restart ? `Restarting ${sw.to}` : `Switching to ${sw.to}`}</span>
        <span className="text-muted"> · {sw.status === 'waiting' ? 'waiting until no request is running' : p.currentLabel}</span>
        {p.expert ? <span className="num text-muted"> · {p.expert}</span> : null}
      </div>
      <span className="num hidden text-faint sm:inline">{dur(p.elapsed)}{p.estimate ? ` of about ${dur(p.estimate)}` : ''}</span>
      <div className="hidden w-32 sm:block">
        <div className="h-1.5 overflow-hidden rounded-full bg-line">
          <div className="h-full rounded-full bg-warn transition-[width] duration-700" style={{ width: `${Math.round(p.fraction * 100)}%` }} />
        </div>
      </div>
      <Link to="/presets" className="inline-flex items-center gap-1 text-xs font-medium text-fg hover:underline">
        View <ArrowRight className="size-3" aria-hidden />
      </Link>
    </div>
  )
}

/** Shown when the live connection drops. */
/** After a deploy: this tab still runs the old UI. */
export function UpdateNotice() {
  const update = useStore(updateStore)
  if (!update) return null
  return (
    <div className="flex items-center gap-3 border-b border-line bg-panel px-4 py-2 text-[13px] sm:px-6" role="status">
      <RefreshCw className="size-4 shrink-0 text-info" aria-hidden />
      <div className="min-w-0 flex-1 leading-snug">
        <span className="font-medium">A new version of Outcrop is on the server.</span>{' '}
        <span className="text-muted">This tab is still running the old one until it is reloaded.</span>
      </div>
      <Button size="xs" variant="secondary" onClick={() => location.reload()}>
        Reload
      </Button>
    </div>
  )
}

export function ConnectionNotice() {
  const st = useConnStatus()
  const [show, setShow] = useState(false)
  useEffect(() => {
    if (st === 'reconnecting') {
      const id = setTimeout(() => setShow(true), 2500)
      return () => clearTimeout(id)
    }
    setShow(false)
  }, [st])
  if (!show) return null
  return (
    <div
      className={cn(
        'fixed bottom-20 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-full border border-line-strong bg-panel-3 px-4 py-2 text-[13px] shadow-xl md:bottom-6',
      )}
      role="status"
    >
      <WifiOff className="size-4 text-warn" aria-hidden />
      Reconnecting to the console… the numbers on screen are paused.
    </div>
  )
}

export function GatewayDownNotice() {
  const gw = useStore(gatewayStore)
  if (!gw || gw.up !== false) return null
  return (
    <div className="flex items-center gap-2 border-b border-error/30 bg-error-bg px-4 py-2 text-[13px] sm:px-6" role="alert">
      <AlertTriangle className="size-4 text-error" aria-hidden />
      <span>
        <span className="font-semibold text-error">The API gateway is not answering.</span>{' '}
        <span className="text-muted">Apps cannot reach the model. Check it with</span>{' '}
        <code className="rounded bg-panel-2 px-1 text-xs">outcrop gateway status</code>
      </span>
    </div>
  )
}
