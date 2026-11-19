// A request's life as phases on a time line: held at the gateway, waiting its turn, reading the prompt, thinking,
// answering.  From the gateway's timestamps and the engine's figures; reading is worked out from the prompt size and the
// measured reading speed when the request has finished.

import type { Flight } from './types'

export type PhaseKey = 'held' | 'waiting' | 'reading' | 'thinking' | 'answering'

export interface Seg {
  key: PhaseKey
  start: number
  end: number
}

export const PHASE_LABEL: Record<PhaseKey, string> = {
  held: 'held for a switch',
  waiting: 'waiting its turn',
  reading: 'reading the prompt',
  thinking: 'thinking',
  answering: 'answering',
}

export const PHASE_COLOR: Record<PhaseKey, string> = {
  held: 'var(--warn)',
  waiting: 'var(--fg-faint)',
  reading: 'var(--read)',
  thinking: 'var(--think)',
  answering: 'var(--answer)',
}

/**
 * The phases of one request.  `readingNow`: the engine is reading this request's prompt at the moment (in flight only);
 * `readingSince`: when it started (the previous request's end, if known).
 */
export function segments(f: Flight, now: number, readingNow = false, readingSince?: number): Seg[] {
  const out: Seg[] = []
  const start = f.started_at
  const end = f.ended_at ?? now
  let t = start
  const heldS = f.held_ms ? f.held_ms / 1000 : f.phase === 'held' ? end - start : 0
  if (heldS > 0) {
    out.push({ key: 'held', start: t, end: Math.min(end, t + heldS) })
    t += heldS
  }
  // Not streamed: the gateway sees the whole answer at once, so place answering and reading back from the end with the
  // engine's own speeds (thinking is inside answering here)
  const notStreamed = f.stream === false || f.stream === 0
  if (notStreamed && f.ended_at && (f.decode_tok_s || f.prefill_tok_s)) {
    const outTok = f.output_tokens ?? 0
    const ansS = f.decode_tok_s && outTok ? outTok / f.decode_tok_s : 0
    const read = Math.max(0, (f.prompt_tokens ?? 0) - (f.reused_tokens ?? 0))
    const readS = f.prefill_tok_s && read ? read / f.prefill_tok_s : 0
    const ansStart = Math.max(t, end - ansS)
    const readStart = Math.max(t, ansStart - readS)
    if (readStart > t + 0.05) out.push({ key: 'waiting', start: t, end: readStart })
    if (ansStart > readStart) out.push({ key: 'reading', start: readStart, end: ansStart })
    if (end > ansStart) out.push({ key: 'answering', start: ansStart, end })
    return out
  }
  // rows from the log have the first-token time (ttft_ms, counted from when the gateway passed the request on, after any
  // hold) and the thinking time rather than timestamps
  const first =
    f.first_token_at ?? (typeof f.ttft_ms === 'number' && f.ended_at ? Math.min(f.ended_at, start + heldS + f.ttft_ms / 1000) : null)
  if (first && first > t) {
    // reading time: prompt tokens not reused, at the request's reading speed
    const read = Math.max(0, (f.prompt_tokens ?? 0) - (f.reused_tokens ?? 0))
    const readS = f.prefill_tok_s && read ? read / f.prefill_tok_s : null
    const readStart = readS !== null ? Math.max(t, first - readS) : t
    if (readStart > t + 0.05) out.push({ key: 'waiting', start: t, end: readStart })
    out.push({ key: 'reading', start: readStart, end: first })
    t = first
  } else if (!first && !f.ended_at) {
    // in flight, no token yet
    if (readingNow) {
      const rs = Math.max(t, readingSince ?? t)
      if (rs > t + 0.05) out.push({ key: 'waiting', start: t, end: rs })
      out.push({ key: 'reading', start: rs, end })
    } else if (f.phase !== 'held') out.push({ key: 'waiting', start: t, end })
    return out
  } else if (!first && f.ended_at) {
    if (end > t) out.push({ key: 'waiting', start: t, end })
    return out
  }
  const answerAt = f.answer_at ?? (first && typeof f.think_ms === 'number' && f.think_ms > 0 ? first + f.think_ms / 1000 : null)
  if (answerAt && answerAt > t && (f.think_tokens || f.think_ms || answerAt - t > 0.2)) {
    out.push({ key: 'thinking', start: t, end: Math.min(end, answerAt) })
    t = answerAt
  } else if (!answerAt && f.phase === 'thinking') {
    out.push({ key: 'thinking', start: t, end })
    return out
  }
  if (end > t) out.push({ key: 'answering', start: t, end })
  return out
}

/** Durations by phase, for the drawer's summary. */
export function phaseDurations(segs: Seg[]): Partial<Record<PhaseKey, number>> {
  const out: Partial<Record<PhaseKey, number>> = {}
  for (const s of segs) out[s.key] = (out[s.key] ?? 0) + (s.end - s.start)
  return out
}

/** Pack intervals into rows (first row where it fits), newest kept on top; for the river chart. */
export function packRows<T extends { start: number; end: number }>(items: T[], gap = 0.5): Array<T & { row: number }> {
  const rowsEnd: number[] = []
  const sorted = [...items].sort((a, b) => a.start - b.start)
  return sorted.map((it) => {
    let r = rowsEnd.findIndex((e) => e + gap <= it.start)
    if (r < 0) {
      r = rowsEnd.length
      rowsEnd.push(it.end)
    } else rowsEnd[r] = it.end
    return { ...it, row: r }
  })
}
