import type { Band, Verdict } from '@/lib/bench'
import { isNum } from '@/lib/format'

const COLOR: Record<Verdict, string> = {
  better: 'var(--ok)',
  worse: 'var(--error)',
  same: 'var(--fg)',
  missing: 'var(--fg-faint)',
}

/**
 * A against B on one axis: the noise band around A shaded, A hollow, B filled (rose when worse, green when better).
 * The axis is the metric's own unit, so a longer step means a bigger change.
 */
export function DotPlot({
  a,
  b,
  band,
  verdict,
  width = 168,
  height = 22,
  label,
}: {
  a: number | null
  b: number | null
  band: Band
  verdict: Verdict
  width?: number
  height?: number
  label: string
}) {
  if (!isNum(a) && !isNum(b)) return <span className="text-xs text-faint">—</span>
  const lo0 = Math.min(...[a, b].filter(isNum), isNum(a) ? a * (1 - band.pct / 100) : Infinity)
  const hi0 = Math.max(...[a, b].filter(isNum), isNum(a) ? a * (1 + band.pct / 100) : -Infinity)
  const span = Math.max(hi0 - lo0, Math.abs(hi0) * 0.02, 1e-6)
  const lo = lo0 - span * 0.12
  const hi = hi0 + span * 0.12
  const pad = 6
  const x = (v: number) => pad + ((v - lo) / (hi - lo)) * (width - 2 * pad)
  const y = height / 2
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label} className="block overflow-visible">
      <line x1={pad} x2={width - pad} y1={y} y2={y} stroke="var(--line-strong)" strokeWidth={1} />
      {isNum(a) ? (
        <rect
          x={x(a * (1 - band.pct / 100))}
          y={y - 6}
          width={Math.max(2, x(a * (1 + band.pct / 100)) - x(a * (1 - band.pct / 100)))}
          height={12}
          rx={3}
          fill="var(--fg-faint)"
          opacity={0.18}
        />
      ) : null}
      {isNum(a) && isNum(b) ? <line x1={x(a)} x2={x(b)} y1={y} y2={y} stroke={COLOR[verdict]} strokeWidth={1.5} opacity={0.6} /> : null}
      {isNum(a) ? <circle cx={x(a)} cy={y} r={4} fill="var(--panel)" stroke="var(--fg-muted)" strokeWidth={1.5} /> : null}
      {isNum(b) ? <circle cx={x(b)} cy={y} r={4.5} fill={COLOR[verdict]} /> : null}
    </svg>
  )
}
