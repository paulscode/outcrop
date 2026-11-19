import { CheckCircle2, Circle, Loader2, Rocket, X, XCircle } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { cancelWaitingSwitch } from '@/lib/actions'
import { dur, fixed, gib, pct } from '@/lib/format'
import { gatewayStore, riverStore, switchStore } from '@/lib/live'
import { qk, queryClient } from '@/lib/queries'
import { inflightList } from '@/lib/requests'
import { useStore } from '@/lib/store'
import { PHASE_HELP, switchProgress, type PhaseRow } from '@/lib/switching'
import type { SwitchState } from '@/lib/types'
import { cn, useNow, useReducedMotion } from '@/lib/utils'
import { Button } from '../ui/button'
import { Badge, LiveRegion } from '../ui/misc'
import { Tip } from '../ui/menu'
import { Bar, Ring } from '../viz/basic'

function PhaseIcon({ status }: { status: PhaseRow['status'] }) {
  if (status === 'done') return <CheckCircle2 className="size-4 text-ok" aria-label="done" />
  if (status === 'current') return <Loader2 className="size-4 animate-spin text-warn" aria-label="in progress" />
  if (status === 'failed') return <XCircle className="size-4 text-error" aria-label="failed" />
  return <Circle className="size-4 text-line-strong" aria-label="to do" />
}

/** The held requests: they wait at the gateway and the new preset answers them. */
function HeldRequests({ now }: { now: number }) {
  const river = useStore(riverStore)
  const gwWaiting = useStore(gatewayStore, (g) => g?.hold?.waiting ?? 0)
  const held = inflightList(river).filter((f) => f.phase === 'held')
  const n = Math.max(held.length, gwWaiting)
  if (!n) return <p className="text-xs text-faint">No requests are waiting. New ones wait at the gateway until it is ready.</p>
  return (
    <div className="grid gap-1.5">
      <p className="text-xs text-muted">
        <span className="num font-medium text-warn">{n}</span> {n === 1 ? 'request is' : 'requests are'} waiting at the gateway; the new
        preset answers {n === 1 ? 'it' : 'them'}.
      </p>
      <div className="flex flex-wrap gap-1.5">
        {held.map((f) => (
          <Badge key={f.rid} tone="warn">
            {f.app ?? 'unknown'} <span className="num opacity-80">{Math.round(now - f.started_at)} s</span>
          </Badge>
        ))}
      </div>
    </div>
  )
}

/**
 * A preset switch, phase by phase: the real phases from the journal and the engine, the expert load growing toward its
 * arena, the time against the estimate, and the requests held for it.
 */
export function LaunchSequence({ sw, onDismiss }: { sw: SwitchState; onDismiss?: () => void }) {
  const now = useNow(500)
  const reduced = useReducedMotion()
  const p = switchProgress(sw, now)
  const running = sw.status === 'running' || sw.status === 'waiting'
  const [announce, setAnnounce] = useState('')
  const lastKey = useRef<string | null>(null)
  useEffect(() => {
    if (p.currentKey && p.currentKey !== lastKey.current) {
      lastKey.current = p.currentKey
      setAnnounce(`${p.currentLabel}`)
    }
    if (p.done) setAnnounce(p.ok ? `${sw.to} is ready` : `Switching to ${sw.to} failed`)
  }, [p.currentKey, p.currentLabel, p.done, p.ok, sw.to])

  const title = p.done
    ? p.ok
      ? sw.restart
        ? `${sw.to} restarted`
        : `Switched to ${sw.to}`
      : sw.status === 'cancelled'
        ? `The switch to ${sw.to} was cancelled`
        : `Switching to ${sw.to} failed`
    : sw.status === 'waiting'
      ? `Switching to ${sw.to} when no request is running`
      : sw.restart
        ? `Restarting ${sw.to}`
        : `Switching to ${sw.to}`
  const tone = p.done ? (p.ok ? 'var(--ok)' : 'var(--error)') : 'var(--warn)'
  const plan = p.plan

  return (
    <section
      className={cn('panel overflow-hidden', p.done && !p.ok && 'border-error/40')}
      aria-labelledby="launch-title"
      data-testid="launch-sequence"
    >
      <LiveRegion message={announce} />
      <div className="relative">
        <div className="pointer-events-none absolute -left-20 -top-24 size-72 rounded-full opacity-[0.12] blur-3xl" style={{ background: tone }} aria-hidden />
        <header className="relative flex flex-wrap items-center gap-4 border-b border-line p-5">
          <Ring fraction={p.fraction} size={52} stroke={4} color={tone} label={`${Math.round(p.fraction * 100)}% done`}>
            {p.done ? (
              p.ok ? (
                <CheckCircle2 className="size-5 text-ok" aria-hidden />
              ) : (
                <XCircle className="size-5 text-error" aria-hidden />
              )
            ) : (
              <Rocket className="size-4 text-warn" aria-hidden />
            )}
          </Ring>
          <div className="min-w-0 flex-1">
            <h2 id="launch-title" className="text-[15px] font-semibold tracking-tight" data-testid="launch-title">
              {title}
            </h2>
            <p className="num mt-0.5 text-[13px] text-muted">
              {p.done ? (
                <>
                  took {dur(p.total ?? p.elapsed, { precise: true })}
                  {sw.from && !sw.restart ? ` · from ${sw.from}` : ''}
                </>
              ) : (
                <>
                  {dur(p.elapsed, { precise: true })}
                  {p.estimate ? ` of about ${dur(p.estimate)}` : ''}
                  {sw.from && !sw.restart ? ` · from ${sw.from}` : ''} · started by {sw.by}
                </>
              )}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {sw.status === 'waiting' ? (
              <Button variant="outline" size="sm" onClick={() => cancelWaitingSwitch()}>
                Cancel the switch
              </Button>
            ) : null}
            {p.done && onDismiss ? (
              <Button variant="ghost" size="icon-sm" onClick={onDismiss} aria-label="Dismiss">
                <X />
              </Button>
            ) : null}
          </div>
        </header>
      </div>
      <div className="grid gap-0 lg:grid-cols-[1fr_300px]">
        <ol className="grid gap-0.5 p-3 sm:p-4" aria-label="Phases">
          <AnimatePresence initial={false}>
            {p.phases.map((ph) => (
              <motion.li
                key={ph.key}
                layout={!reduced}
                initial={reduced ? false : { opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
                className={cn(
                  'grid grid-cols-[20px_1fr_auto] items-start gap-x-3 rounded-lg px-2.5 py-2',
                  ph.status === 'current' && 'bg-warn-bg',
                  ph.status === 'failed' && 'bg-error-bg',
                )}
                aria-current={ph.status === 'current' ? 'step' : undefined}
              >
                <span className="mt-0.5">
                  <PhaseIcon status={ph.status} />
                </span>
                <div className="min-w-0">
                  <Tip content={PHASE_HELP[ph.key]}>
                    <span className={cn('text-[13px]', ph.status === 'pending' ? 'text-faint' : 'text-fg', ph.status === 'current' && 'font-medium')}>
                      {ph.label}
                    </span>
                  </Tip>
                  {ph.detail ? <span className="num ml-2 text-xs text-faint">{ph.detail}</span> : null}
                  {ph.key === 'experts' && ph.status === 'current' ? (
                    <div className="mt-2 grid gap-1">
                      <Bar value={p.expertFraction ?? 0} indeterminate={p.expertFraction === null} color="var(--layer-1)" height={8} label="experts loaded into RAM" />
                      <span className="num text-xs text-muted" data-testid="expert-progress">
                        {p.expert ?? 'reading the experts…'}
                      </span>
                    </div>
                  ) : null}
                  {ph.key === 'drain' && p.drainLeft ? <span className="num ml-2 text-xs text-warn">{p.drainLeft} still running</span> : null}
                </div>
                <span className="num pt-0.5 text-xs text-faint">
                  {ph.seconds !== undefined ? (ph.status === 'current' ? dur(ph.seconds) : `${fixed(ph.seconds, 1)} s`) : ''}
                </span>
              </motion.li>
            ))}
          </AnimatePresence>
          {p.error ? (
            <li className="mt-2 whitespace-pre-wrap rounded-lg border border-error/30 bg-error-bg p-3 font-mono text-xs text-fg" role="alert">
              {p.error}
            </li>
          ) : null}
        </ol>
        <aside className="grid content-start gap-4 border-t border-line p-4 text-[13px] lg:border-l lg:border-t-0">
          <div>
            <div className="eyebrow mb-1.5">The plan</div>
            {plan ? (
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                <dt className="text-faint">Pack in page cache</dt>
                <dd className="num text-right">
                  {plan.warm !== null && plan.warm !== undefined ? `${pct(plan.warm)} (${plan.warm > 0.8 ? 'warm' : plan.warm > 0.3 ? 'partly warm' : 'cold'})` : '—'}
                </dd>
                <dt className="text-faint">RAM needed</dt>
                <dd className={cn('num text-right', plan.low_ram && 'text-warn')}>{plan.ram_need_gib ? gib(plan.ram_need_gib, 0) : '—'}</dd>
                <dt className="text-faint">RAM available</dt>
                <dd className="num text-right">{plan.ram_avail_gib ? gib(plan.ram_avail_gib, 0) : '—'}</dd>
                <dt className="text-faint">Estimate</dt>
                <dd className="num text-right">{plan.estimate_s ? `about ${dur(plan.estimate_s)}` : '—'}</dd>
              </dl>
            ) : (
              <p className="text-xs text-faint">{sw.status === 'waiting' ? 'Waiting for the running request to finish.' : 'Planning…'}</p>
            )}
            {plan?.low_ram ? (
              <p className="mt-2 text-xs text-warn">Less RAM is free than this preset pins; it starts in low-RAM mode and runs slower.</p>
            ) : null}
            {p.loaded ? (
              <p className="num mt-2 text-xs text-muted">
                Experts loaded: {gib(Number(p.loaded.gib))}
                {p.loaded.rate ? ` at ${Number(p.loaded.rate).toFixed(1)} GiB/s` : ''}
              </p>
            ) : null}
          </div>
          <div>
            <div className="eyebrow mb-1.5">Waiting requests</div>
            {running || !p.done ? <HeldRequests now={now} /> : <p className="text-xs text-muted">Held requests were released to {sw.to}.</p>}
          </div>
        </aside>
      </div>
      <div className="h-1 w-full bg-line" aria-hidden>
        <div className="h-full transition-[width] duration-700 ease-out" style={{ width: `${Math.round(p.fraction * 100)}%`, background: tone }} />
      </div>
    </section>
  )
}

/** The current switch from the live topic; refreshes the cards when it ends. */
export function useSwitch(initial: SwitchState | null | undefined) {
  const live = useStore(switchStore)
  const sw = live ?? initial ?? null
  const status = sw?.status
  useEffect(() => {
    if (status === 'done' || status === 'failed' || status === 'cancelled') {
      void queryClient.invalidateQueries({ queryKey: qk.presets })
      void queryClient.invalidateQueries({ queryKey: qk.state })
      void queryClient.invalidateQueries({ queryKey: qk.switches })
    }
  }, [status])
  return sw
}
