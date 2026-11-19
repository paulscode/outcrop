import { Link } from '@tanstack/react-router'
import { AlertTriangle, CheckCircle2, Cpu, Info, LineChart, Network, Server, ShieldCheck, Thermometer, Zap } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Segmented } from '@/components/ui/controls'
import { Badge, Empty, KV, Panel, PanelHeader } from '@/components/ui/misc'
import { Tip } from '@/components/ui/menu'
import { Chart, type ChartSeries } from '@/components/viz/Chart'
import { CoreSample, useStrata } from '@/components/viz/strata'
import { Bar } from '@/components/viz/basic'
import { ago, bytes, dur, fixed, gib, int, isNum, lastDays, mhz, temp, watts } from '@/lib/format'
import { engineStore, metricsStore, unitsStore } from '@/lib/live'
import { useEnergy, useMemory, useMetricsSeries, useSystem } from '@/lib/queries'
import { useStore } from '@/lib/store'
import type { PostureCheck } from '@/lib/types'
import { cn, useNow } from '@/lib/utils'

/** Where a posture check's fix lives: a page of the console, or a command over SSH. */
function FixLink({ c }: { c: PostureCheck }) {
  if (!c.fix) return null
  const m = c.fix.match(/^(Access|Settings|Presets|System):\s*(.*)$/)
  if (m) {
    const to = `/${m[1].toLowerCase()}` as '/access'
    return (
      <Link to={to} className="text-xs font-medium text-fg underline decoration-line-strong underline-offset-2 hover:decoration-muted">
        {m[2] || `Open ${m[1]}`} →
      </Link>
    )
  }
  return <code className="rounded bg-panel-2 px-1.5 py-0.5 text-[11px] text-muted">{c.fix}</code>
}

function Posture({ checks }: { checks: PostureCheck[] }) {
  const bad = checks.filter((c) => !c.ok)
  const serious = bad.filter((c) => c.level === 'error' || c.level === 'warn')
  const score = checks.length ? checks.filter((c) => c.ok).length : 0
  return (
    <Panel className="h-full">
      <PanelHeader
        icon={<ShieldCheck />}
        title="Security posture"
        meta={`${score} of ${checks.length} fine`}
        actions={
          serious.length ? <Badge tone="warn">{serious.length} to fix</Badge> : bad.length ? <Badge>{bad.length} to review</Badge> : <Badge tone="ok">all fine</Badge>
        }
      />
      <ul className="divide-y divide-line">
        {[...bad, ...checks.filter((c) => c.ok)].map((c) => (
          <li key={c.key} className="flex items-start gap-3 px-4 py-2.5" data-testid={`posture-${c.key}`}>
            {c.ok ? (
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ok" aria-label="fine" />
            ) : c.level === 'error' ? (
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-error" aria-label="needs fixing" />
            ) : c.level === 'warn' ? (
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" aria-label="needs attention" />
            ) : (
              <Info className="mt-0.5 size-4 shrink-0 text-info" aria-label="worth a look" />
            )}
            <div className="min-w-0 flex-1">
              <div className={cn('text-[13px]', c.ok ? 'text-muted' : 'font-medium text-fg')}>{c.title}</div>
              <div className="text-xs text-faint">{c.detail}</div>
            </div>
            {!c.ok ? (
              <div className="shrink-0 pt-0.5">
                <FixLink c={c} />
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </Panel>
  )
}

/** The GPU contention and thermal watch: who else uses the card, throttling, and the temperature against its limits. */
function Watch() {
  const s = useStore(metricsStore, (m) => m.latest)
  const hist = useStore(metricsStore, (m) => m.history)
  const g = s?.gpu
  const procs = g?.procs ?? []
  const others = procs.filter((p) => !/strata/i.test(p.name))
  const thr = (g?.throttle ?? []).filter((t) => t !== 'idle')
  const points = useMemo(() => hist.slice(-600).map((h) => ({ t: h.t, 'gpu.temp': h.gpu.temp ?? NaN, 'gpu.power': h.gpu.power ?? NaN })), [hist])
  const series: ChartSeries[] = useMemo(
    () => [
      { key: 'gpu.temp', label: 'temperature', color: 'var(--warn)', fmt: (v) => `${Math.round(v)}°` },
      { key: 'gpu.power', label: 'power', color: 'var(--fg-muted)', fmt: (v) => `${Math.round(v)} W`, scale: 'w' },
    ],
    [],
  )
  return (
    <Panel className="h-full">
      <PanelHeader icon={<Thermometer />} title="GPU watch" meta="contention and heat" />
      <div className="grid gap-4 p-4">
        <div>
          <div className="eyebrow mb-1.5">Processes on the GPU</div>
          {procs.length ? (
            <ul className="grid gap-1 text-[13px]">
              {procs.map((p) => (
                <li key={p.pid} className="flex items-center gap-2">
                  <span className={cn('size-1.5 rounded-full', /strata/i.test(p.name) ? 'bg-answer' : 'bg-warn')} aria-hidden />
                  <span className="font-medium">{p.name}</span>
                  <span className="num text-xs text-faint">pid {p.pid} · {p.kind}</span>
                  <span className="num ml-auto text-xs">{p.mem ? `${int(p.mem)} MiB` : '—'}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-muted">{g?.procs ? 'None reported.' : 'This machine does not report the GPU’s processes (no NVML).'}</p>
          )}
          {others.length ? (
            <p className="mt-2 rounded-md border border-warn/30 bg-warn-bg px-2.5 py-2 text-xs">
              {others.map((p) => p.name).join(', ')} {others.length > 1 ? 'share' : 'shares'} the GPU. An RDP session cost 7 to 15% of decode speed here; benchmarks taken now are marked.
            </p>
          ) : procs.length ? (
            <p className="mt-2 text-xs text-ok">The GPU is Strata’s alone.</p>
          ) : null}
        </div>
        <div className="grid grid-cols-3 gap-3 text-[13px]">
          <div>
            <div className="text-[11px] text-faint">Temperature</div>
            <div className={cn('num text-[18px]', isNum(g?.temp) && g.temp >= 80 && 'text-warn')}>{temp(g?.temp)}</div>
          </div>
          <div>
            <div className="text-[11px] text-faint">Power</div>
            <div className="num text-[18px]">{watts(g?.power)}</div>
          </div>
          <div>
            <div className="text-[11px] text-faint">SM clock</div>
            <div className="num text-[18px]">{mhz(g?.sm_clock)}</div>
          </div>
        </div>
        <div className="text-xs">
          {thr.length ? (
            <span className="text-warn">Throttling: {thr.join(', ')}</span>
          ) : g?.throttle ? (
            <span className="text-muted">No throttling.</span>
          ) : (
            <span className="text-faint">Throttle reasons are not reported here.</span>
          )}{' '}
          <span className="text-faint">Above 80 °C long prompts lose clock bins; alerts start at 83 °C.</span>
        </div>
        <Chart
          title="The last 10 minutes"
          points={points}
          series={series}
          height={150}
          thresholds={[
            { value: 80, color: 'var(--warn)' },
            { value: 83, color: 'var(--error)' },
          ]}
          range={{ y: [20, 95] }}
        />
      </div>
    </Panel>
  )
}

const RANGES = ['15m', '1h', '6h', '24h', '7d', '30d'] as const

function History() {
  const [range, setRange] = useState<(typeof RANGES)[number]>('1h')
  const { data, isLoading } = useMetricsSeries(range)
  const pts = data?.points ?? []
  const s = useMemo(
    () => ({
      gpu: [
        { key: 'gpu.util', label: 'GPU busy', color: 'var(--answer)', fmt: (v: number) => `${Math.round(v)}%`, fill: true },
        { key: 'host.cpu', label: 'CPU', color: 'var(--fg-muted)', fmt: (v: number) => `${Math.round(v)}%` },
      ],
      speed: [{ key: 'engine.tok_s', label: 'answer speed', color: 'var(--answer)', fmt: (v: number) => `${fixed(v, v < 10 ? 1 : 0)}`, fill: true }],
      mem: [
        { key: 'host.ram_used', label: 'RAM used', color: 'var(--layer-1)', fmt: (v: number) => `${Math.round(v)} G`, fill: true },
        { key: 'host.cached', label: 'page cache', color: 'var(--layer-5)', fmt: (v: number) => `${Math.round(v)} G` },
      ],
      heat: [
        { key: 'gpu.temp', label: 'temperature', color: 'var(--warn)', fmt: (v: number) => `${Math.round(v)}°` },
        { key: 'gpu.power', label: 'power', color: 'var(--fg-muted)', fmt: (v: number) => `${Math.round(v)} W`, scale: 'w' },
      ],
    }),
    [],
  )
  return (
    <Panel>
      <PanelHeader
        icon={<LineChart />}
        title="History"
        meta={data ? `one point per ${dur(data.step_s)}` : undefined}
        actions={<Segmented label="Time range" size="sm" value={range} onValueChange={setRange} options={RANGES.map((r) => ({ value: r, label: r }))} />}
      />
      {isLoading ? (
        <div className="h-72 animate-pulse" />
      ) : pts.length < 2 ? (
        <Empty title="Not enough history yet">The console keeps one-second samples for an hour and rollups for 90 days.</Empty>
      ) : (
        <div className="grid gap-6 p-4 lg:grid-cols-2">
          <Chart title="GPU and CPU" points={pts} series={s.gpu} range={{ y: [0, 100] }} />
          <Chart title="Answer speed (tok/s)" points={pts} series={s.speed} />
          <Chart title="Memory" points={pts} series={s.mem} />
          <Chart title="Heat" points={pts} series={s.heat} thresholds={[{ value: 80, color: 'var(--warn)' }]} range={{ y: [20, 95] }} />
        </div>
      )}
    </Panel>
  )
}

function Memory() {
  const { data: mem } = useMemory()
  const sample = useStore(metricsStore, (m) => m.latest)
  const engine = useStore(engineStore)
  const st = useStrata(mem, sample, engine)
  const now = useNow(5000)
  const items = mem?.conversation_cache?.items ?? []
  return (
    <Panel id="memory" className="h-full scroll-mt-20">
      <PanelHeader icon={<Cpu />} title="Memory strata" meta="hover a layer for what it is and what it buys" />
      <div className="grid gap-6 p-4 sm:grid-cols-2">
        <CoreSample title="VRAM" total={st.vramTotal} layers={st.vram} height={220} />
        <CoreSample title="RAM" total={st.ramTotal} layers={st.ram} height={220} />
      </div>
      {mem?.conversation_cache ? (
        <div className="border-t border-line p-4">
          <div className="eyebrow mb-2">Conversation cache</div>
          <p className="num text-xs text-muted">
            {mem.conversation_cache.parked} of {mem.conversation_cache.slots} parked · {bytes(mem.conversation_cache.bytes)} of {gib(mem.conversation_cache.budget_gib, 0)} ·{' '}
            {int(mem.conversation_cache.requests_reused)} of {int(mem.conversation_cache.requests)} requests reused one
          </p>
          {items.length ? (
            <ul className="mt-2 grid gap-1">
              {items.map((it, i) => (
                <li key={i} className="grid grid-cols-[5rem_1fr_5rem] items-center gap-3 text-xs">
                  <span className="num text-muted">{int(it.tokens)} tok</span>
                  <Bar value={it.bytes} max={(mem.conversation_cache.budget_gib * 2 ** 30) / Math.max(1, mem.conversation_cache.slots)} color="var(--layer-6)" height={6} label="its size" />
                  <span className="num text-right text-faint">{ago(now - it.age_s, now)}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </Panel>
  )
}

function Energy() {
  const { data, isLoading } = useEnergy(30)
  if (isLoading) return <Panel className="h-full min-h-60 animate-pulse" />
  if (!data)
    return (
      <Panel className="h-full">
        <PanelHeader icon={<Zap />} title="Energy" />
        <Empty title="Energy figures are not on this server yet" />
      </Panel>
    )
  // one slot per day for the last 30 days, so a short history does not fill the chart
  const byDay = new Map(data.days.map((d) => [d.day, d]))
  const days = lastDays(30).map((k) => byDay.get(k) ?? { day: k, kwh: 0, requests: 0, output_tokens: 0, tokens_per_joule: null })
  const max = Math.max(0.001, ...days.map((d) => d.kwh))
  const total = days.reduce((a, d) => a + d.kwh, 0)
  const price = data.price_per_kwh
  return (
    <Panel className="h-full">
      <PanelHeader
        icon={<Zap />}
        title="Energy"
        meta={<Tip content={data.note}><span className="underline decoration-dotted underline-offset-2">GPU only</span></Tip>}
        actions={<Link to="/settings" hash="energy" className="text-xs text-faint hover:text-fg">Price</Link>}
      />
      <div className="grid gap-4 p-4">
        <div className="grid grid-cols-3 gap-3">
          <div>
            <div className="text-[11px] text-faint">Today</div>
            <div className="num text-[20px] font-light">{isNum(data.today?.kwh) ? `${fixed(data.today.kwh, 2)}` : '—'} <span className="text-xs text-faint">kWh</span></div>
          </div>
          <div>
            <div className="text-[11px] text-faint">30 days</div>
            <div className="num text-[20px] font-light">{fixed(total, 2)} <span className="text-xs text-faint">kWh</span></div>
            {price ? <div className="num text-xs text-muted">{fixed(total * price, 2)} at {price}/kWh</div> : null}
          </div>
          <div>
            <Tip content="output tokens per joule of GPU energy, today">
              <div className="text-[11px] text-faint">Tokens per joule</div>
            </Tip>
            <div className="num text-[20px] font-light">{isNum(data.today?.tokens_per_joule) ? fixed(data.today.tokens_per_joule, 3) : '—'}</div>
          </div>
        </div>
        <div className="flex h-28 items-end gap-1" role="img" aria-label="GPU energy a day, the last 30 days">
          {days.map((d) => (
            <Tip key={d.day} content={<span className="num">{d.day}: {fixed(d.kwh, 3)} kWh · {int(d.requests)} requests · {int(d.output_tokens)} tokens out</span>}>
              <div
                className="min-w-1 flex-1 rounded-t-[3px]"
                style={{ height: `${Math.max(2, (d.kwh / max) * 100)}%`, backgroundColor: d.kwh ? 'var(--layer-1)' : 'var(--line)' }}
              />
            </Tip>
          ))}
        </div>
        <div className="flex justify-between text-[10px] text-faint">
          <span className="num">{days[0]?.day ?? ''}</span>
          <span className="num">{days[days.length - 1]?.day ?? ''}</span>
        </div>
      </div>
    </Panel>
  )
}

function Services() {
  const units = useStore(unitsStore)
  const { data } = useSystem()
  const list = Object.entries(units ?? data?.info.units ?? {})
  return (
    <Panel className="h-full">
      <PanelHeader icon={<Server />} title="Services" />
      <ul className="divide-y divide-line">
        {list.map(([name, u]) => {
          const ok = u.active === 'active'
          return (
            <li key={name} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
              <span className={cn('size-2 rounded-full', ok ? 'bg-ok' : u.active === 'failed' ? 'bg-error' : 'bg-warn')} aria-hidden />
              <span className="num min-w-0 flex-1 truncate">{name.replace('.service', '')}</span>
              <span className={cn('text-xs', ok ? 'text-muted' : u.active === 'failed' ? 'text-error' : 'text-warn')}>
                {u.active}
                {u.sub && u.sub !== u.active ? ` (${u.sub})` : ''}
              </span>
              {u.restarts ? <Badge tone="warn">{u.restarts} restarts</Badge> : null}
              <span className="hidden text-xs text-faint sm:inline">{u.enabled}</span>
            </li>
          )
        })}
      </ul>
    </Panel>
  )
}

export default function System() {
  const { data } = useSystem()
  const engine = useStore(engineStore, (e) => e?.engine ?? null)
  const info = data?.info
  return (
    <div className="grid gap-4">
      <div className="grid gap-4 lg:grid-cols-2">
        {data ? <Posture checks={data.posture} /> : <Panel className="h-80 animate-pulse" />}
        <Watch />
      </div>
      <History />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <Memory />
        <Energy />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Panel>
          <PanelHeader icon={<Cpu />} title="Hardware" />
          <div className="p-4">
            <KV
              rows={[
                ['GPU', info?.gpu?.name ?? 'Quadro M6000 24GB'],
                ['Driver, CUDA', `${info?.gpu?.driver ?? '—'} · ${info?.cuda ?? '—'}`],
                ['VRAM', info?.gpu?.vram_total_mib ? gib(info.gpu.vram_total_mib / 1024, 0) : '—'],
                ['Power limit', info?.gpu?.power_limit_w ? watts(info.gpu.power_limit_w) : '—'],
                ['PCIe', info?.gpu?.pcie_gen_max ? `gen ${info.gpu.pcie_gen_max} x${info.gpu.pcie_width_max}` : '—'],
                ['CPU', info?.cpu ?? '—'],
                ['Cores', info?.cores ? `${info.cores} cores, ${info.threads} threads, ${info.numa_nodes} NUMA node${info.numa_nodes === 1 ? '' : 's'}` : '—'],
                ['Disk', info?.disk ? `${info.disk.free_gb} GB free of ${info.disk.total_gb} GB` : '—'],
                ['Up', info ? dur(info.uptime_s) : '—'],
              ]}
            />
          </div>
        </Panel>
        <Panel>
          <PanelHeader icon={<Info />} title="Software" />
          <div className="p-4">
            <KV
              rows={[
                ['System', `${info?.os ?? '—'} · ${info?.kernel ?? ''}`],
                ['Strata', info?.strata_commit || '—'],
                ['Engine', `${engine?.version ?? info?.engine?.version ?? '—'} · ${engine?.drafting ?? ''}`],
                ['Model', engine?.model ?? '—'],
                ['Patches', info?.patches?.length ? <span key="p" className="grid gap-0.5">{info.patches.map((p) => <span key={p} className="truncate text-xs text-muted" title={p}>{p.replace(/\.patch$/, '')}</span>)}</span> : '—'],
                ['Engines', info?.engines?.join(', ') || '—'],
                ['Models', info?.models?.length ? <span key="m" className="grid gap-0.5">{info.models.map((m) => <span key={m.path} className="num truncate text-xs text-muted">{m.path} · {m.gib} GiB</span>)}</span> : '—'],
                ['Console', `${info?.console_version ?? '—'} · ${info?.python ?? ''}`],
              ]}
            />
          </div>
        </Panel>
        <div className="grid gap-4">
          <Services />
          <Panel>
            <PanelHeader icon={<Network />} title="Listening ports" meta="open to the LAN marked" />
            <ul className="grid max-h-64 gap-0.5 overflow-y-auto py-3 pl-3 pr-4 scrollbar-thin" tabIndex={0} aria-label="Listening ports">
              {(info?.ports ?? []).map((p) => (
                <li key={`${p.address}:${p.port}`} className="flex items-center gap-2 px-1 text-xs">
                  <span className="num w-14 text-right font-medium">{p.port}</span>
                  <span className="num min-w-0 flex-1 truncate text-muted">{p.address}</span>
                  {p.lan ? (
                    <Badge tone={[22, 80, 443, 8080, 8443, 11434, 5353].includes(Number(p.port)) ? 'neutral' : 'warn'}>LAN</Badge>
                  ) : (
                    <span className="shrink-0 text-faint">local</span>
                  )}
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      </div>
    </div>
  )
}
