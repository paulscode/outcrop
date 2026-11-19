// The Timeline: event kinds grouped into families (for icons and filter chips), days, and plain words for who did it.

import type { EventRow } from './types'

export type FamilyId = 'presets' | 'access' | 'tokens' | 'signins' | 'alerts' | 'bench' | 'console' | 'gateway' | 'other'

export interface Family {
  id: FamilyId
  label: string
  /** the `kind` filter for /api/events: comma-separated, `*` is a wildcard */
  filter: string
  /** kind prefixes that belong to this family */
  prefixes: string[]
}

export const FAMILIES: Family[] = [
  { id: 'presets', label: 'Presets', filter: 'preset.*,presets.*', prefixes: ['preset.', 'presets.', 'switch'] },
  { id: 'access', label: 'Access', filter: 'auth.*', prefixes: ['auth.'] },
  { id: 'tokens', label: 'Tokens', filter: 'token.*', prefixes: ['token.'] },
  { id: 'signins', label: 'Sign-ins', filter: 'signin.*,account.*', prefixes: ['signin.', 'account.'] },
  { id: 'alerts', label: 'Alerts', filter: 'alert.*,alerts.*', prefixes: ['alert.', 'alerts.'] },
  { id: 'bench', label: 'Lab', filter: 'bench.*', prefixes: ['bench.'] },
  { id: 'console', label: 'Console', filter: 'console*,capture.*', prefixes: ['console', 'capture.'] },
  { id: 'gateway', label: 'Gateway', filter: 'gateway.*,hold,release', prefixes: ['gateway.', 'hold', 'release'] },
]

export function familyOf(kind: string): FamilyId {
  const k = (kind || '').toLowerCase()
  for (const f of FAMILIES) {
    if (f.prefixes.some((p) => k.startsWith(p))) return f.id
  }
  return 'other'
}

export function familyById(id: string | undefined | null): Family | undefined {
  return FAMILIES.find((f) => f.id === id)
}

export type EventTone = 'ok' | 'warn' | 'error' | 'info' | 'neutral'

/** How an event reads at a glance: a cleared alert is good news, opening the API is a warning, a failure is an error. */
export function eventTone(e: Pick<EventRow, 'kind' | 'level'>): EventTone {
  const k = e.kind || ''
  if (e.level === 'error') return 'error'
  if (k.endsWith('.clear') || k === 'auth.close' || k === 'gateway.restore') return 'ok'
  if (k === 'signin.fail') return 'warn'
  if (e.level === 'warn') return 'warn'
  if (k.startsWith('alert.')) return 'info'
  return 'neutral'
}

/** "dev from 192.168.1.50", "outcrop over SSH", "the console", "the gateway" */
export function actorWords(actor: string | null | undefined, source: string | null | undefined): string {
  const a = (actor || '').trim()
  const s = (source || '').trim()
  let who: string
  switch (a) {
    case '':
      who = 'the system'
      break
    case 'console':
      who = 'the console'
      break
    case 'gateway':
      who = 'the gateway'
      break
    case 'cli':
      who = 'outcrop'
      break
    case 'system':
      who = 'the system'
      break
    case 'expiry':
      who = 'the clock'
      break
    default:
      who = a
  }
  if (!s) return who
  if (s === 'ssh' || s.startsWith('ssh')) return `${who} over SSH`
  return `${who} from ${s}`
}

export interface DayGroup {
  key: string
  label: string
  events: EventRow[]
}

function localKey(ts: number): string {
  const d = new Date(ts * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' })
const dayFmtYear = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })

export function dayLabel(ts: number, now = Date.now() / 1000): string {
  const key = localKey(ts)
  if (key === localKey(now)) return 'Today'
  if (key === localKey(now - 86400)) return 'Yesterday'
  const d = new Date(ts * 1000)
  return d.getFullYear() === new Date(now * 1000).getFullYear() ? dayFmt.format(d) : dayFmtYear.format(d)
}

/** Events (newest first) grouped by local day, keeping the order. */
export function groupByDay(events: EventRow[], now = Date.now() / 1000): DayGroup[] {
  const out: DayGroup[] = []
  for (const e of events) {
    const key = localKey(e.at)
    let g = out[out.length - 1]
    if (!g || g.key !== key) {
      g = { key, label: dayLabel(e.at, now), events: [] }
      out.push(g)
    }
    g.events.push(e)
  }
  return out
}

/** Merge pages of events (newest first), dropping duplicates by id. */
export function mergeEvents(pages: EventRow[][]): EventRow[] {
  const seen = new Set<number>()
  const out: EventRow[] = []
  for (const p of pages) {
    for (const e of p) {
      if (seen.has(e.id)) continue
      seen.add(e.id)
      out.push(e)
    }
  }
  out.sort((a, b) => b.at - a.at || b.id - a.id)
  return out
}

/** Links an event's details point to, in plain words. */
export function eventLinks(e: EventRow): Array<{ label: string; to: string; search?: Record<string, string>; hash?: string }> {
  const d = (e.details || {}) as Record<string, unknown>
  const out: Array<{ label: string; to: string; search?: Record<string, string>; hash?: string }> = []
  if (typeof d.token_id === 'string') out.push({ label: 'Open the token', to: '/access', search: { token: d.token_id } })
  if (typeof d.rid === 'string') out.push({ label: 'Open the request', to: '/requests', search: { rid: d.rid } })
  const fam = familyOf(e.kind)
  if (fam === 'presets') out.push({ label: 'Presets', to: '/presets' })
  if (fam === 'alerts') out.push({ label: 'Alert rules', to: '/settings', hash: 'alerts' })
  if (fam === 'bench') out.push({ label: 'Lab', to: '/lab' })
  if (fam === 'access' && !out.length) out.push({ label: 'Access', to: '/access' })
  if (e.kind === 'console.hsts' || e.kind === 'console.tls') out.push({ label: 'Certificate', to: '/settings', hash: 'certificate' })
  if (e.kind.startsWith('capture.')) out.push({ label: 'Capture settings', to: '/settings', hash: 'capture' })
  if (e.kind === 'account.password' || e.kind === 'signin.out') out.push({ label: 'Sessions', to: '/settings', hash: 'sessions' })
  return out
}

/** True when the details carry anything worth showing. */
export function hasDetails(e: EventRow): boolean {
  return !!e.details && typeof e.details === 'object' && Object.keys(e.details).length > 0
}

const TS_KEY = /(^at$|_at$|^until$|^since$)/

/** Details as plain rows ("scopes: inference, telemetry"), or null when they are nested and better shown as JSON. */
export function detailRows(d: Record<string, unknown> | null | undefined, fmtTime: (ts: number) => string): Array<[string, string]> | null {
  if (!d || typeof d !== 'object') return null
  const rows: Array<[string, string]> = []
  for (const [k, v] of Object.entries(d)) {
    const key = k.replace(/_/g, ' ')
    if (v === null || v === undefined) rows.push([key, '—'])
    else if (typeof v === 'boolean') rows.push([key, v ? 'yes' : 'no'])
    else if (typeof v === 'number') rows.push([key, TS_KEY.test(k) && v > 1e9 ? fmtTime(v) : String(v)])
    else if (typeof v === 'string') rows.push([key, v])
    else if (Array.isArray(v) && v.every((x) => x === null || ['string', 'number', 'boolean'].includes(typeof x)))
      rows.push([key, v.length ? v.map((x) => String(x)).join(', ') : 'none'])
    else return null
  }
  return rows
}
