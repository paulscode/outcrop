import 'uplot/dist/uPlot.min.css'
import { useEffect, useMemo, useRef, useState } from 'react'
import uPlot from 'uplot'
import { isNum } from '@/lib/format'
import { useResolvedTheme } from '@/lib/theme'

export interface ChartSeries {
  key: string
  label: string
  color: string // a CSS variable like var(--answer), or a color
  fmt: (v: number) => string
  scale?: string
  fill?: boolean
}

function cssColor(c: string): string {
  const m = c.match(/^var\((--[\w-]+)\)$/)
  if (!m) return c
  return getComputedStyle(document.documentElement).getPropertyValue(m[1]).trim() || '#888'
}

function alpha(color: string, a: number): string {
  if (color.startsWith('#') && color.length === 7) {
    const n = parseInt(color.slice(1), 16)
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`
  }
  return color
}

/** A time chart (uPlot) of metric series; thresholds as dashed lines; values under the cursor in the header. */
export function Chart({
  points,
  series,
  height = 160,
  thresholds = [],
  range,
  title,
}: {
  points: Array<Record<string, number>>
  series: ChartSeries[]
  height?: number
  thresholds?: Array<{ value: number; color: string; scale?: string; label?: string }>
  range?: { [scale: string]: [number | null, number | null] }
  title: string
}) {
  const box = useRef<HTMLDivElement>(null)
  const plot = useRef<uPlot | null>(null)
  const theme = useResolvedTheme()
  const [idx, setIdx] = useState<number | null>(null)
  const data = useMemo(() => {
    const xs = points.map((p) => p.t)
    return [xs, ...series.map((s) => points.map((p) => (isNum(p[s.key]) ? p[s.key] : null)))] as uPlot.AlignedData
  }, [points, series])

  useEffect(() => {
    const el = box.current
    if (!el) return
    const faint = cssColor('var(--fg-faint)')
    const grid = cssColor('var(--grid)')
    const scales: uPlot.Scales = { x: { time: true } }
    for (const s of series) {
      const sc = s.scale ?? 'y'
      const r = range?.[sc]
      scales[sc] = r ? { range: (_u, lo, hi) => [r[0] ?? Math.min(0, lo), r[1] ?? Math.max(hi, 1)] } : { range: (_u, lo, hi) => [Math.min(0, lo), Math.max(hi * 1.1, 1)] }
    }
    const usedScales = [...new Set(series.map((s) => s.scale ?? 'y'))]
    const opts: uPlot.Options = {
      width: el.clientWidth || 600,
      height,
      padding: [8, 8, 0, 0],
      legend: { show: false },
      cursor: { points: { size: 6 }, drag: { x: false, y: false } },
      scales,
      axes: [
        { stroke: faint, grid: { stroke: grid, width: 1 }, ticks: { show: false }, font: '10px JetBrains Mono Variable, monospace', space: 70 },
        ...usedScales.map((sc, i) => ({
          scale: sc,
          side: i === 0 ? 3 : 1,
          stroke: faint,
          grid: { show: i === 0, stroke: grid, width: 1 },
          ticks: { show: false },
          size: 46,
          font: '10px JetBrains Mono Variable, monospace',
          values: (_u: uPlot, vals: number[]) => vals.map((v) => series.find((s) => (s.scale ?? 'y') === sc)!.fmt(v)),
        })),
      ],
      series: [
        {},
        ...series.map((s) => {
          const c = cssColor(s.color)
          return { label: s.label, scale: s.scale ?? 'y', stroke: c, width: 1.5, fill: s.fill ? alpha(c, 0.12) : undefined, points: { show: false }, spanGaps: false }
        }),
      ],
      hooks: {
        setCursor: [(u) => setIdx(u.cursor.idx ?? null)],
        draw: [
          (u) => {
            const ctx = u.ctx
            for (const t of thresholds) {
              const y = u.valToPos(t.value, t.scale ?? 'y', true)
              if (!isNum(y)) continue
              ctx.save()
              ctx.strokeStyle = cssColor(t.color)
              ctx.setLineDash([4, 4])
              ctx.lineWidth = 1
              ctx.beginPath()
              ctx.moveTo(u.bbox.left, y)
              ctx.lineTo(u.bbox.left + u.bbox.width, y)
              ctx.stroke()
              ctx.restore()
            }
          },
        ],
      },
    }
    const u = new uPlot(opts, data, el)
    plot.current = u
    const ro = new ResizeObserver(() => u.setSize({ width: el.clientWidth, height }))
    ro.observe(el)
    return () => {
      ro.disconnect()
      u.destroy()
      plot.current = null
    }
    // re-create on theme and shape changes; data updates go through setData below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme, height, series.map((s) => s.key).join(','), JSON.stringify(thresholds)])

  useEffect(() => {
    plot.current?.setData(data)
  }, [data])

  const at = idx !== null ? idx : points.length - 1
  return (
    <figure className="min-w-0">
      <figcaption className="mb-1.5 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs">
        <span className="font-medium text-fg">{title}</span>
        {series.map((s, i) => {
          const v = data[i + 1]?.[at]
          return (
            <span key={s.key} className="inline-flex items-center gap-1.5 text-muted">
              <span className="h-0.5 w-3 rounded-full" style={{ backgroundColor: s.color }} aria-hidden />
              {s.label} <span className="num text-fg">{isNum(v) ? s.fmt(v) : '—'}</span>
            </span>
          )
        })}
      </figcaption>
      <div ref={box} className="w-full" role="img" aria-label={`${title} chart`} />
    </figure>
  )
}
