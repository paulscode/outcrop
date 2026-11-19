// The chat page's pure logic: the answer stream reducer, citations, tool blocks placed in the answer, the sidebar's
// grouping and ordering, search highlights and site monograms.  No React, no fetch: all of it is unit-tested.

import type { Chat, Message, MessageStats, MessageStatus, Source, StreamEvent, ToolCall, TurnResult } from './types'

// ------------------------------------------------------------------------------------------------ the answer stream
export type LivePhase = 'waiting' | 'thinking' | 'writing' | 'tool' | 'ended'

export interface LiveAnswer {
  message_id: string | null
  content: string
  reasoning: string
  tools: ToolCall[]
  sources: Source[]
  /** the engine request of the current round (one per tool round) */
  rid: string | null
  /** when that request began (seconds), for the phase line */
  ridAt: number | null
  status: MessageStatus | 'idle'
  error: string | null
  stats: MessageStats | null
  phase: LivePhase
  /** text since the stream began, for a live rate */
  deltas: number
  firstAt: number | null
  writingAt: number | null
  ended: boolean
  /** this browser's clock minus the server's (seconds): the server's times (rid_at, a tool's start) are moved by it */
  skew: number
}

export const emptyLive = (): LiveAnswer => ({
  message_id: null,
  content: '',
  reasoning: '',
  tools: [],
  sources: [],
  rid: null,
  ridAt: null,
  status: 'streaming',
  error: null,
  stats: null,
  phase: 'waiting',
  deltas: 0,
  firstAt: null,
  writingAt: null,
  ended: false,
  skew: 0,
})

function toolPhase(tools: ToolCall[]): boolean {
  return tools.some((t) => t.state === 'running' || t.state === 'waiting')
}

/**
 * A tool event into the list: it updates the newest call with its id, unless that one has finished and this one is
 * running again (an engine may reuse an id in a later round): then it is a new call.
 */
export function upsertTool(tools: ToolCall[], t: ToolCall): ToolCall[] {
  let i = -1
  for (let j = tools.length - 1; j >= 0; j--) {
    if (tools[j].id === t.id) {
      i = j
      break
    }
  }
  const live = (x: ToolCall) => x.state === 'running' || x.state === 'waiting'
  if (i < 0 || (!live(tools[i]) && live(t))) return [...tools, t]
  return tools.map((x, j) => (j === i ? { ...x, ...t } : x))
}

/** A tool call with its start on this browser's clock. */
function onOurClock(t: ToolCall, skew: number): ToolCall {
  return skew && typeof t.started === 'number' ? { ...t, started: t.started + skew } : t
}

/**
 * The clocks' difference from the server's time as the stream's response gave it (its Date header: whole seconds, so
 * a difference under 2 s is noise and counts as none).
 */
function skewFrom(serverNow: number | null | undefined, now: number, before: number): number {
  if (typeof serverNow !== 'number') return before
  const d = now - serverNow
  return Math.abs(d) < 2 ? 0 : d
}

/** Fold one stream event into the answer.  The snapshot replaces everything; deltas append; tools upsert by id. */
export function reduceStream(s: LiveAnswer, ev: StreamEvent, now: number): LiveAnswer {
  switch (ev.type) {
    case 'snapshot': {
      const tools = ev.tools ?? []
      const status = ev.status ?? 'streaming'
      // a run that has just ended (it is still listed while it saves): nothing more will come
      const over = status !== 'streaming'
      const phase: LivePhase = over ? 'ended' : toolPhase(tools) ? 'tool' : ev.content ? 'writing' : ev.reasoning ? 'thinking' : 'waiting'
      const skew = skewFrom(ev.server_now, now, s.skew)
      return {
        ...emptyLive(),
        message_id: ev.message_id,
        content: ev.content ?? '',
        reasoning: ev.reasoning ?? '',
        tools: tools.map((t) => onOurClock(t, skew)),
        sources: ev.sources ?? [],
        rid: ev.rid ?? null,
        // the server's time of that request, on our clock: the phase timer survives a reload
        ridAt: typeof ev.rid_at === 'number' ? ev.rid_at + skew : s.rid === ev.rid && s.ridAt ? s.ridAt : now,
        skew,
        status,
        // a run that has just failed: its reason, when the snapshot has it (else the reload brings it)
        error: status === 'error' ? (ev.error ?? null) : null,
        phase,
        ended: over,
        firstAt: ev.content || ev.reasoning ? now : null,
        writingAt: ev.content ? now : null,
      }
    }
    case 'request':
      // it arrives as it is sent: our clock is right for it, and its server time measures the clocks' difference
      return { ...s, rid: ev.rid, ridAt: now, skew: typeof ev.at === 'number' ? now - ev.at : s.skew, phase: toolPhase(s.tools) ? 'tool' : 'waiting' }
    case 'delta': {
      const out = { ...s }
      if (ev.reasoning) {
        out.reasoning = s.reasoning + ev.reasoning
        out.phase = 'thinking'
      }
      if (ev.content) {
        out.content = s.content + ev.content
        out.phase = 'writing'
        if (out.writingAt === null) out.writingAt = now
      }
      if (ev.reasoning || ev.content) {
        out.deltas = s.deltas + 1
        if (out.firstAt === null) out.firstAt = now
      }
      return out
    }
    case 'tool': {
      const tools = upsertTool(s.tools, onOurClock(ev.tool, s.skew))
      return { ...s, tools, phase: toolPhase(tools) ? 'tool' : s.phase === 'tool' ? 'waiting' : s.phase }
    }
    case 'sources':
      return { ...s, sources: ev.sources ?? [] }
    case 'done':
    case 'stopped':
      return { ...s, status: ev.type, stats: ev.stats ?? s.stats, phase: 'ended', ended: true }
    case 'error':
      return { ...s, status: 'error', error: ev.error, phase: 'ended', ended: true }
    case 'idle':
      return { ...s, status: 'idle', phase: 'ended', ended: true }
    default:
      return s
  }
}

/** A message with the live answer laid over it (what the screen shows while it is being written). */
export function withLive(m: Message, live: LiveAnswer | null): Message {
  if (!live || live.message_id !== m.id || live.status === 'idle') return m
  return {
    ...m,
    content: live.content,
    reasoning: live.reasoning,
    tools: live.tools,
    sources: live.sources.length ? live.sources : m.sources,
    status: live.ended ? (live.status as MessageStatus) : 'streaming',
    // a failure seen only in a snapshot has no reason yet: say so until the reload brings it
    error: live.error ?? m.error ?? (live.ended && live.status === 'error' ? 'The answer failed.' : null),
    stats: live.stats ?? m.stats,
  }
}

// ------------------------------------------------------------------------------------------------------ citations
const FENCE = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$))/g
const INLINE_CODE = /(`+[^`\n]*`+)/g
const CITE = /(?<![!\\])\[(\d{1,3}(?:\s*[,;]\s*\d{1,3})*)\](?![(:])/g

/** Apply `fn` to the parts of Markdown that are not code (fenced blocks or inline code). */
function outsideCode(text: string, fn: (s: string) => string): string {
  return text
    .split(FENCE)
    .map((part, i) => (i % 2 === 1 ? part : part.split(INLINE_CODE).map((seg, j) => (j % 2 === 1 ? seg : fn(seg))).join('')))
    .join('')
}

/** The citation numbers in an answer, in the order they first appear (outside code). */
export function citedNumbers(text: string): number[] {
  const out: number[] = []
  outsideCode(text, (seg) => {
    for (const m of seg.matchAll(CITE)) {
      for (const n of m[1].split(/\s*[,;]\s*/).map(Number)) if (!out.includes(n)) out.push(n)
    }
    return seg
  })
  return out
}

export const CITE_HREF = '#cite-'

/** Turn [1] and [1, 2] into links the Markdown renderer draws as pills; numbers without a source stay as text. */
export function linkCitations(text: string, valid: Set<number>): string {
  if (!valid.size) return text
  return outsideCode(text, (seg) =>
    seg.replace(CITE, (whole, inner: string) => {
      const ns = inner.split(/\s*[,;]\s*/).map(Number)
      if (!ns.every((n) => valid.has(n))) return whole
      return ns.map((n) => `[${n}](${CITE_HREF}${n})`).join('')
    }),
  )
}

/** The citation number in a link the renderer got from linkCitations (the sanitizer may prefix the fragment). */
export function citeOf(href: string | undefined | null): number | null {
  const m = href ? /#(?:user-content-)?cite-(\d+)$/.exec(href) : null
  return m ? Number(m[1]) : null
}

/** The sources the answer cites, for the row under it: the pages it read first, then by number. */
export function citedSources(content: string, sources: Source[]): Source[] {
  const cited = new Set(citedNumbers(content))
  return sources
    .filter((s) => cited.has(s.n))
    .sort((a, b) => Number(!!b.opened || b.kind === 'page') - Number(!!a.opened || a.kind === 'page') || a.n - b.n)
}

// ------------------------------------------------------------------------------------------------ tool blocks in text
export type Part = { kind: 'text'; text: string; key: string } | { kind: 'tools'; tools: ToolCall[]; key: string }

/**
 * The answer cut where its tool calls happened (`at`, in characters), so each call is drawn where it ran.  A cut that
 * falls inside a line moves to the end of that line, so Markdown is never split mid-paragraph; calls at the same place
 * form one group.
 */
export function interleave(content: string, tools: ToolCall[]): Part[] {
  if (!tools.length) return content ? [{ kind: 'text', text: content, key: 't0' }] : []
  const snap = (at: number) => {
    let i = Math.max(0, Math.min(content.length, Math.round(at || 0)))
    if (i > 0 && i < content.length && content[i - 1] !== '\n') {
      const nl = content.indexOf('\n', i)
      i = nl < 0 ? content.length : nl + 1
    }
    return i
  }
  const sorted = tools.map((t, order) => ({ t, at: snap(t.at), order })).sort((a, b) => a.at - b.at || a.order - b.order)
  const parts: Part[] = []
  let pos = 0
  for (const { t, at } of sorted) {
    if (at > pos) {
      const text = content.slice(pos, at)
      if (text.trim()) parts.push({ kind: 'text', text, key: `t${pos}` })
      pos = at
    }
    const last = parts[parts.length - 1]
    if (last && last.kind === 'tools' && last.key === `g${at}`) last.tools.push(t)
    else parts.push({ kind: 'tools', tools: [t], key: `g${at}` })
  }
  if (pos < content.length) {
    const text = content.slice(pos)
    if (text.trim()) parts.push({ kind: 'text', text, key: `t${pos}` })
  }
  return parts
}

/** How long "ask before opening pages" waits for your answer before it counts as a no (the server's limit). */
export const WAIT_S = 300

/** When a waiting page counts as declined (seconds): from when the call began, else from when this page first saw it. */
export function waitDeadline(t: ToolCall, seen: number): number {
  return (t.started ?? seen) + WAIT_S
}

/** The line for a tool call: the server's summary when it has one, else what it is doing. */
export function toolLine(t: ToolCall): string {
  if (t.summary) return t.summary
  const host = t.args.url ? hostOf(t.args.url) : ''
  if (t.name === 'web_search') return t.state === 'running' ? `Searching “${t.args.query ?? ''}”…` : `Searched “${t.args.query ?? ''}”`
  if (t.name === 'open_page') {
    if (t.state === 'waiting') return `Open ${host || 'a page'}?`
    if (t.state === 'running') return `Reading ${host || 'a page'}…`
    if (t.state === 'declined') return `Declined ${host || 'a page'}`
    if (t.state === 'refused') return `Refused a link to ${host || 'a page'}`
    return `Read ${host}`
  }
  return t.name
}

// --------------------------------------------------------------------------------------------------------- sidebar
export type DateGroup = 'Today' | 'Yesterday' | 'This week' | 'Earlier'

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000
}

export function dateGroup(ts: number, now: Date): DateGroup {
  const today = startOfDay(now)
  if (ts >= today) return 'Today'
  if (ts >= today - 86400) return 'Yesterday'
  if (ts >= today - 6 * 86400) return 'This week'
  return 'Earlier'
}

/** Chats by when they were last used, newest first, as Today / Yesterday / This week / Earlier (empty groups left out). */
export function groupByDate(chats: Chat[], now = new Date()): Array<{ label: DateGroup; chats: Chat[] }> {
  const order: DateGroup[] = ['Today', 'Yesterday', 'This week', 'Earlier']
  const by = new Map<DateGroup, Chat[]>(order.map((k) => [k, []]))
  for (const c of [...chats].sort((a, b) => b.updated_at - a.updated_at)) by.get(dateGroup(c.updated_at, now))!.push(c)
  return order.filter((k) => by.get(k)!.length).map((label) => ({ label, chats: by.get(label)! }))
}

/** Insert or replace a chat in a list, newest first. */
export function upsertChat(list: Chat[], c: Chat): Chat[] {
  const out = list.filter((x) => x.id !== c.id)
  out.push(c)
  return out.sort((a, b) => b.updated_at - a.updated_at)
}

/** The chats between two (inclusive) in the order on screen: ⇧-click selection. */
export function rangeIds(order: string[], anchor: string, target: string): string[] {
  const a = order.indexOf(anchor)
  const b = order.indexOf(target)
  if (a < 0 || b < 0) return [target]
  const [lo, hi] = a <= b ? [a, b] : [b, a]
  return order.slice(lo, hi + 1)
}

/** Move `id` to the place of `over` (reordering spaces by dragging). */
export function reorder(ids: string[], id: string, over: string, after = false): string[] {
  if (id === over) return ids
  const rest = ids.filter((x) => x !== id)
  const i = rest.indexOf(over)
  if (i < 0) return ids
  rest.splice(after ? i + 1 : i, 0, id)
  return rest
}

/** The messages after a new turn: the branch up to the new question's parent (or the answer's), then the new ones. */
export function applyTurn(messages: Message[], res: TurnResult): Message[] {
  const fresh = (m: Message): Message => ({ ...m, versions: m.versions ?? { index: 0, count: 1, ids: [m.id] } })
  const anchor = res.user ? res.user.parent_id : res.assistant.parent_id
  const i = anchor ? messages.findIndex((m) => m.id === anchor) : -1
  const kept = messages.slice(0, i + 1)
  return res.user ? [...kept, fresh(res.user), fresh(res.assistant)] : [...kept, fresh(res.assistant)]
}

// ---------------------------------------------------------------------------------------------------------- search
/** A snippet cut into plain and highlighted pieces (ranges may overlap or come unsorted). */
/**
 * The search's highlight ranges count characters (code points, as the server's Python does); JavaScript strings count
 * UTF-16 units, so every emoji or other character outside the BMP before a match would shift it.  Convert.
 */
export function codePointRanges(text: string, ranges: Array<[number, number]>): Array<[number, number]> {
  if (!/[\uD800-\uDBFF]/.test(text)) return ranges
  const unit: number[] = [] // code point index -> UTF-16 offset
  let u = 0
  for (const ch of text) {
    unit.push(u)
    u += ch.length
  }
  unit.push(u)
  const at = (i: number) => unit[Math.max(0, Math.min(i, unit.length - 1))]
  return ranges.map(([a, b]) => [at(a), at(b)] as [number, number])
}

export function splitHighlights(text: string, ranges: Array<[number, number]>): Array<{ text: string; hit: boolean }> {
  const rs = codePointRanges(text, ranges)
    .map(([a, b]) => [Math.max(0, Math.min(a, text.length)), Math.max(0, Math.min(b, text.length))] as [number, number])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0])
  const merged: Array<[number, number]> = []
  for (const r of rs) {
    const last = merged[merged.length - 1]
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
    else merged.push([...r])
  }
  const out: Array<{ text: string; hit: boolean }> = []
  let pos = 0
  for (const [a, b] of merged) {
    if (a > pos) out.push({ text: text.slice(pos, a), hit: false })
    out.push({ text: text.slice(a, b), hit: true })
    pos = b
  }
  if (pos < text.length) out.push({ text: text.slice(pos), hit: false })
  return out
}

/** How `in:` names a space: lower case, letters, digits and _ only ("Home lab" -> "homelab"), as the server compares. */
export function spaceSlug(name: string): string {
  return name.toLowerCase().replace(/[^\p{L}\p{N}_]/gu, '')
}

/** The search text without its `in:NAME` part, and that part. */
export function splitQuery(q: string): { text: string; space: string | null } {
  const m = /(?:^|\s)in:(\S*)/.exec(q)
  if (!m) return { text: q.trim(), space: null }
  return { text: (q.slice(0, m.index) + q.slice(m.index + m[0].length)).trim(), space: m[1] }
}

// ------------------------------------------------------------------------------------------------------ monograms
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url.replace(/^[a-z]+:\/\//i, '').split(/[/?#]/)[0].replace(/^www\./, '')
  }
}

export const MONOGRAM_TONES = 6

/** A site's letter and colour, made from its name: no icon is fetched (that would tell the site you looked). */
export function monogram(domain: string): { letter: string; tone: number } {
  const d = domain.toLowerCase().replace(/^www\./, '')
  const parts = d.split('.').filter(Boolean)
  // the registrable-ish part: "en.wikipedia.org" -> "wikipedia", "diy.stackexchange.com" -> "stackexchange"
  const core = parts.length >= 2 ? parts[parts.length - 2] : (parts[0] ?? '?')
  const short = core.length <= 3 && parts.length >= 3 ? parts[parts.length - 3] : core
  const letter = (short.match(/[\p{L}\p{N}]/u)?.[0] ?? '?').toUpperCase()
  let h = 0
  for (const ch of d) h = (h * 31 + ch.codePointAt(0)!) >>> 0
  return { letter, tone: h % MONOGRAM_TONES }
}

// ------------------------------------------------------------------------------------------------- context meter
export type ContextLevel = 'ok' | 'warn' | 'full'

export function contextLevel(used: number, max: number | null | undefined): ContextLevel {
  if (!max || max <= 0) return 'ok'
  const f = used / max
  return f >= 0.9 ? 'full' : f >= 0.75 ? 'warn' : 'ok'
}

/** 18432 -> "18K", 950 -> "950" */
export function kTokens(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  return `${Math.round(n / 1000)}K`
}

/** The first line of a question, as the title before one is written. */
export function firstLine(text: string, max = 80): string {
  const line = text.trim().split('\n')[0].trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

// ------------------------------------------------------------------------------------------------------- links
/** A link from the web or the model, as an href only when it is http(s); anything else is shown as text. */
export { safeHref } from '../links'

// ------------------------------------------------------------------------------------------------- the chat list
/**
 * A fresh first page of the list, keeping the older chats "Show older chats" loaded before: they are older than the
 * whole page, so the page cannot know about them (deleted ones leave through the live `chat.deleted` events).
 */
export function mergeFirstPage(
  prev: { chats: Chat[]; more: boolean; older?: boolean } | undefined,
  page: Chat[],
  pageSize: number,
): { chats: Chat[]; more: boolean; older?: boolean } {
  const more = page.length >= pageSize
  if (!prev?.older || !more) return { chats: page, more }
  const oldest = Math.min(...page.map((c) => c.updated_at))
  const ids = new Set(page.map((c) => c.id))
  const kept = prev.chats.filter((c) => !ids.has(c.id) && c.updated_at < oldest)
  return { chats: [...page, ...kept], more: prev.more, older: true }
}
