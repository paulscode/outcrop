import { Ban, CheckCircle2, Waves, XCircle } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useState } from 'react'
import { River } from '@/components/live/River'
import { RequestDrawer } from '@/components/requests/RequestDrawer'
import { Button } from '@/components/ui/button'
import { Badge, Empty, LiveRegion, Panel, PanelHeader } from '@/components/ui/misc'
import { Popover, PopoverClose, PopoverContent, PopoverTrigger, Tip } from '@/components/ui/menu'
import { Bar } from '@/components/viz/basic'
import { cancelRequest } from '@/lib/actions'
import { monogram } from '@/lib/apps'
import { flightWords, shortPath, toneText, toneVar } from '@/lib/engine'
import { compact, dur, fixed, int, isNum, pct, time } from '@/lib/format'
import { metricsStore, riverStore, seedRiver } from '@/lib/live'
import { PHASE_COLOR, PHASE_LABEL, type PhaseKey } from '@/lib/phases'
import { usePrefill } from '@/lib/progress'
import { activeRid, decodeRate, finished, firstToken, inflightList, isOk, liveRate, outcomeText } from '@/lib/requests'
import { useStore } from '@/lib/store'
import type { Flight } from '@/lib/types'
import { cn, useNow, useReducedMotion } from '@/lib/utils'

function CancelButton({ f }: { f: Flight }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon-xs" aria-label={`Cancel the request from ${f.app}`} className="hover:text-error">
          <Ban />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64">
        <p className="text-[13px] font-medium">Cancel this request?</p>
        <p className="mt-1 text-xs text-muted">{f.app} gets an error saying the administrator cancelled it.</p>
        <div className="mt-3 flex justify-end gap-2">
          <PopoverClose asChild>
            <Button size="sm" variant="ghost">
              Keep it
            </Button>
          </PopoverClose>
          <PopoverClose asChild>
            <Button size="sm" variant="danger" onClick={() => cancelRequest(f.rid)}>
              Cancel it
            </Button>
          </PopoverClose>
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** One in-flight request: who sent it, what is happening, how far along, and a way to stop it. */
function Lane({ f, active, now, onOpen }: { f: Flight; active: boolean; now: number; onOpen: () => void }) {
  const prefill = usePrefill()
  const reading = active && prefill.reading && !f.first_token_at
  const w = flightWords(f, reading)
  const rate = liveRate(f, now)
  const queuedFor = now - f.started_at
  return (
    <div className={cn('relative grid gap-2 rounded-xl border bg-panel p-3.5 sm:p-4', active ? 'border-line-strong' : 'border-line')} data-testid="lane">
      <div className="absolute inset-y-3 left-0 w-0.5 rounded-full" style={{ backgroundColor: toneVar[w.tone] }} aria-hidden />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="num flex size-8 shrink-0 items-center justify-center rounded-lg border border-line-strong bg-panel-3 text-xs font-semibold">
          {monogram(f.app)}
        </span>
        <button type="button" onClick={onOpen} className="min-w-0 text-left">
          <span className="block text-[14px] font-medium hover:underline">{f.app ?? 'unknown'}</span>
          <span className="num block text-xs text-faint">
            {f.client_ip} · {shortPath(f.path)}
          </span>
        </button>
        {f.token ? <Badge>{f.token}</Badge> : <Badge tone="warn">{f.auth === 'open' ? 'open mode' : 'no token'}</Badge>}
        <div className="ml-auto flex items-center gap-3">
          <span className={cn('inline-flex items-center gap-1.5 text-[13px] font-medium', toneText[w.tone])} data-testid="lane-phase">
            <span className={cn('size-2 rounded-full', w.key !== 'waiting' && 'animate-pulse')} style={{ backgroundColor: toneVar[w.tone] }} aria-hidden />
            {w.key === 'waiting' ? `waiting ${dur(queuedFor)}` : w.key === 'held' ? `held ${dur(queuedFor)}` : w.label}
          </span>
          <CancelButton f={f} />
        </div>
      </div>
      {reading ? (
        <div className="grid gap-1.5 sm:pl-11">
          <Bar value={prefill.fraction ?? 0} indeterminate={!isNum(prefill.fraction)} color="var(--read)" height={8} label="prompt read" />
          <div className="num flex flex-wrap gap-x-3 text-xs text-muted">
            {isNum(prefill.fraction) ? <span className="text-fg">{Math.round(prefill.fraction * 100)}%</span> : null}
            {isNum(prefill.total) ? (
              <span>
                {int(prefill.read)} of {int(prefill.total)}
              </span>
            ) : null}
            {prefill.speed ? <span>{fixed(prefill.speed, 0)} tok/s</span> : null}
            {isNum(prefill.left) ? (
              <span>
                {prefill.estimated ? 'about ' : ''}
                {dur(prefill.left)} left
              </span>
            ) : null}
          </div>
        </div>
      ) : w.key === 'thinking' || w.key === 'answering' ? (
        <div className="num flex flex-wrap gap-x-4 text-xs text-muted sm:pl-11">
          <span>
            <span className="text-fg">{int(f.tokens)}</span> tokens{f.think_tokens ? ` (${int(f.think_tokens)} thinking)` : ''}
          </span>
          <span className={toneText[w.tone]}>{rate ? `${fixed(rate, 1)} tok/s` : '—'}</span>
          {firstToken(f) !== null ? <span>first token {dur(firstToken(f))}</span> : null}
        </div>
      ) : w.key === 'held' ? (
        <p className="text-xs text-muted sm:pl-11">{f.held_reason || 'waiting at the gateway for the preset switch'}; the new preset answers it.</p>
      ) : (
        <p className="text-xs text-muted sm:pl-11">Behind the request in progress: the server answers one at a time.</p>
      )}
    </div>
  )
}

function FinishedRow({ f, now, onOpen }: { f: Flight; now: number; onOpen: () => void }) {
  const ok = isOk(f)
  return (
    <li>
      <button type="button" onClick={onOpen} className="grid w-full grid-cols-[18px_4.5rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 px-4 py-2 text-left text-[13px] hover:bg-panel-2/50 md:grid-cols-[18px_4.5rem_minmax(8rem,12rem)_minmax(0,1fr)_repeat(4,5.5rem)]">
        {ok ? <CheckCircle2 className="size-4 text-ok" aria-label="done" /> : <XCircle className="size-4 text-error" aria-label="failed or refused" />}
        <span className="num text-xs text-faint">{time(f.ended_at ?? f.started_at)}</span>
        <span className="min-w-0 truncate">
          <span className="font-medium">{f.app ?? 'unknown'}</span> <span className="text-faint">{f.token ?? (f.denied ? '' : f.auth === 'open' ? '(open)' : '')}</span>
        </span>
        {f.denied ? (
          <span className="num col-span-1 truncate text-xs text-error md:col-span-5">
            {f.status} {outcomeText(f)} from {f.client_ip}
          </span>
        ) : (
          <>
            <span className="num hidden truncate text-xs text-muted md:block">
              {compact(f.prompt_tokens)} in · {compact(f.output_tokens)} out{!ok ? ` · ${outcomeText(f)}` : ''}
            </span>
            <span className="num hidden text-right text-xs md:block" title="first token">
              {firstToken(f) !== null ? dur(firstToken(f)) : '—'}
            </span>
            <span className="num hidden text-right text-xs md:block" title="answer speed">
              {decodeRate(f) ? `${fixed(decodeRate(f), 1)}/s` : '—'}
            </span>
            <span className="num hidden text-right text-xs md:block" title="experts in VRAM">
              {pct(f.hit_rate)}
            </span>
            <span className="num text-right text-xs text-faint">{dur((f.ended_at ?? now) - f.started_at)}</span>
          </>
        )}
      </button>
    </li>
  )
}

export default function Live() {
  const river = useStore(riverStore)
  const engine = useStore(metricsStore, (m) => m.latest?.engine ?? null)
  const now = useNow(1000)
  const reduced = useReducedMotion()
  const [open, setOpen] = useState<Flight | null>(null)
  const [more, setMore] = useState(false)
  useEffect(() => {
    void seedRiver(more ? 200 : 50)
  }, [more])
  const rid = activeRid(river)
  const lanes = inflightList(river)
  const ordered = rid ? [lanes.find((l) => l.rid === rid)!, ...lanes.filter((l) => l.rid !== rid)] : lanes
  const done = finished(river, more ? 200 : 25)
  const working = ordered.filter((f) => f.phase === 'thinking' || f.phase === 'answering' || f.rid === rid).length
  const waiting = ordered.length - working
  const summary = `${working} ${engine?.state === 'reading' ? 'reading' : 'answering'} · ${waiting} waiting`

  return (
    <div className="grid gap-4">
      <LiveRegion message={summary} />
      <Panel className="overflow-hidden">
        <PanelHeader
          icon={<Waves />}
          title="River"
          meta="the last five minutes; click a band for its request"
          actions={
            <ul className="hidden items-center gap-3 text-[11px] text-muted lg:flex">
              {(['waiting', 'reading', 'thinking', 'answering', 'held'] as PhaseKey[]).map((k) => (
                <li key={k} className="flex items-center gap-1.5">
                  <span className="size-2 rounded-full" style={{ backgroundColor: PHASE_COLOR[k], opacity: k === 'waiting' ? 0.5 : 1 }} aria-hidden />
                  {PHASE_LABEL[k]}
                </li>
              ))}
              <li className="flex items-center gap-1.5">
                <span className="size-2 rotate-45 bg-error" aria-hidden /> refused
              </li>
            </ul>
          }
        />
        <div className="px-4 pb-2 pt-3">
          <River onPick={setOpen} />
        </div>
      </Panel>

      <section aria-labelledby="inflight-title" className="grid gap-2.5">
        <div className="flex items-baseline justify-between">
          <h2 id="inflight-title" className="text-[13px] font-semibold">
            In flight
          </h2>
          <span className="num text-xs text-muted" data-testid="live-summary">
            {summary}
          </span>
        </div>
        {ordered.length ? (
          <div className="grid gap-2.5">
            <AnimatePresence initial={false}>
              {ordered.map((f) => (
                <motion.div
                  key={f.rid}
                  layout={!reduced}
                  initial={reduced ? false : { opacity: 0, x: -24 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={reduced ? { opacity: 0 } : { opacity: 0, x: 48, transition: { duration: 0.25 } }}
                  transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
                >
                  <Lane f={f} active={f.rid === rid} now={now} onOpen={() => setOpen(f)} />
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        ) : (
          <Panel>
            <Empty title="Nothing in flight">New requests appear here as they arrive, with their progress.</Empty>
          </Panel>
        )}
      </section>

      <Panel className="overflow-hidden">
        <PanelHeader
          title="Finished"
          meta="the newest first"
          actions={
            <span className="hidden gap-[3.6rem] pr-6 text-[11px] text-faint md:flex">
              <Tip content="time to the first token">
                <span>first token</span>
              </Tip>
              <span>speed</span>
              <Tip content="experts already in VRAM (the expert-cache hit rate)">
                <span>in VRAM</span>
              </Tip>
              <span>took</span>
            </span>
          }
        />
        {done.length ? (
          <>
            <ul className="divide-y divide-line">
              {done.map((f) => (
                <FinishedRow key={`${f.rid}-${f.denied ? 'd' : 'r'}`} f={f} now={now} onOpen={() => setOpen(f)} />
              ))}
            </ul>
            {!more && finished(river, 200).length > done.length ? (
              <div className="border-t border-line p-2 text-center">
                <Button variant="ghost" size="sm" onClick={() => setMore(true)}>
                  Show more
                </Button>
              </div>
            ) : null}
          </>
        ) : (
          <Empty title="No finished requests yet" />
        )}
      </Panel>
      <RequestDrawer rid={open?.rid ?? null} fallback={open} onClose={() => setOpen(null)} />
    </div>
  )
}
