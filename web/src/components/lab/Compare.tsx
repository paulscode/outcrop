import { AlertTriangle, ArrowLeftRight, Scale } from 'lucide-react'
import { useMemo } from 'react'
import {
  CASE_HELP,
  compareRuns,
  hasSpeed,
  isContended,
  isImported,
  METRICS,
  type Comparison,
  type LabRun,
} from '@/lib/bench'
import { dateTime, fixed } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/input'
import { Tip } from '@/components/ui/menu'
import { Empty, Panel, PanelHeader } from '@/components/ui/misc'
import { DotPlot } from './DotPlot'

export function runLabel(r: LabRun): string {
  return `#${r.id} ${r.kind === 'import' ? 'imported' : r.kind}${r.preset ? ` · ${r.preset}` : ''} · ${dateTime(r.started_at)}`
}

function fmtMetric(m: string, v: number | null): string {
  if (v === null) return '—'
  return m === 'ttft' ? `${fixed(v, 2)} s` : fixed(v, 1)
}

function verdictWords(c: Comparison): { text: string; cls: string } {
  const better = METRICS.find((m) => m.key === c.metric)!.better
  switch (c.verdict) {
    case 'same':
      return { text: 'within noise', cls: 'text-faint' }
    case 'better':
      return { text: better === 'lower' ? 'quicker' : 'faster', cls: 'text-ok' }
    case 'worse':
      return { text: better === 'lower' ? 'slower start' : 'slower', cls: 'text-error font-medium' }
    default:
      return { text: 'not measured', cls: 'text-faint' }
  }
}

export function Compare({
  runs,
  a,
  b,
  setA,
  setB,
}: {
  runs: LabRun[]
  a: LabRun | null
  b: LabRun | null
  setA: (id: LabRun['id'] | null) => void
  setB: (id: LabRun['id'] | null) => void
}) {
  const choices = useMemo(() => runs.filter((r) => r.status === 'ok' && hasSpeed(r)), [runs])
  const all = useMemo(() => (a && b ? compareRuns(a, b, runs) : []), [a, b, runs])
  // only the cases both runs measured; the others are named in a note
  const rows = useMemo(() => all.filter((r) => r.verdict !== 'missing'), [all])
  const onlyOne = useMemo(() => [...new Set(all.filter((r) => r.verdict === 'missing').map((r) => r.case))].filter((c) => !rows.some((r) => r.case === c)), [all, rows])
  const worse = rows.filter((r) => r.verdict === 'worse')
  const better = rows.filter((r) => r.verdict === 'better')
  const measured = rows.filter((r) => r.verdict !== 'missing')
  const byCase = useMemo(() => {
    const m = new Map<string, Comparison[]>()
    for (const r of rows) m.set(r.case, [...(m.get(r.case) ?? []), r])
    return [...m.entries()]
  }, [rows])

  return (
    <Panel aria-labelledby="cmp-title">
      <PanelHeader id="cmp-title" title="Compare two runs" icon={<Scale />} meta="B against A, with the noise band shaded around A" />
      {choices.length < 2 ? (
        <Empty icon={<Scale />} title="Two runs with speeds are needed">
          Run quickbench (or validate) twice, for example before and after a Strata update, and compare them here.
        </Empty>
      ) : (
        <div className="grid gap-4 p-4">
          <div className="grid items-end gap-3 md:grid-cols-[1fr_auto_1fr]">
            <label className="grid gap-1.5 text-[13px]">
              <span className="flex items-center gap-1.5 font-medium">
                <svg width="10" height="10" aria-hidden>
                  <circle cx="5" cy="5" r="3.6" fill="var(--panel)" stroke="var(--fg-muted)" strokeWidth="1.5" />
                </svg>
                A, the baseline
              </span>
              <Select value={a ? String(a.id) : ''} onChange={(e) => setA(e.target.value ? Number(e.target.value) : null)} aria-label="Run A">
                <option value="">Pick a run…</option>
                {choices.map((r) => (
                  <option key={r.id} value={r.id}>
                    {runLabel(r)}
                  </option>
                ))}
              </Select>
            </label>
            <Button
              variant="ghost"
              size="icon-sm"
              className="justify-self-center"
              aria-label="Swap A and B"
              onClick={() => {
                const ai = a?.id ?? null
                setA(b?.id ?? null)
                setB(ai)
              }}
            >
              <ArrowLeftRight />
            </Button>
            <label className="grid gap-1.5 text-[13px]">
              <span className="flex items-center gap-1.5 font-medium">
                <svg width="10" height="10" aria-hidden>
                  <circle cx="5" cy="5" r="4" fill="var(--fg)" />
                </svg>
                B, the one to judge
              </span>
              <Select value={b ? String(b.id) : ''} onChange={(e) => setB(e.target.value ? Number(e.target.value) : null)} aria-label="Run B">
                <option value="">Pick a run…</option>
                {choices.map((r) => (
                  <option key={r.id} value={r.id}>
                    {runLabel(r)}
                  </option>
                ))}
              </Select>
            </label>
          </div>

          {a && b ? (
            <>
              <div
                className={cn(
                  'rounded-lg border px-3.5 py-2.5 text-[13px] leading-relaxed',
                  worse.length ? 'border-error/35 bg-error-bg' : 'border-line bg-panel-2/60',
                )}
                role="status"
              >
                {a.id === b.id ? (
                  'A and B are the same run.'
                ) : worse.length ? (
                  <>
                    <span className="font-semibold text-error">
                      {worse.length} regression{worse.length === 1 ? '' : 's'}:
                    </span>{' '}
                    {worse
                      .map(
                        (w) =>
                          `${w.case} ${METRICS.find((m) => m.key === w.metric)!.label} ${(w.deltaPct ?? 0) > 0 ? '+' : ''}${fixed(w.deltaPct, 1)}% (band ±${fixed(w.band.pct, 1)}%)`,
                      )
                      .join('; ')}
                    .
                  </>
                ) : better.length ? (
                  <>
                    <span className="font-medium text-ok">No regressions.</span> B is better beyond the noise on {better.length} of{' '}
                    {measured.length} measures; the rest are within noise.
                  </>
                ) : (
                  <>
                    <span className="font-medium">No difference beyond the noise</span> on all {measured.length} measures.
                  </>
                )}
              </div>
              {[a, b].some(isContended) || a.preset !== b.preset || [a, b].some(isImported) || onlyOne.length ? (
                <ul className="grid gap-1 text-xs text-muted">
                  {[a, b].map((r, i) =>
                    isContended(r) ? (
                      <li key={`c${i}`} className="flex items-center gap-1.5 text-warn">
                        <AlertTriangle className="size-3.5" aria-hidden /> Run {i ? 'B' : 'A'} shared the GPU with another process: its
                        speeds may be low.
                      </li>
                    ) : null,
                  )}
                  {a.preset !== b.preset ? (
                    <li>
                      A ran on <span className="num text-fg">{a.preset ?? '—'}</span> and B on{' '}
                      <span className="num text-fg">{b.preset ?? '—'}</span>: different presets are expected to differ.
                    </li>
                  ) : null}
                  {[a, b].some(isImported) ? <li>Imported runs come from bench/results, measured from the command line.</li> : null}
                  {onlyOne.length ? (
                    <li>
                      Measured in only one of the two: <span className="num text-fg">{onlyOne.join(', ')}</span>.
                    </li>
                  ) : null}
                </ul>
              ) : null}

              {/* phones: one block per case */}
              <div className="grid gap-3 md:hidden">
                {byCase.map(([c, list]) => (
                  <section key={c} className="rounded-lg border border-line p-3" aria-label={`${c}: ${CASE_HELP[c as keyof typeof CASE_HELP]}`}>
                    <div className="mb-2">
                      <span className="num text-[13px] text-fg">{c}</span>{' '}
                      <span className="text-xs text-faint">{CASE_HELP[c as keyof typeof CASE_HELP]}</span>
                    </div>
                    <ul className="grid gap-2.5">
                      {list.map((r) => {
                        const m = METRICS.find((x) => x.key === r.metric)!
                        const v = verdictWords(r)
                        return (
                          <li key={r.metric} className="grid gap-1">
                            <div className="flex items-baseline gap-2 text-[13px]">
                              <span className="text-muted">{m.label}</span>
                              <span className="num ml-auto text-muted">{fmtMetric(r.metric, r.a)}</span>
                              <span className="text-faint" aria-hidden>
                                →
                              </span>
                              <span className="num text-fg">{fmtMetric(r.metric, r.b)}</span>
                              <span className={cn('num w-16 text-right', v.cls)}>
                                {r.deltaPct === null ? '—' : `${r.deltaPct > 0 ? '+' : ''}${fixed(r.deltaPct, 1)}%`}
                              </span>
                            </div>
                            <div className="flex items-center gap-2">
                              <DotPlot
                                a={r.a}
                                b={r.b}
                                band={r.band}
                                verdict={r.verdict}
                                width={200}
                                label={`${c} ${m.label}: A ${fmtMetric(r.metric, r.a)}, B ${fmtMetric(r.metric, r.b)}, noise band ±${fixed(r.band.pct, 1)}%`}
                              />
                              <span className={cn('ml-auto text-xs', v.cls)}>{v.text}</span>
                            </div>
                          </li>
                        )
                      })}
                    </ul>
                  </section>
                ))}
              </div>
              <div className="hidden overflow-x-auto scrollbar-thin md:block">
                <table className="w-full min-w-[640px] text-[13px]">
                  <caption className="sr-only">Speeds of run B against run A, per case</caption>
                  <thead>
                    <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-faint">
                      <th scope="col" className="py-2 pr-3 font-semibold">Case</th>
                      <th scope="col" className="py-2 pr-3 font-semibold">Measure</th>
                      <th scope="col" className="py-2 pr-3 text-right font-semibold">A</th>
                      <th scope="col" className="py-2 pr-3 text-right font-semibold">B</th>
                      <th scope="col" className="py-2 pr-3 text-right font-semibold">Change</th>
                      <th scope="col" className="py-2 pr-3 font-semibold">
                        <span className="sr-only">Plot</span>
                      </th>
                      <th scope="col" className="py-2 font-semibold">Verdict</th>
                    </tr>
                  </thead>
                  <tbody>
                    {byCase.map(([c, list]) =>
                      list.map((r, i) => {
                        const m = METRICS.find((x) => x.key === r.metric)!
                        const v = verdictWords(r)
                        return (
                          <tr key={`${c}-${r.metric}`} className={cn('align-middle', i === list.length - 1 && 'border-b border-line')}>
                            {i === 0 ? (
                              <th scope="rowgroup" rowSpan={list.length} className="py-2 pr-3 text-left align-top font-normal">
                                <span className="num block text-fg">{c}</span>
                                <span className="block text-xs text-faint">{CASE_HELP[c as keyof typeof CASE_HELP]}</span>
                              </th>
                            ) : null}
                            <td className="py-1.5 pr-3 text-muted">
                              <Tip content={`${m.term}; ${m.better} is better`}>
                                <span className="cursor-help underline decoration-dotted decoration-line-strong underline-offset-4">{m.label}</span>
                              </Tip>
                            </td>
                            <td className="num py-1.5 pr-3 text-right text-muted">{fmtMetric(r.metric, r.a)}</td>
                            <td className="num py-1.5 pr-3 text-right text-fg">{fmtMetric(r.metric, r.b)}</td>
                            <td className={cn('num py-1.5 pr-3 text-right', v.cls)}>
                              {r.deltaPct === null ? '—' : `${r.deltaPct > 0 ? '+' : ''}${fixed(r.deltaPct, 1)}%`}
                            </td>
                            <td className="py-1.5 pr-3">
                              <Tip
                                content={`${
                                  r.band.source === 'history'
                                    ? `Noise band ±${fixed(r.band.pct, 1)}%: twice the spread of ${r.band.n} earlier runs of this preset.`
                                    : `Noise band ±${fixed(r.band.pct, 1)}% (the default: fewer than 3 earlier runs of this preset).`
                                } Changes under ${m.floor} ${m.unit} count as noise too.`}
                              >
                                <span className="inline-block">
                                  <DotPlot
                                    a={r.a}
                                    b={r.b}
                                    band={r.band}
                                    verdict={r.verdict}
                                    label={`${c} ${m.label}: A ${fmtMetric(r.metric, r.a)}, B ${fmtMetric(r.metric, r.b)}, noise band ±${fixed(r.band.pct, 1)}%`}
                                  />
                                </span>
                              </Tip>
                            </td>
                            <td className={cn('py-1.5 text-[13px]', v.cls)}>
                              {v.text}
                              <span className="num ml-1.5 text-[11px] text-faint">±{fixed(r.band.pct, 1)}%</span>
                            </td>
                          </tr>
                        )
                      }),
                    )}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <p className="text-[13px] text-muted">Pick two runs.</p>
          )}
        </div>
      )}
    </Panel>
  )
}
