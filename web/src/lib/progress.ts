// Prompt-reading progress (prefill) for the request the engine is on: how far, how fast, how long is left.
// From the 1 s samples (engine.prompt_read / prompt_total) when the engine reports them; otherwise an estimate from the
// prompt's size, the time spent and the preset's measured reading speed, clearly marked as one.

import { useMemo } from 'react'
import { isNum } from './format'
import { engineStore, metricsStore } from './live'
import { usePresets } from './queries'
import { useStore } from './store'
import type { MetricsSample } from './types'

export interface Prefill {
  reading: boolean
  read: number | null
  total: number | null
  fraction: number | null
  speed: number | null
  left: number | null
  elapsed: number | null
  estimated: boolean
}

const NONE: Prefill = { reading: false, read: null, total: null, fraction: null, speed: null, left: null, elapsed: null, estimated: false }

/** Prefill progress from the recent samples (pure, for tests). */
export function prefillFrom(
  history: MetricsSample[],
  live: { prompt_tokens?: number | null; elapsed_s?: number | null; state?: string } | null | undefined,
  measuredSpeed: number | null,
): Prefill {
  const last = history[history.length - 1]
  const st = (last?.engine?.state || '').toLowerCase()
  if (!last || !(st === 'reading' || st === 'prefill')) return NONE
  const total = last.engine.prompt_total ?? live?.prompt_tokens ?? null
  const read = last.engine.prompt_read ?? null
  // how long it has been reading: the run of reading samples, or the engine's own figure if longer
  let start = last.t
  for (let i = history.length - 1; i >= 0; i--) {
    const s2 = (history[i].engine?.state || '').toLowerCase()
    if (s2 !== 'reading' && s2 !== 'prefill') break
    start = history[i].t
  }
  const elapsedAll = Math.max(last.t - start, live?.elapsed_s ?? 0) || null
  // an engine that reports no position mid-prompt (0 or null) is estimated below instead
  if (isNum(read) && isNum(total) && total > 0 && (read > 0 || (elapsedAll ?? 0) < 2)) {
    // speed over the last ~15 s of samples of this same prompt
    let speed: number | null = null
    for (let i = history.length - 2; i >= 0 && last.t - history[i].t <= 15; i--) {
      const s = history[i]
      if (s.engine.prompt_total !== total || !isNum(s.engine.prompt_read)) break
      const dt = last.t - s.t
      if (dt >= 2 && read > s.engine.prompt_read) speed = (read - s.engine.prompt_read) / dt
    }
    speed = speed ?? measuredSpeed
    return {
      reading: true,
      read,
      total,
      fraction: Math.min(1, read / total),
      speed,
      left: speed ? Math.max(0, (total - read) / speed) : null,
      elapsed: elapsedAll,
      estimated: false,
    }
  }
  // The engine did not report its position: estimate it from the time spent at the measured speed.
  const elapsed = elapsedAll
  if (isNum(total) && isNum(elapsed) && measuredSpeed) {
    const est = Math.min(total * 0.99, elapsed * measuredSpeed)
    return {
      reading: true,
      read: est,
      total,
      fraction: est / total,
      speed: measuredSpeed,
      left: Math.max(0, (total - est) / measuredSpeed),
      elapsed,
      estimated: true,
    }
  }
  return { ...NONE, reading: true, total: isNum(total) ? total : null, elapsed }
}

/** The running preset's measured prompt-reading speed (the doc4k case of its benchmark). */
export function useMeasuredPrefill(): number | null {
  const { data } = usePresets()
  const cur = data?.presets.find((p) => p.running)
  return cur?.measured?.doc4k?.prompt ?? null
}

export function usePrefill(): Prefill {
  const history = useStore(metricsStore, (s) => s.history)
  const live = useStore(engineStore, (e) => e?.live ?? null)
  const measured = useMeasuredPrefill()
  return useMemo(() => prefillFrom(history, live, measured), [history, live, measured])
}
