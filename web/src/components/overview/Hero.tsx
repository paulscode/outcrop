import { Link } from '@tanstack/react-router'
import { ArrowUpRight, Layers, ShieldOff } from 'lucide-react'
import { useMemo, useState } from 'react'
import { switchPreset } from '@/lib/actions'
import { engineWords, toneText, toneVar, type Meaning } from '@/lib/engine'
import { compact, ctx, dur, fixed, int, isNum, pct, tps } from '@/lib/format'
import { engineStore, metricsStore, riverStore, switchStore, useConnStatus } from '@/lib/live'
import { usePrefill } from '@/lib/progress'
import { phaseRates } from '@/lib/rates'
import { usePresets, useServerState } from '@/lib/queries'
import { activeRid, decodeRate, firstToken, inflightList, isGenerating, liveRate } from '@/lib/requests'
import { useStore } from '@/lib/store'
import { switchProgress } from '@/lib/switching'
import { cn, useNow } from '@/lib/utils'
import { Button } from '../ui/button'
import { Dialog, DialogDescription, DialogTitle, SheetContent } from '../ui/dialog'
import { Badge, LiveRegion } from '../ui/misc'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/menu'
import { Bar, Sparkline, Ticker } from '../viz/basic'
import { OpenChoices } from '../shell/AuthPill'
import { useAuthMode } from '../shell/Banners'
import { closeApi } from '@/lib/actions'

function StateGlyph({ tone, active, breathing }: { tone: Meaning; active: boolean; breathing: boolean }) {
  return (
    <span className="relative inline-flex size-3 items-center justify-center" aria-hidden>
      {active ? <span className="animate-pulse-ring absolute inset-0 rounded-full" style={{ background: toneVar[tone] }} /> : null}
      <span
        className={cn('relative size-3 rounded-full', breathing && 'animate-breathe')}
        style={{ background: toneVar[tone], boxShadow: `0 0 18px ${toneVar[tone]}` }}
      />
    </span>
  )
}

/** The phone's quick actions: switching presets and opening/closing the API, each in two taps. */
function QuickActions() {
  const { data } = usePresets()
  const [sheet, setSheet] = useState(false)
  const { open } = useAuthMode()
  const [o, setO] = useState(false)
  return (
    <div className="mt-4 grid grid-cols-2 gap-2 md:hidden">
      <Button variant="secondary" onClick={() => setSheet(true)}>
        <Layers /> Switch
      </Button>
      {open ? (
        <Button variant="warn" onClick={() => closeApi()}>
          Close the API
        </Button>
      ) : (
        <Popover open={o} onOpenChange={setO}>
          <PopoverTrigger asChild>
            <Button variant="warn-outline">
              <ShieldOff /> Open API
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-[min(320px,calc(100vw-1.5rem))]">
            <p className="mb-2 text-[13px] font-medium">Open the API without tokens for</p>
            <OpenChoices onDone={() => setO(false)} />
          </PopoverContent>
        </Popover>
      )}
      <Dialog open={sheet} onOpenChange={setSheet}>
        <SheetContent side="bottom" className="p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <DialogTitle className="text-[15px] font-semibold">Switch preset</DialogTitle>
          <DialogDescription className="mt-1 text-xs text-muted">
            New requests wait at the gateway while it switches, and the new preset answers them.
          </DialogDescription>
          <ul className="mt-3 grid gap-1.5">
            {data?.presets.map((p) => (
              <li key={p.name}>
                <button
                  type="button"
                  disabled={p.running}
                  onClick={async () => {
                    setSheet(false)
                    await switchPreset(p.name)
                  }}
                  className="flex w-full items-center gap-3 rounded-lg border border-line-strong bg-panel-2 px-3 py-3 text-left disabled:opacity-60"
                >
                  <span className="text-[14px] font-semibold">{p.name}</span>
                  <span className="text-xs text-faint">
                    {p.pack.toUpperCase()} · {ctx(p.context)}
                  </span>
                  <span className="num ml-auto text-xs text-muted">{p.running ? 'running' : p.measured.chat ? tps(p.measured.chat.decode) : ''}</span>
                </button>
              </li>
            ))}
          </ul>
        </SheetContent>
      </Dialog>
    </div>
  )
}

/** "Now": what the engine is doing this second, in plain words, with the request it is doing it for. */
export function Hero() {
  const sample = useStore(metricsStore, (s) => s.latest)
  const history = useStore(metricsStore, (s) => s.history)
  const engine = useStore(engineStore)
  const river = useStore(riverStore)
  const sw = useStore(switchStore)
  const conn = useConnStatus()
  const { data: st } = useServerState()
  const { data: presets } = usePresets()
  const now = useNow(1000)
  const prefill = usePrefill()
  const switching = !!sw && (sw.status === 'running' || sw.status === 'waiting')
  const words = engineWords(sample?.engine, switching)
  // matched by name, so the quant always belongs to the preset named beside it (the two come from different queries)
  const preset = presets?.presets.find((p) => (st?.server.preset ? p.name === st.server.preset : p.running))
  const rid = activeRid(river)
  const active = rid ? river.inflight[rid] : null
  const waiting = inflightList(river).filter((f) => isGenerating(f) && f.rid !== rid)
  const last = river.recent.find((r) => !r.denied && (r.output_tokens ?? 0) > 0)

  // tokens/s while thinking and while answering, the last 5 minutes, on one scale (reading is left out: see lib/rates.ts)
  const rates = useMemo(() => phaseRates(history.slice(-300)), [history])
  const sparkMax = Math.max(10, ...[...rates.think, ...rates.answer].filter(isNum))

  const busy = words.key === 'reading' || words.key === 'thinking' || words.key === 'answering'
  const rate = sample?.engine.tok_s ?? engine?.live?.tok_s ?? (active ? liveRate(active, now) : null)
  const sp = switching && sw ? switchProgress(sw, now) : null

  let big: React.ReactNode
  let sub: React.ReactNode
  if (sp && sw) {
    big = <span className="text-warn">{Math.round(sp.fraction * 100)}%</span>
    sub = (
      <>
        {sw.restart ? 'Restarting' : 'Switching to'} <span className="font-medium text-fg">{sw.to}</span> · {sp.currentLabel}
        {sp.expert ? <span className="num"> · {sp.expert}</span> : null}
      </>
    )
  } else if (words.key === 'reading') {
    big = isNum(prefill.fraction) ? (
      <Ticker value={prefill.fraction * 100} format={(v) => `${Math.round(v)}%`} className="text-read" />
    ) : (
      <span className="text-read">{prefill.elapsed ? dur(prefill.elapsed) : '…'}</span>
    )
    sub = (
      <>
        {isNum(prefill.total) ? <span className="num">{int(prefill.read)} of {int(prefill.total)} tokens</span> : 'reading the prompt'}
        {prefill.speed ? <span className="num"> · {fixed(prefill.speed, 0)} tok/s</span> : null}
        {isNum(prefill.left) ? (
          <span className="num">
            {' '}
            · {prefill.estimated ? 'about ' : ''}
            {dur(prefill.left)} left
          </span>
        ) : null}
      </>
    )
  } else if (words.key === 'thinking' || words.key === 'answering') {
    big = (
      <>
        <Ticker value={rate} format={(v) => fixed(v, 1)} className={toneText[words.tone]} />
        <span className="ml-2 text-lg font-normal text-muted">tok/s</span>
      </>
    )
    sub = active ? (
      <span className="num">
        {int(active.tokens)} tokens{active.think_tokens ? ` · ${int(active.think_tokens)} thinking` : ''}
        {firstToken(active) ? ` · first token ${dur(firstToken(active))}` : ''}
      </span>
    ) : (
      'generating'
    )
  } else if (words.key === 'unloaded') {
    big = <span className="text-warn">Not loaded</span>
    sub = 'The model is not in memory. Start a preset on Presets.'
  } else {
    big = last ? (
      <>
        <span className="text-fg">{fixed(decodeRate(last), 1)}</span>
        <span className="ml-2 text-lg font-normal text-muted">tok/s</span>
      </>
    ) : (
      <span className="text-muted">Ready</span>
    )
    sub = last ? (
      <>
        the last answer, <span className="num">{last.ended_at ? dur(now - last.ended_at) : '—'}</span> ago · ready for
        requests
      </>
    ) : (
      'Ready for requests'
    )
  }

  return (
    <section className="panel relative h-full overflow-hidden" aria-labelledby="now-title">
      {/* the colour of what it is doing, as a soft wash behind the numbers */}
      <div
        className="pointer-events-none absolute -right-24 -top-28 size-80 rounded-full opacity-[0.13] blur-3xl transition-colors duration-700"
        style={{ background: toneVar[words.tone] }}
        aria-hidden
      />
      {/* announce what it is doing when that changes, not every number every second */}
      <LiveRegion message={`Now: ${words.label}${switching && sw ? ` to ${sw.to}` : ''}`} />
      <div className="relative p-5 sm:p-6">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <StateGlyph tone={words.tone} active={busy} breathing={!busy && conn === 'open'} />
          <h2 id="now-title" className={cn('text-xs font-semibold uppercase tracking-[0.14em]', toneText[words.tone])}>
            <span className="sr-only">Now: </span>
            {words.label}
          </h2>
          {words.term ? <span className="text-xs text-muted">({words.term})</span> : null}
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            {st?.server.preset ? (
              <Link to="/presets" className="inline-flex items-center gap-1 text-[13px] font-medium hover:underline">
                {st.server.preset}
              </Link>
            ) : (
              <Badge tone="warn">no preset running</Badge>
            )}
            {preset ? (
              <span className="num text-xs text-muted">
                {preset.pack.toUpperCase()} · {ctx(preset.context)}
              </span>
            ) : null}
          </div>
        </div>

        <div className="mt-4 grid items-end gap-5 sm:grid-cols-[1fr_auto]">
          <div className="min-w-0">
            <div className="num text-[44px] font-light leading-none tracking-tight sm:text-[56px]" aria-live="off">
              {big}
            </div>
            <p className="mt-2.5 min-h-5 text-[13px] text-muted">{sub}</p>
          </div>
          <div className="hidden sm:block">
            <div
              className="relative h-16 w-[260px] border-b border-line"
              role="img"
              aria-label="tokens per second for thinking and answering, the last 5 minutes"
            >
              {(['think', 'answer'] as const).map((k) => (
                <Sparkline key={k} values={rates[k]} width={260} height={64} max={sparkMax} color={toneVar[k]} className="absolute inset-0" />
              ))}
            </div>
            <div className="mt-1 flex items-center justify-between text-[10px] text-muted">
              <span>5 min</span>
              <span className="flex items-center gap-2">
                {(
                  [
                    ['think', 'thinking'],
                    ['answer', 'answering'],
                  ] as const
                ).map(([k, name]) => (
                  <span key={k} className="inline-flex items-center gap-1">
                    <span className="size-1.5 rounded-full" style={{ background: toneVar[k] }} aria-hidden />
                    {name}
                  </span>
                ))}
                <span>tok/s</span>
              </span>
              <span>now</span>
            </div>
          </div>
        </div>

        {/* The progress bar's slot is always there, empty when nothing is being read or switched, so the line below and
            everything under it stay put when a prompt starts and ends. */}
        <div className="mt-4 h-1.5">
          {words.key === 'reading' ? (
            <Bar value={prefill.fraction ?? 0} indeterminate={!isNum(prefill.fraction)} color="var(--read)" height={6} label="prompt read" />
          ) : sp ? (
            <Bar value={sp.fraction} color="var(--warn)" height={6} label="switch progress" />
          ) : null}
        </div>

        <div className="mt-5 grid gap-3 border-t border-line pt-4 text-[13px] sm:grid-cols-[1fr_auto]">
          {active ? (
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <span className="font-medium">{active.app ?? 'unknown app'}</span>
              <span className="num text-faint">{active.client_ip}</span>
              {active.token ? <Badge>{active.token}</Badge> : <Badge tone="warn">no token</Badge>}
              <span className="text-faint">·</span>
              <Link to="/live" className="inline-flex items-center gap-0.5 text-muted hover:text-fg">
                follow it live <ArrowUpRight className="size-3" />
              </Link>
            </div>
          ) : last ? (
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-muted">
              <span>Last:</span>
              <span className="font-medium text-fg">{last.app}</span>
              <span className="num">
                {compact(last.prompt_tokens)} in · {compact(last.output_tokens)} out
                {firstToken(last) !== null ? ` · first token ${dur(firstToken(last))}` : ''}
                {isNum(last.hit_rate) ? ` · ${pct(last.hit_rate)} experts in VRAM` : ''}
              </span>
            </div>
          ) : (
            <div className="text-muted">No requests yet in this session.</div>
          )}
          <div className="flex items-center gap-3 text-xs text-muted">
            {waiting.length ? (
              <span className="num">
                <span className="text-fg">{waiting.length}</span> waiting
              </span>
            ) : null}
            <span className="num">
              engine {engine?.engine?.version ?? '—'} · {engine?.engine?.drafting ?? '—'}
            </span>
          </div>
        </div>
        <QuickActions />
      </div>
    </section>
  )
}
