import { Link } from '@tanstack/react-router'
import {
  AlertTriangle,
  Cpu,
  Database,
  Hourglass,
  Layers3,
  Sun,
  Thermometer,
  Zap,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import {
  ago,
  bytes,
  compact,
  fixed,
  gib,
  hoursSinceMidnight,
  int,
  isNum,
  mean,
  median,
  mhz,
  ms,
  pct,
  pct100,
  temp,
  tps,
  watts,
} from '@/lib/format'
import { engineStore, metricsStore, riverStore } from '@/lib/live'
import {
  useEnergy,
  useMemory,
  usePresets,
  useRequestsSummary,
} from '@/lib/queries'
import { activeRid, inflightList, isGenerating } from '@/lib/requests'
import { useStore } from '@/lib/store'
import { cn, useNow } from '@/lib/utils'
import { Empty, Panel, PanelHeader } from '../ui/misc'
import { Tip } from '../ui/menu'
import { MiniBars, Meter, Sparkline, Ticker } from '../viz/basic'
import { MemoryCores, useStrata } from '../viz/strata'

// ------------------------------------------------------------------------------------------------------------- GPU
export function GpuCard() {
  const s = useStore(metricsStore, (m) => m.latest)
  const hist = useStore(metricsStore, (m) => m.history)
  const name = useStore(
    engineStore,
    (e) => e?.hardware_static?.gpu_name ?? null,
  )
  const g = s?.gpu
  // a GB10 shares the system's memory: no VRAM of its own to show (the memory card has the one pool)
  const unified = useMemory().data?.unified ?? false
  const util = useMemo(
    () => hist.slice(-120).map((x) => x.gpu.util ?? null),
    [hist],
  )
  const others = (g?.procs ?? []).filter(
    (p) => !/strata/i.test(p.name) && (p.mem ?? 0) > 0,
  )
  const throttle = (g?.throttle ?? []).filter(
    (t) => t !== 'idle' && t !== 'app clocks',
  )
  // Hot from 80 °C, cool again only below 78 °C: the card tends to sit right at 80, and the note should not flicker.
  const [hot, setHot] = useState(false)
  const t = g?.temp
  const nextHot = isNum(t) ? (hot ? t >= 78 : t >= 80) : hot
  if (nextHot !== hot) setHot(nextHot)
  const note = others.length ? 'others' : hot ? 'hot' : isNum(t) ? 'ok' : 'none'
  return (
    <Panel className="h-full">
      <PanelHeader
        icon={<Cpu />}
        title="GPU"
        meta={name ?? 'unknown GPU'}
        actions={
          <Link to="/system" className="text-xs text-faint hover:text-fg">
            System
          </Link>
        }
      />
      <div className="grid gap-3 p-4">
        <Meter
          label="SM"
          value={g?.util}
          max={100}
          text={pct100(g?.util)}
          color="var(--answer)"
          title="How busy the GPU's streaming multiprocessors are"
        />
        {unified ? null : (
          <Meter
            label="VRAM"
            value={g?.mem_used}
            max={g?.mem_total || 1}
            text={
              isNum(g?.mem_used) && g?.mem_total
                ? `${fixed(g.mem_used / 1024, 1)} GiB`
                : '—'
            }
            color="var(--layer-1)"
            title={
              g?.mem_total
                ? `Video memory in use, of the card's ${fixed(g.mem_total / 1024, 0)} GiB`
                : 'Video memory in use (the card did not report its size)'
            }
          />
        )}
        <Meter
          label="Temp"
          value={g?.temp}
          max={95}
          warnAt={80}
          text={temp(g?.temp)}
          color="var(--fg-muted)"
          title="Above 80 °C long prompts lose clock bins; alerts start at 83 °C"
        />
        <div className="flex items-end justify-between gap-3 pt-1">
          <div className="num text-xs leading-relaxed text-muted">
            <div>
              {[
                isNum(g?.power) ? watts(g.power) : null,
                isNum(g?.sm_clock) ? mhz(g.sm_clock) : null,
                isNum(g?.fan) ? `fan ${g.fan}%` : null,
              ]
                .filter(Boolean)
                .join(' · ') || 'power —'}
            </div>
            <div>
              {throttle.length ? (
                <span className="text-warn">
                  throttling: {throttle.join(', ')}
                </span>
              ) : g?.throttle ? (
                'no throttling'
              ) : (
                <Tip content="This machine's GPU does not report its clocks and throttle reasons (no NVML)">
                  <span>clocks not reported</span>
                </Tip>
              )}
              {isNum(g?.pcie_gen)
                ? ` · PCIe ${g.pcie_gen} x${g.pcie_width}`
                : ''}
            </div>
          </div>
          <Sparkline
            values={util}
            width={96}
            height={28}
            max={100}
            color="var(--answer)"
            label="GPU busy, the last 2 minutes"
          />
        </div>
        {/* One slot, always there: the notes share a grid cell, so the slot keeps the height of the tallest one and the card
            does not change size when the GPU warms past 80 °C and back. */}
        <div className="grid">
          <GpuNote show={note === 'ok'} tone="ok">
            Cool: full clocks below 80 °C.
          </GpuNote>
          <GpuNote show={note === 'hot'} tone="warn">
            Running hot: above 80 °C long prompts lose clock bins.
          </GpuNote>
          {others.length ? (
            <GpuNote show={note === 'others'} tone="warn">
              {`${others.map((p) => p.name).join(', ')} also ${others.length > 1 ? 'use' : 'uses'} the GPU, which slows answers (sharing it with a remote desktop cost 7–15% of decode speed).`}
            </GpuNote>
          ) : null}
        </div>
      </div>
    </Panel>
  )
}

function GpuNote({
  show,
  tone,
  children,
}: {
  show: boolean
  tone: 'ok' | 'warn'
  children: React.ReactNode
}) {
  return (
    <div
      aria-hidden={!show}
      className={cn(
        'col-start-1 row-start-1 flex items-center gap-2 rounded-md border px-2.5 py-2 text-xs transition-opacity duration-300',
        tone === 'warn'
          ? 'border-warn/30 bg-warn-bg text-fg'
          : 'border-line bg-sunken text-muted',
        show ? 'opacity-100' : 'pointer-events-none invisible opacity-0',
      )}
    >
      {tone === 'warn' ? (
        <AlertTriangle className="size-3.5 shrink-0 text-warn" aria-hidden />
      ) : (
        <Thermometer className="size-3.5 shrink-0 text-faint" aria-hidden />
      )}
      <span>{children}</span>
    </div>
  )
}

// ----------------------------------------------------------------------------------------------------------- today
export function TodayCard() {
  const hours = hoursSinceMidnight()
  const { data: s } = useRequestsSummary(hours)
  const { data: energy } = useEnergy(1)
  const today = energy?.today
  return (
    <Panel className="h-full">
      <PanelHeader
        icon={<Sun />}
        title="Today"
        actions={
          <Link to="/requests" className="text-xs text-faint hover:text-fg">
            Requests
          </Link>
        }
      />
      <div className="grid gap-4 p-4">
        <div>
          <div className="num text-[34px] font-light leading-none">
            <Ticker value={s?.n ?? null} format={(v) => int(v)} />
          </div>
          <div className="mt-1 text-xs text-faint">requests to the model</div>
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 text-[13px]">
          <div>
            <dt className="text-xs text-faint">Tokens in</dt>
            <dd className="num">{compact(s?.p)}</dd>
          </div>
          <div>
            <dt className="text-xs text-faint">Tokens out</dt>
            <dd className="num">{compact(s?.o)}</dd>
          </div>
          <div>
            <dt className="text-xs text-faint">First token</dt>
            <dd className="num">{ms(s?.ttft)}</dd>
          </div>
          <div>
            <dt className="text-xs text-faint">Answer speed</dt>
            <dd className="num">{tps(s?.dec)}</dd>
          </div>
          <div>
            <dt className="text-xs text-faint">
              <Tip content="GPU energy only: NVML power over time. The VM cannot read the CPU's power.">
                <span className="underline decoration-dotted underline-offset-2">
                  GPU energy
                </span>
              </Tip>
            </dt>
            <dd className="num">
              {isNum(today?.kwh) ? `${fixed(today.kwh, 2)} kWh` : '—'}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-faint">Refused</dt>
            <dd className={cn('num', (s?.denied ?? 0) > 0 && 'text-warn')}>
              {int(s?.denied ?? 0)}
            </dd>
          </div>
        </dl>
      </div>
    </Panel>
  )
}

// ----------------------------------------------------------------------------------------------------------- queue
export function QueueCard() {
  const river = useStore(riverStore)
  const now = useNow(1000)
  const rid = activeRid(river)
  const waiting = inflightList(river).filter(
    (f) => isGenerating(f) && f.rid !== rid,
  )
  const held = waiting.filter((f) => f.phase === 'held').length
  const next = waiting[0]
  return (
    <Panel className="h-full">
      <PanelHeader
        icon={<Hourglass />}
        title="Queue"
        actions={
          <Link to="/live" className="text-xs text-faint hover:text-fg">
            Live
          </Link>
        }
      />
      <div className="grid gap-3 p-4">
        <div>
          <div
            className={cn(
              'num text-[34px] font-light leading-none',
              waiting.length ? 'text-fg' : 'text-faint',
            )}
          >
            {waiting.length}
          </div>
          <div className="mt-1 text-xs text-faint">
            waiting{held ? ` · ${held} held for a switch` : ''}
          </div>
        </div>
        {next ? (
          <div className="text-[13px]">
            <span className="text-faint">next: </span>
            <span className="font-medium">{next.app}</span>
            <span className="num text-faint">
              {' '}
              · {Math.round(now - next.started_at)} s
            </span>
          </div>
        ) : (
          <div className="text-[13px] text-muted">
            {rid ? 'Only the request in progress.' : 'Nothing waiting.'}
          </div>
        )}
        <p className="text-xs leading-relaxed text-faint">
          One request at a time: the others wait their turn at the engine.
        </p>
      </div>
    </Panel>
  )
}

// --------------------------------------------------------------------------------------------- conversation cache
export function ConvCacheCard() {
  const cc = useStore(engineStore, (e) => e?.conversation_cache ?? null)
  const { data: mem } = useMemory()
  const now = useNow(5000)
  const items = mem?.conversation_cache?.items
  const slots = mem?.conversation_cache?.slots ?? cc?.slots ?? 16
  const parked = mem?.conversation_cache?.parked ?? cc?.parked ?? 0
  const used = mem?.conversation_cache?.bytes ?? cc?.bytes ?? null
  const budget =
    mem?.conversation_cache?.budget_gib ??
    (cc?.budget_mib ? cc.budget_mib / 1024 : null)
  // from the gateway's own log, so the tokens and the requests cover the same last requests
  const recent = mem?.conversation_cache?.recent
  const tokShare = recent?.prompt_tokens
    ? recent.reused_tokens / recent.prompt_tokens
    : null
  return (
    <Panel className="h-full">
      <PanelHeader
        icon={<Database />}
        title="Conversation cache"
        meta={
          <Tip content="Strata parks recent conversations (their KV state) in RAM, so a follow-up does not read the whole prompt again.">
            <span className="underline decoration-dotted underline-offset-2">
              what is this?
            </span>
          </Tip>
        }
      />
      <div className="grid gap-4 p-4">
        <div
          className="grid grid-cols-8 gap-1.5"
          role="img"
          aria-label={`${parked} of ${slots} conversations parked`}
        >
          {Array.from({ length: slots }, (_, i) => {
            const it = items?.[i]
            const filled = i < parked
            return (
              <Tip
                key={i}
                content={
                  it ? (
                    <span className="num">
                      {int(it.tokens)} tokens · {bytes(it.bytes)} ·{' '}
                      {ago(now - it.age_s, now)}
                    </span>
                  ) : filled ? (
                    'a parked conversation'
                  ) : (
                    'free slot'
                  )
                }
              >
                <span
                  className={cn(
                    'block h-6 rounded-[4px] border transition-colors duration-500',
                    filled
                      ? 'border-transparent'
                      : 'border-line-strong bg-sunken',
                  )}
                  style={
                    filled
                      ? {
                          background: 'var(--layer-6)',
                          opacity: it
                            ? 0.55 +
                              0.45 * Math.min(1, it.bytes / (2 ** 30 * 3))
                            : 0.85,
                        }
                      : undefined
                  }
                />
              </Tip>
            )
          })}
        </div>
        <div className="flex flex-wrap items-baseline justify-between gap-2 text-[13px]">
          <span>
            <span className="num text-fg">{parked}</span>{' '}
            <span className="text-faint">of {slots} parked</span>
          </span>
          <span className="num text-muted">
            {used !== null ? `${gib(used / 2 ** 30, 1)}` : '—'} of{' '}
            {budget ? gib(budget, 0) : '—'}
          </span>
        </div>
        <p className="text-xs leading-relaxed text-muted">
          {recent && tokShare !== null ? (
            <>
              <span className="num text-fg">{pct(tokShare)}</span> of prompt
              tokens came from the cache instead of being read again, over the
              last <span className="num">{int(recent.requests)}</span>{' '}
              {recent.requests === 1 ? 'request' : 'requests'} (
              {int(recent.requests_reused)} of them reused part of an earlier
              prompt).
            </>
          ) : (
            'No requests yet.'
          )}
        </p>
      </div>
    </Panel>
  )
}

// -------------------------------------------------------------------------------------------------- memory strata
export function MemoryCard() {
  const { data: mem } = useMemory()
  const sample = useStore(metricsStore, (m) => m.latest)
  const engine = useStore(engineStore)
  const st = useStrata(mem, sample, engine)
  return (
    <Panel className="h-full">
      <PanelHeader
        icon={<Layers3 />}
        title="Memory strata"
        meta={
          st.derived
            ? 'from the live sample'
            : st.unified
              ? 'what fills the memory'
              : 'what fills the card and the RAM'
        }
        actions={
          <Link
            to="/system"
            hash="memory"
            className="text-xs text-faint hover:text-fg"
          >
            More
          </Link>
        }
      />
      {st.vram.length || st.ram.length ? (
        <MemoryCores st={st} />
      ) : (
        <Empty title="No memory figures yet" />
      )}
    </Panel>
  )
}

// ------------------------------------------------------------------------------------------------- engine insights
interface Insight {
  key: string
  title: string
  term: string
  value: string
  sentence: React.ReactNode
  bars?: number[]
  tone?: 'ok' | 'warn' | 'neutral'
}

export function Insights() {
  const engine = useStore(engineStore)
  const { data: presets } = usePresets()
  const reqs = engine?.requests ?? []
  const tot = engine?.totals
  const cc = engine?.conversation_cache
  const cur = presets?.presets.find((p) => p.running)
  const list: Insight[] = []
  const hits = reqs.map((r) => r.hit_rate).filter(isNum)
  const hit = mean(hits)
  if (hit !== null) {
    list.push({
      key: 'hit',
      title: 'Experts in VRAM',
      term: 'expert-cache hit rate',
      value: pct(hit),
      sentence: (
        <>
          {pct(hit)} of the experts the last {hits.length} answers needed were
          already on the card; the CPU computed the rest.
        </>
      ),
      bars: hits.map((h) => h * 100),
      tone: hit >= 0.8 ? 'ok' : 'warn',
    })
  }
  if (tot?.drafts_offered) {
    const acc = (tot.drafts_accepted ?? 0) / tot.drafts_offered
    list.push({
      key: 'mtp',
      title: 'Drafts kept',
      term: 'MTP speculative decoding',
      value: pct(acc),
      sentence: (
        <>
          The drafter guessed {compact(tot.drafts_offered)} tokens ahead and{' '}
          {compact(tot.drafts_accepted)} were right, each one a decode step
          saved.
        </>
      ),
      bars: reqs
        .filter((r) => r.drafts_offered)
        .map((r) => ((r.drafts_accepted ?? 0) / (r.drafts_offered || 1)) * 100),
    })
  }
  if (cc?.prompt_tokens) {
    const share = (cc.reused_tokens ?? 0) / cc.prompt_tokens
    list.push({
      key: 'reuse',
      title: 'Prompt reused',
      term: 'conversation-cache restores',
      value: pct(share),
      sentence: (
        <>
          {pct(share)} of prompt tokens came from the cache instead of being
          read again since the engine started ({cc.restores ?? 0} restores,{' '}
          {cc.evictions ?? 0} evictions).
        </>
      ),
    })
  }
  const dec = median(reqs.map((r) => r.decode_tok_s))
  const bench = cur?.measured?.chat?.decode ?? null
  if (dec !== null) {
    const diff = bench ? (dec - bench) / bench : null
    list.push({
      key: 'speed',
      title: 'Answer speed',
      term: 'decode tokens per second',
      value: tps(dec),
      sentence: bench ? (
        <>
          The last answers ran at {fixed(dec, 1)} tok/s,{' '}
          {Math.abs((diff ?? 0) * 100).toFixed(0)}%{' '}
          {diff! >= 0 ? 'above' : 'below'} the benchmark for {cur?.name} (
          {fixed(bench, 1)}).
        </>
      ) : (
        <>The last answers ran at a median {fixed(dec, 1)} tok/s.</>
      ),
      bars: reqs.map((r) => r.decode_tok_s ?? 0),
      tone: diff !== null && diff < -0.1 ? 'warn' : 'neutral',
    })
  }
  if (!list.length)
    return (
      <Panel>
        <Empty
          icon={<Zap />}
          title="Engine insights appear after the first answers"
        />
      </Panel>
    )
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {list.map((i) => (
        <Panel key={i.key} className="flex flex-col p-4">
          <div className="flex items-center justify-between gap-2">
            <Tip content={`Engine term: ${i.term}`}>
              <h3 className="text-xs font-medium text-muted">{i.title}</h3>
            </Tip>
            {i.bars?.length ? (
              <MiniBars
                values={i.bars}
                width={72}
                height={18}
                color={i.tone === 'warn' ? 'var(--warn)' : 'var(--fg-faint)'}
                label={`${i.title}, per request`}
              />
            ) : null}
          </div>
          <div
            className={cn(
              'num mt-2 text-[26px] font-light leading-none',
              i.tone === 'warn' && 'text-warn',
            )}
          >
            {i.value}
          </div>
          <p className="mt-2.5 text-xs leading-relaxed text-muted">
            {i.sentence}
          </p>
        </Panel>
      ))}
    </div>
  )
}
