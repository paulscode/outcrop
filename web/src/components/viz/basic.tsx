import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { clamp, isNum } from '@/lib/format'
import { cn, useReducedMotion } from '@/lib/utils'

// ------------------------------------------------------------------------------------------------ countdown ring
/** A ring that empties as a window runs out (the open-API countdown). */
export function Ring({
  fraction,
  size = 40,
  stroke = 3.5,
  color = 'var(--warn)',
  track = 'var(--line-strong)',
  children,
  className,
  label,
}: {
  fraction: number
  size?: number
  stroke?: number
  color?: string
  track?: string
  children?: React.ReactNode
  className?: string
  label?: string
}) {
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const f = clamp(isNum(fraction) ? fraction : 0, 0, 1)
  return (
    <div className={cn('relative inline-flex shrink-0 items-center justify-center', className)} style={{ width: size, height: size }} role={label ? 'img' : undefined} aria-label={label}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={track} strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - f)}
          style={{ transition: 'stroke-dashoffset 1s linear' }}
        />
      </svg>
      {children ? <div className="absolute inset-0 flex items-center justify-center">{children}</div> : null}
    </div>
  )
}

// -------------------------------------------------------------------------------------------------------- sparkline
/** A small line (and area) of recent values; nulls break the line. */
export function Sparkline({
  values,
  width = 120,
  height = 28,
  color = 'var(--answer)',
  fill = true,
  max,
  className,
  label,
  strokeWidth = 1.5,
}: {
  values: Array<number | null | undefined>
  width?: number
  height?: number
  color?: string
  fill?: boolean
  max?: number
  className?: string
  label?: string
  strokeWidth?: number
}) {
  const gid = useId()
  const { line, area } = useMemo(() => {
    const n = values.length
    if (n < 2) return { line: '', area: '' }
    const nums = values.filter(isNum)
    const hi = max ?? Math.max(1e-9, ...nums)
    const lo = 0
    const x = (i: number) => (i / (n - 1)) * width
    const y = (v: number) => height - 1 - ((v - lo) / (hi - lo || 1)) * (height - 3)
    let line = ''
    let area = ''
    let seg: Array<[number, number]> = []
    const flush = () => {
      if (seg.length) {
        line += `M${seg.map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`).join('L')}`
        if (seg.length > 1)
          area += `M${seg[0][0].toFixed(1)},${height}L${seg.map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`).join('L')}L${seg[seg.length - 1][0].toFixed(1)},${height}Z`
      }
      seg = []
    }
    values.forEach((v, i) => {
      if (isNum(v)) seg.push([x(i), y(Math.min(v, hi))])
      else flush()
    })
    flush()
    return { line, area }
  }, [values, width, height, max])
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn('overflow-visible', className)}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      preserveAspectRatio="none"
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {fill && area ? <path d={area} fill={`url(#${gid})`} /> : null}
      {line ? <path d={line} fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" /> : null}
    </svg>
  )
}

/** Small bars per day (token usage over 30 days). */
export function MiniBars({
  values,
  width = 90,
  height = 22,
  color = 'var(--fg-muted)',
  className,
  label,
}: {
  values: number[]
  width?: number
  height?: number
  color?: string
  className?: string
  label?: string
}) {
  const n = values.length || 1
  const hi = Math.max(1, ...values)
  const gap = 1
  const w = Math.max(1, (width - gap * (n - 1)) / n)
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={className} role="img" aria-label={label}>
      {values.map((v, i) => {
        const h = v > 0 ? Math.max(2, (v / hi) * (height - 1)) : 1
        return (
          <rect
            key={i}
            x={i * (w + gap)}
            y={height - h}
            width={w}
            height={h}
            rx={Math.min(1, w / 2)}
            fill={v > 0 ? color : 'var(--line-strong)'}
            opacity={v > 0 ? 0.9 : 0.6}
          />
        )
      })}
    </svg>
  )
}

// ---------------------------------------------------------------------------------------------------- progress bar
export function Bar({
  value,
  max = 1,
  color = 'var(--answer)',
  className,
  height = 6,
  label,
  indeterminate,
  track = 'var(--line)',
}: {
  value: number | null | undefined
  max?: number
  color?: string
  className?: string
  height?: number
  label?: string
  indeterminate?: boolean
  track?: string
}) {
  const f = isNum(value) && max > 0 ? clamp(value / max, 0, 1) : 0
  return (
    <div
      className={cn('relative w-full overflow-hidden rounded-full', className)}
      style={{ height, background: track }}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : Math.round(f * 100)}
    >
      {indeterminate ? (
        <div className="animate-indeterminate absolute inset-y-0 w-2/5 rounded-full" style={{ background: color }} />
      ) : (
        <div
          className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-700 ease-out"
          style={{ width: `${f * 100}%`, background: color }}
        />
      )}
    </div>
  )
}

// --------------------------------------------------------------------------------------------- an easing counter
/** A number that eases to each new value (counters ease; with reduced motion it jumps). No animation library. */
export function Ticker({
  value,
  format,
  className,
  duration = 0.6,
}: {
  value: number | null | undefined
  format: (v: number) => string
  className?: string
  duration?: number
}) {
  const reduced = useReducedMotion()
  const [shown, setShown] = useState<number | null>(isNum(value) ? value : null)
  const from = useRef<number | null>(shown)
  const raf = useRef<number | null>(null)
  useEffect(() => {
    if (!isNum(value)) {
      setShown(null)
      from.current = null
      return
    }
    const start = from.current
    if (reduced || start === null || document.hidden || start === value) {
      from.current = value
      setShown(value)
      return
    }
    const t0 = performance.now()
    const tick = (t: number) => {
      const k = Math.min(1, (t - t0) / (duration * 1000))
      const e = 1 - Math.pow(1 - k, 3)
      const v = start + (value - start) * e
      from.current = v
      setShown(v)
      if (k < 1) raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current)
    }
  }, [value, reduced, duration])
  if (shown === null) return <span className={className}>—</span>
  return <span className={className}>{format(shown)}</span>
}

// ------------------------------------------------------------------------------------------------------- a meter row
export function Meter({
  label,
  value,
  max,
  text,
  color = 'var(--fg-muted)',
  warnAt,
  title,
}: {
  label: string
  value: number | null | undefined
  max: number
  text: React.ReactNode
  color?: string
  warnAt?: number
  title?: string
}) {
  const warn = isNum(value) && isNum(warnAt) && value >= warnAt
  return (
    <div className="grid grid-cols-[3.25rem_1fr_auto] items-center gap-3" title={title}>
      <span className="text-[11px] font-medium uppercase tracking-wider text-faint">{label}</span>
      <Bar value={value} max={max} color={warn ? 'var(--warn)' : color} height={6} label={`${label}: ${typeof text === 'string' ? text : ''}`} />
      <span className={cn('num min-w-[4.5rem] text-right text-[13px]', warn ? 'text-warn' : 'text-fg')}>{text}</span>
    </div>
  )
}
