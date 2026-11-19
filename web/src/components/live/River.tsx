import { useEffect, useMemo, useRef, useState } from 'react'
import { engineStore, metricsStore, riverStore } from '@/lib/live'
import { PHASE_COLOR, PHASE_LABEL, packRows, segments, type Seg } from '@/lib/phases'
import { activeRid, endOf, inflightList } from '@/lib/requests'
import { useStore } from '@/lib/store'
import type { Flight } from '@/lib/types'
import { useReducedMotion } from '@/lib/utils'

const WINDOW = 300 // seconds shown
const ROW = 16
const GAP = 5
const MAX_ROWS = 9

/** The time, updated every animation frame (about 30 a second), or once a second with reduced motion. */
function useFrameNow(): number {
  const reduced = useReducedMotion()
  const [now, setNow] = useState(() => Date.now() / 1000)
  useEffect(() => {
    if (reduced) {
      const id = setInterval(() => setNow(Date.now() / 1000), 1000)
      return () => clearInterval(id)
    }
    let raf = 0
    let last = 0
    const tick = (t: number) => {
      if (t - last > 33) {
        last = t
        setNow(Date.now() / 1000)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [reduced])
  return now
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [w, setW] = useState(800)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setW(Math.max(200, e.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w] as const
}

interface Item {
  f: Flight
  start: number
  end: number
  segs: Seg[]
  live: boolean
}

/**
 * The request river: the last five minutes, each request a band from the app that sent it, coloured by what was
 * happening (waiting, reading the prompt, thinking, answering); refusals as rose ticks on the top line.
 */
export function River({ onPick }: { onPick: (f: Flight) => void }) {
  const river = useStore(riverStore)
  const engineState = useStore(metricsStore, (m) => m.latest?.engine?.state ?? null)
  const liveElapsed = useStore(engineStore, (e) => e?.live?.elapsed_s ?? null)
  const now = useFrameNow()
  const [ref, width] = useWidth<HTMLDivElement>()
  const left = 0
  const x = (t: number) => left + ((t - (now - WINDOW)) / WINDOW) * (width - left)

  const { items, denied, rows } = useMemo(() => {
    const t0 = now - WINDOW
    const rid = activeRid(river)
    const reading = engineState === 'reading' || engineState === 'prefill'
    const lastEnd = river.recent.reduce((m, r) => Math.max(m, endOf(r)), 0)
    const all: Item[] = []
    for (const f of inflightList(river)) {
      const isActive = f.rid === rid && reading && !f.first_token_at
      const since = isActive && liveElapsed ? now - liveElapsed : lastEnd || undefined
      all.push({ f, start: f.started_at, end: now, segs: segments(f, now, isActive, since), live: true })
    }
    for (const f of river.recent) {
      if (endOf(f) < t0) continue
      all.push({ f, start: f.started_at, end: endOf(f), segs: segments(f, now), live: false })
    }
    const packed = packRows(all, 1).filter((i) => i.row < MAX_ROWS)
    const rows = Math.max(3, packed.reduce((m, i) => Math.max(m, i.row + 1), 0))
    const denied = river.denied.filter((d) => (d.ended_at ?? d.started_at) >= t0)
    return { items: packed, denied, rows }
    // `now` changes every frame; the packing only needs the second
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [river, engineState, liveElapsed, Math.floor(now)])

  const height = 22 + rows * (ROW + GAP) + 20
  const ticks = [0, 60, 120, 180, 240]
  return (
    <div ref={ref} className="relative w-full select-none">
      <svg width={width} height={height} className="block" role="img" aria-label={`Requests over the last five minutes: ${items.length} shown, ${denied.length} refused`}>
        {/* minute grid */}
        {ticks.map((s) => {
          const tx = x(now - WINDOW + s + ((60 - ((now - WINDOW + s) % 60)) % 60))
          return <line key={s} x1={tx} x2={tx} y1={14} y2={height - 18} stroke="var(--grid)" strokeWidth={1} />
        })}
        {/* refusals on the top line */}
        <line x1={0} x2={width} y1={8} y2={8} stroke="var(--line)" strokeWidth={1} />
        {denied.map((d) => {
          const dx = x(d.ended_at ?? d.started_at)
          return (
            <g key={d.rid} onClick={() => onPick(d)} className="cursor-pointer">
              <title>{`${d.app ?? 'unknown'} from ${d.client_ip}: refused (${d.reason ?? d.status})`}</title>
              <path d={`M${dx} 3 L${dx + 4} 8 L${dx} 13 L${dx - 4} 8 Z`} fill="var(--error)" />
            </g>
          )
        })}
        {items.map((it) => {
          const y = 22 + it.row * (ROW + GAP)
          const end = it.live ? now : it.end
          const bx = Math.max(0, x(it.start))
          const bw = Math.max(2, x(end) - bx)
          const label = it.f.app ?? 'unknown'
          return (
            <g key={it.f.rid} onClick={() => onPick(it.f)} className="cursor-pointer">
              <title>{`${label}${it.f.token ? ` (${it.f.token})` : ''}: ${it.segs.map((s) => `${PHASE_LABEL[s.key]} ${Math.round(s.end - s.start)} s`).join(', ')}`}</title>
              {it.segs.map((s, i) => {
                const sx = Math.max(0, x(s.start))
                const se = it.live && i === it.segs.length - 1 ? now : s.end
                const sw = Math.max(1, x(se) - sx)
                return (
                  <rect
                    key={i}
                    x={sx}
                    y={y}
                    width={sw}
                    height={ROW}
                    rx={3}
                    fill={PHASE_COLOR[s.key]}
                    opacity={s.key === 'waiting' ? 0.32 : it.live ? 0.95 : 0.7}
                  />
                )
              })}
              {it.live ? <rect x={bx + bw - 2} y={y} width={2} height={ROW} fill="var(--fg)" opacity={0.85} /> : null}
              {bw > 64 ? (
                <text x={bx + 6} y={y + ROW / 2 + 3.5} fontSize={10.5} fontWeight={600} fill="var(--bg)" className="pointer-events-none">
                  {label.length > bw / 7 ? `${label.slice(0, Math.max(2, Math.floor(bw / 7) - 1))}…` : label}
                </text>
              ) : null}
            </g>
          )
        })}
        {/* the time axis */}
        {[0, 1, 2, 3, 4].map((m) => (
          <text key={m} x={x(now - m * 60) - (m === 0 ? 0 : 0)} y={height - 4} fontSize={10} fill="var(--fg-faint)" textAnchor={m === 0 ? 'end' : 'middle'} className="num">
            {m === 0 ? 'now' : `−${m} min`}
          </text>
        ))}
      </svg>
      {!items.length && !denied.length ? (
        <p className="pointer-events-none absolute inset-0 flex items-center justify-center text-[13px] text-faint">No requests in the last five minutes.</p>
      ) : null}
    </div>
  )
}
