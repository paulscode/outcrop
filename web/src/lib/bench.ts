// The benchmark lab's arithmetic: what a run measured, and whether run B differs from run A by more than the noise.

export const CASES = ['chat', 'code', 'story', 'doc4k'] as const
export type CaseName = (typeof CASES)[number]
export type Metric = 'decode' | 'prompt' | 'ttft'

export const CASE_HELP: Record<CaseName, string> = {
  chat: 'a short question and answer',
  code: 'writing a small program',
  story: 'a long free-form answer',
  doc4k: 'reading a 4,000-token document first',
}

/** `floor`: a change smaller than this, in the metric's own unit, is noise whatever the percentage (a 0.25 s first token
 * that becomes 0.29 s is +16 % but only 40 ms). */
export const METRICS: Array<{ key: Metric; label: string; term: string; better: 'higher' | 'lower'; unit: string; floor: number }> = [
  { key: 'decode', label: 'answer speed', term: 'decode tok/s', better: 'higher', unit: 'tok/s', floor: 0.3 },
  { key: 'prompt', label: 'prompt reading', term: 'prefill tok/s', better: 'higher', unit: 'tok/s', floor: 1 },
  { key: 'ttft', label: 'first token', term: 'time to first token', better: 'lower', unit: 's', floor: 0.05 },
]

export const DEFAULT_BAND_PCT = 3
export const MIN_HISTORY = 3

export interface CaseSpeed {
  decode?: number
  prompt?: number
  ttft?: number
  runs?: number[]
}

/** What the backend stores for a run (console/outcrop/console/extras.py). */
export interface LabRun {
  id: number | string
  kind: string
  preset: string | null
  status: string
  started_at: number
  ended_at: number | null
  result: Record<string, unknown>
  contention: number | boolean
  source: string | null
  args?: { cases?: string; repeat?: number; by?: string } & Record<string, unknown>
  log?: string
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Per-case speeds: `result.speed` (the console's own runs and imports), or the cases at the top level (older shape). */
export function speedOf(run: Pick<LabRun, 'result'> | null | undefined): Partial<Record<CaseName, CaseSpeed>> {
  const r = (run?.result ?? {}) as Record<string, unknown>
  const src = (r.speed && typeof r.speed === 'object' ? r.speed : r) as Record<string, unknown>
  const out: Partial<Record<CaseName, CaseSpeed>> = {}
  for (const c of CASES) {
    const v = src[c]
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>
      const s: CaseSpeed = {}
      if (finite(o.decode)) s.decode = o.decode
      if (finite(o.prompt)) s.prompt = o.prompt
      if (finite(o.ttft)) s.ttft = o.ttft
      if (Array.isArray(o.runs)) s.runs = o.runs.filter(finite)
      if (s.decode !== undefined || s.prompt !== undefined || s.ttft !== undefined) out[c] = s
    }
  }
  return out
}

export function hasSpeed(run: Pick<LabRun, 'result'>): boolean {
  return Object.keys(speedOf(run)).length > 0
}

export interface Check {
  cmd: string
  passed: number
  total: number
}

export function checksOf(run: Pick<LabRun, 'result'>): Check[] {
  const c = (run.result as { checks?: unknown }).checks
  if (!Array.isArray(c)) return []
  return c.filter(
    (x): x is Check => !!x && typeof x === 'object' && finite((x as Check).passed) && finite((x as Check).total),
  )
}

export function runDuration(run: Pick<LabRun, 'started_at' | 'ended_at' | 'status'>, now = Date.now() / 1000): number | null {
  if (run.ended_at && run.ended_at > run.started_at) return run.ended_at - run.started_at
  if (run.status === 'running') return now - run.started_at
  return null
}

export function isContended(run: Pick<LabRun, 'contention'>): boolean {
  return run.contention === true || (typeof run.contention === 'number' && run.contention > 0)
}

export function isImported(run: Pick<LabRun, 'kind' | 'source'>): boolean {
  return run.kind === 'import' || !!run.source
}

// --------------------------------------------------------------------------------------------------- noise band
export interface Band {
  /** half-width, in percent of A */
  pct: number
  /** how many earlier runs it came from (0 = the default) */
  n: number
  source: 'history' | 'default'
}

function stdev(xs: number[]): number {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1))
}

/**
 * The noise band for a case and metric: twice the spread (coefficient of variation) of earlier runs of the same preset,
 * when there are at least three, held between 1 and 15 %; otherwise ±3 %.
 */
export function noiseBand(
  history: LabRun[],
  preset: string | null,
  c: CaseName,
  m: Metric,
  exclude: Set<LabRun['id']> = new Set(),
  before = Infinity,
): Band {
  if (preset) {
    const vals = history
      .filter((r) => r.preset === preset && !exclude.has(r.id) && r.started_at < before && r.status === 'ok' && !isContended(r))
      .map((r) => speedOf(r)[c]?.[m])
      .filter(finite)
    if (vals.length >= MIN_HISTORY) {
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length
      if (mean > 0) {
        const pct = Math.min(15, Math.max(1, (2 * stdev(vals) * 100) / mean))
        return { pct: Math.round(pct * 10) / 10, n: vals.length, source: 'history' }
      }
    }
  }
  return { pct: DEFAULT_BAND_PCT, n: 0, source: 'default' }
}

export type Verdict = 'better' | 'worse' | 'same' | 'missing'

export interface Comparison {
  case: CaseName
  metric: Metric
  a: number | null
  b: number | null
  deltaPct: number | null
  band: Band
  verdict: Verdict
}

export function verdictOf(
  a: number | null | undefined,
  b: number | null | undefined,
  band: Band,
  better: 'higher' | 'lower',
  floor = 0,
): { deltaPct: number | null; verdict: Verdict } {
  if (!finite(a) || !finite(b) || a === 0) return { deltaPct: null, verdict: 'missing' }
  const d = ((b - a) / a) * 100
  if (Math.abs(d) <= band.pct || Math.abs(b - a) < floor) return { deltaPct: d, verdict: 'same' }
  const up = d > 0
  return { deltaPct: d, verdict: (better === 'higher') === up ? 'better' : 'worse' }
}

/** Every case and metric of run B against run A. */
export function compareRuns(a: LabRun, b: LabRun, history: LabRun[]): Comparison[] {
  const sa = speedOf(a)
  const sb = speedOf(b)
  const exclude = new Set([a.id, b.id])
  const out: Comparison[] = []
  for (const c of CASES) {
    if (!sa[c] && !sb[c]) continue
    for (const m of METRICS) {
      const av = sa[c]?.[m.key] ?? null
      const bv = sb[c]?.[m.key] ?? null
      let band = noiseBand(history, b.preset, c, m.key, exclude, Math.max(a.started_at, b.started_at))
      if (band.source === 'default' && a.preset !== b.preset)
        band = noiseBand(history, a.preset, c, m.key, exclude, Math.max(a.started_at, b.started_at))
      out.push({ case: c, metric: m.key, a: av, b: bv, band, ...verdictOf(av, bv, band, m.better, m.floor) })
    }
  }
  return out
}

/** The runs to compare by default: B the newest run with speeds, A the one before it on the same preset (or just before). */
export function defaultPair(runs: LabRun[]): [LabRun | null, LabRun | null] {
  const withSpeed = runs.filter((r) => r.status === 'ok' && hasSpeed(r)).sort((x, y) => y.started_at - x.started_at)
  const b = withSpeed[0] ?? null
  if (!b) return [null, null]
  const same = withSpeed.find((r) => r.id !== b.id && r.preset === b.preset)
  const a = same ?? withSpeed.find((r) => r.id !== b.id) ?? null
  return [a, b]
}

/** A one-line summary of a run's speeds, for toasts: "chat 39.3 · code 39.4 tok/s" */
export function speedLine(run: Pick<LabRun, 'result'>): string {
  const s = speedOf(run)
  const parts = CASES.filter((c) => s[c]?.decode !== undefined).map((c) => `${c} ${s[c]!.decode!.toFixed(1)}`)
  return parts.length ? `${parts.join(' · ')} tok/s` : ''
}
