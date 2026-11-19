// The request river: in-flight requests and recent finishes, kept from the gateway's events on the `requests` topic
// (request.start | held | first_byte | progress | end | stats, and the requests.snapshot on subscribe) and refusals
// on the `auth` topic.

import type { AuthFail, Flight, RequestRow } from './types'

export const RECENT_MAX = 200
export const DENIED_MAX = 100

export interface RiverState {
  inflight: Record<string, Flight>
  recent: Flight[] // newest first
  denied: Flight[] // newest first: refusals (401/403/429) as finished lanes
  seq: number
}

export const emptyRiver: RiverState = { inflight: {}, recent: [], denied: [], seq: 0 }

type Ev = Record<string, unknown> & { type?: string; rid?: string }

const STRIP = new Set(['type', 'seq'])

function clean(ev: Ev): Partial<Flight> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(ev)) if (!STRIP.has(k)) out[k] = v
  return out as Partial<Flight>
}

/** Apply one live message (topic `requests`, `requests.snapshot` or `auth`). Returns the same object when nothing changed. */
export function reduceRiver(s: RiverState, topic: string, d: unknown, at?: number): RiverState {
  if (topic === 'requests.snapshot') {
    const snap = d as { inflight?: Flight[]; recent?: Flight[] }
    const inflight: Record<string, Flight> = {}
    for (const f of snap.inflight ?? []) {
      const { type: _t, seq: _s, ...rest } = f as Flight & { type?: string; seq?: number }
      inflight[f.rid] = rest as Flight
    }
    // in flight: the snapshot is the truth; finished: merged with what is already known (the log seed, an earlier
    // connection), since finished requests do not change
    const byRid = new Map<string, Flight>()
    for (const f of s.recent) byRid.set(f.rid, f)
    for (const f of snap.recent ?? []) byRid.set(f.rid, { ...byRid.get(f.rid), ...(clean(f as unknown as Ev) as Flight) })
    for (const rid of Object.keys(inflight)) byRid.delete(rid)
    const recent = [...byRid.values()].sort((a, b) => endOf(b) - endOf(a)).slice(0, RECENT_MAX)
    return { ...s, inflight, recent, seq: s.seq + 1 }
  }
  if (topic === 'auth') {
    const a = d as AuthFail & { type?: string; at?: number }
    const f: Flight = {
      rid: a.rid,
      app: a.app,
      client_ip: a.ip,
      path: a.path,
      listener: a.listener,
      status: a.status,
      reason: a.reason,
      token: a.token,
      started_at: a.at ?? at ?? Date.now() / 1000,
      ended_at: a.at ?? at ?? Date.now() / 1000,
      outcome: 'denied',
      phase: 'done',
      denied: true,
    }
    return { ...s, denied: [f, ...s.denied].slice(0, DENIED_MAX), seq: s.seq + 1 }
  }
  if (topic !== 'requests') return s
  const ev = d as Ev
  const rid = ev.rid
  if (!rid) return s
  const prev = s.inflight[rid]
  switch (ev.type) {
    case 'request.start': {
      const f = { ...(clean(ev) as Flight), phase: (ev.phase as string) ?? 'waiting' }
      return { ...s, inflight: { ...s.inflight, [rid]: f }, seq: s.seq + 1 }
    }
    case 'request.held': {
      if (!prev) return s
      return {
        ...s,
        inflight: { ...s.inflight, [rid]: { ...prev, phase: 'held', held_reason: (ev.reason as string) ?? '' } },
        seq: s.seq + 1,
      }
    }
    case 'request.first_byte': {
      if (!prev) return s
      const phase = prev.phase === 'held' ? 'waiting' : prev.phase
      return { ...s, inflight: { ...s.inflight, [rid]: { ...prev, phase, first_byte_at: ev.at as number } }, seq: s.seq + 1 }
    }
    case 'request.progress': {
      if (!prev) return s
      const { at: _at, ...rest } = clean(ev) as Partial<Flight> & { at?: number }
      return { ...s, inflight: { ...s.inflight, [rid]: { ...prev, ...rest } }, seq: s.seq + 1 }
    }
    case 'request.end': {
      const { [rid]: _gone, ...inflight } = s.inflight
      const done: Flight = { ...(prev ?? {}), ...(clean(ev) as Flight), phase: 'done' }
      if (!done.ended_at) done.ended_at = (ev.at as number) ?? Date.now() / 1000
      const recent = [done, ...s.recent.filter((r) => r.rid !== rid)].slice(0, RECENT_MAX)
      return { ...s, inflight, recent, seq: s.seq + 1 }
    }
    case 'request.stats': {
      const i = s.recent.findIndex((r) => r.rid === rid)
      if (i < 0) return s
      const { at: _at, ...rest } = clean(ev) as Partial<Flight> & { at?: number }
      const recent = s.recent.slice()
      recent[i] = { ...recent[i], ...rest }
      return { ...s, recent, seq: s.seq + 1 }
    }
    default:
      return s
  }
}

/**
 * Merge rows from the request log (GET /api/requests) into the river, for what happened before this page (or the
 * console) started listening: the console keeps its recent list in memory only, so it is empty after a restart.
 * Rows already known from live events are kept as they are (they have more detail).
 */
export function mergeLog(s: RiverState, rows: RequestRow[]): RiverState {
  if (!rows.length) return s
  const known = new Set([...s.recent.map((r) => r.rid), ...s.denied.map((r) => r.rid), ...Object.keys(s.inflight)])
  const add: Flight[] = []
  const addDenied: Flight[] = []
  for (const r of rows) {
    if (known.has(r.rid) || !r.ended_at) continue
    const f: Flight = { ...r, token: r.token_name ?? r.token ?? null, phase: 'done' }
    if (r.auth === 'denied') addDenied.push({ ...f, denied: true, reason: r.auth_reason ?? undefined, outcome: 'denied' })
    else add.push(f)
  }
  if (!add.length && !addDenied.length) return s
  const byEnd = (a: Flight, b: Flight) => endOf(b) - endOf(a)
  return {
    ...s,
    recent: [...s.recent, ...add].sort(byEnd).slice(0, RECENT_MAX),
    denied: [...s.denied, ...addDenied].sort(byEnd).slice(0, DENIED_MAX),
    seq: s.seq + 1,
  }
}

export function endOf(f: Flight): number {
  return f.ended_at ?? f.started_at ?? 0
}

/** In-flight requests in arrival order. */
export function inflightList(s: RiverState): Flight[] {
  return Object.values(s.inflight).sort((a, b) => a.started_at - b.started_at)
}

/** Generating requests: the ones that occupy the engine or wait for it. */
export const GENERATING = new Set(['chat', 'messages', 'responses', 'ollama-chat', 'ollama-generate', 'completions'])

export function isGenerating(f: Flight): boolean {
  return !f.kind || GENERATING.has(f.kind)
}

/**
 * Which in-flight request the engine is working on: the oldest generating request that is past the gateway's hold
 * and has no answer yet (it is reading the prompt), or the one producing tokens.
 */
export function activeRid(s: RiverState): string | null {
  const list = inflightList(s).filter(isGenerating)
  const producing = list.find((f) => f.phase === 'thinking' || f.phase === 'answering')
  if (producing) return producing.rid
  const reading = list.find((f) => f.phase !== 'held')
  return reading ? reading.rid : null
}

/** Finished lanes: recent requests and refusals, newest first. */
export function finished(s: RiverState, limit = 60): Flight[] {
  const all = [...s.recent, ...s.denied]
  all.sort((a, b) => endOf(b) - endOf(a))
  return all.slice(0, limit)
}

/** Decode speed of a finished request: the engine's figure, else output tokens over the answer time. */
export function decodeRate(f: Flight): number | null {
  if (typeof f.decode_tok_s === 'number') return f.decode_tok_s
  if (f.output_tokens && f.first_token_at && f.ended_at && f.ended_at > f.first_token_at) {
    return f.output_tokens / (f.ended_at - f.first_token_at)
  }
  return null
}

/** First-token time in seconds. */
export function firstToken(f: Flight): number | null {
  if (typeof f.ttft_ms === 'number') return f.ttft_ms / 1000
  if (f.first_token_at && f.started_at) return f.first_token_at - f.started_at
  return null
}

/** Live tokens/s of an in-flight request, from its token count and its first token. */
export function liveRate(f: Flight, now = Date.now() / 1000): number | null {
  if (!f.first_token_at || !f.tokens) return null
  const dt = now - f.first_token_at
  if (dt < 0.5) return null
  return f.tokens / dt
}

export function isOk(f: Flight): boolean {
  return !f.denied && (f.outcome === 'ok' || (!f.outcome && (f.status ?? 200) < 400)) && (f.status ?? 200) < 400
}

/** Short words for an outcome. */
export function outcomeText(f: Flight): string {
  if (f.denied) return f.reason || `refused (${f.status})`
  switch (f.outcome) {
    case 'ok':
      return 'done'
    case 'client_gone':
      return 'the client hung up'
    case 'cancelled':
      return 'cancelled'
    case 'held_timeout':
      return 'gave up waiting for the model'
    case 'upstream_down':
      return 'the model was not running'
    case 'denied':
      return 'refused'
    case 'error':
      return f.error || `error ${f.status ?? ''}`.trim()
    default:
      return f.status && f.status >= 400 ? `error ${f.status}` : f.outcome || 'done'
  }
}
