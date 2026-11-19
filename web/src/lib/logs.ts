// The Logs page: lines from GET /api/logs and the `logs` topic, kept in order, filtered, capped, with request ids linked.

/** A line as the API sends it: `t` is null for lines read from a file without times. */
export interface RawLine {
  t: number | null
  msg: string
  level?: string | null
  source?: string
}

export type Level = 'info' | 'warn' | 'error'

export type LogSource = 'strata' | 'gateway' | 'console' | 'bridge' | 'engine'
export type LevelFilter = 'all' | 'warn' | 'error'

export const LOG_SOURCES: Array<{ id: LogSource; label: string; help: string }> = [
  { id: 'strata', label: 'Strata', help: 'The running preset’s systemd unit (outcrop-engine@…): starts, stops, the engine’s own messages' },
  { id: 'gateway', label: 'Gateway', help: 'outcrop-gateway.service: the API on ports 8080 and 11434, tokens, refusals' },
  { id: 'console', label: 'Console', help: 'outcrop-console.service: this console' },
  { id: 'bridge', label: 'Ollama bridge', help: 'outcrop-ollama-bridge.service: Ollama’s API, answered by Strata' },
  { id: 'engine', label: 'Engine log', help: 'The engine’s log file (~/.outcrop/logs/engine-<preset>.log): load phases, per-request lines' },
]

export function isSource(s: unknown): s is LogSource {
  return typeof s === 'string' && LOG_SOURCES.some((x) => x.id === s)
}

export interface LogEntry {
  id: number
  t: number | null
  msg: string
  level: Level
}

export const MAX_LINES = 2000

let nextId = 1
export function toEntries(lines: RawLine[]): LogEntry[] {
  return lines.map((l) => ({ t: typeof l.t === 'number' ? l.t : null, msg: String(l.msg ?? ''), level: normLevel(l.level, String(l.msg ?? '')), id: nextId++ }))
}

const ERR = /\b(error|failed|traceback|exception|fatal)\b/i
const WARN = /\b(warn(ing)?|refused|denied|slow)\b/i

/** The backend sends a level; guess one the same way when it does not. */
export function normLevel(level: unknown, msg: string): Level {
  if (level === 'error' || level === 'warn' || level === 'info') return level
  if (level === 'warning') return 'warn'
  return ERR.test(msg) ? 'error' : WARN.test(msg) ? 'warn' : 'info'
}

/** Append, keep at most `cap` (dropping the oldest), skip a live line that repeats one of the last few. */
export function appendLines(list: LogEntry[], add: LogEntry[], cap = MAX_LINES): LogEntry[] {
  if (!add.length) return list
  const tail = list.slice(-50)
  const fresh = add.filter((a) => !tail.some((b) => b.msg === a.msg && (b.t ?? null) === (a.t ?? null) && b.t != null))
  if (!fresh.length) return list
  const out = list.concat(fresh)
  return out.length > cap ? out.slice(out.length - cap) : out
}

export function passesLevel(l: { level: Level }, f: LevelFilter): boolean {
  if (f === 'all') return true
  if (f === 'error') return l.level === 'error'
  return l.level === 'warn' || l.level === 'error'
}

export function passesQuery(l: { msg: string }, q: string): boolean {
  const s = q.trim().toLowerCase()
  return !s || l.msg.toLowerCase().includes(s)
}

export type Segment = { kind: 'text'; text: string } | { kind: 'rid'; text: string } | { kind: 'mark'; text: string }

const RID = /\breq_[0-9a-f]{12}\b/g

/** Split a message into text, request ids (links) and search matches (highlights). */
export function segments(msg: string, q = ''): Segment[] {
  const parts: Segment[] = []
  let last = 0
  for (const m of msg.matchAll(RID)) {
    const i = m.index ?? 0
    if (i > last) parts.push(...marks(msg.slice(last, i), q))
    parts.push({ kind: 'rid', text: m[0] })
    last = i + m[0].length
  }
  if (last < msg.length) parts.push(...marks(msg.slice(last), q))
  return parts
}

function marks(text: string, q: string): Segment[] {
  const s = q.trim()
  if (!s) return [{ kind: 'text', text }]
  const out: Segment[] = []
  const low = text.toLowerCase()
  const ql = s.toLowerCase()
  let i = 0
  for (;;) {
    const j = low.indexOf(ql, i)
    if (j < 0) break
    if (j > i) out.push({ kind: 'text', text: text.slice(i, j) })
    out.push({ kind: 'mark', text: text.slice(j, j + s.length) })
    i = j + s.length
  }
  if (i < text.length) out.push({ kind: 'text', text: text.slice(i) })
  return out.length ? out : [{ kind: 'text', text }]
}
