import { describe, expect, it } from 'vitest'
import {
  applyTurn,
  citedNumbers,
  citedSources,
  citeOf,
  contextLevel,
  emptyLive,
  groupByDate,
  interleave,
  kTokens,
  linkCitations,
  monogram,
  rangeIds,
  reduceStream,
  reorder,
  spaceSlug,
  splitHighlights,
  splitQuery,
  toolLine,
  upsertChat,
  withLive,
} from './logic'
import type { Chat, Message, Source, StreamEvent, ToolCall } from './types'

const tool = (id: string, at: number, extra: Partial<ToolCall> = {}): ToolCall => ({
  id,
  name: 'web_search',
  args: { query: id },
  state: 'done',
  at,
  ...extra,
})

const chat = (id: string, updated: number, extra: Partial<Chat> = {}): Chat => ({
  id,
  space_id: null,
  title: id,
  title_source: 'first',
  pinned: false,
  web: true,
  thinking: true,
  head: null,
  suggested_space: null,
  created_at: updated,
  updated_at: updated,
  messages: 2,
  running: false,
  ...extra,
})

const msg = (id: string, parent: string | null, role: Message['role'] = 'user'): Message => ({
  id,
  chat_id: 'c',
  parent_id: parent,
  role,
  content: id,
  reasoning: '',
  images: [],
  tools: [],
  sources: [],
  stats: {},
  status: 'done',
  error: null,
  created_at: 0,
})

describe('the stream reducer', () => {
  const run = (evs: StreamEvent[]) => evs.reduce((s, e, i) => reduceStream(s, e, 100 + i), emptyLive())

  it('starts from the snapshot, then appends deltas', () => {
    const s = run([
      { type: 'snapshot', message_id: 'm1', content: 'Hel', reasoning: 'hmm', tools: [], sources: [], rid: 'r1', status: 'streaming' },
      { type: 'delta', content: 'lo' },
      { type: 'delta', reasoning: '!' },
    ])
    expect(s.message_id).toBe('m1')
    expect(s.content).toBe('Hello')
    expect(s.reasoning).toBe('hmm!')
    expect(s.phase).toBe('thinking')
    expect(s.deltas).toBe(2)
  })

  it('a second snapshot replaces (a reconnect), it never appends', () => {
    const snap: StreamEvent = { type: 'snapshot', message_id: 'm1', content: 'abc', reasoning: '', tools: [], sources: [], rid: 'r1', status: 'streaming' }
    const s = run([snap, { type: 'delta', content: 'd' }, snap])
    expect(s.content).toBe('abc')
    expect(s.phase).toBe('writing')
  })

  it('upserts tools by id, and a new request waits again', () => {
    const s = run([
      { type: 'snapshot', message_id: 'm1', content: '', reasoning: '', tools: [], sources: [], rid: 'r1', status: 'streaming' },
      { type: 'tool', tool: tool('a', 0, { state: 'running' }) },
    ])
    expect(s.phase).toBe('tool')
    const s2 = reduceStream(s, { type: 'tool', tool: tool('a', 0, { state: 'done', summary: 'Searched "a" · 5 results' }) }, 200)
    expect(s2.tools).toHaveLength(1)
    expect(s2.tools[0].summary).toContain('5 results')
    const s3 = reduceStream(s2, { type: 'request', rid: 'r2' }, 201)
    expect(s3.rid).toBe('r2')
    expect(s3.ridAt).toBe(201)
    expect(s3.phase).toBe('waiting')
  })

  it('ends with done, stopped or error, and keeps the stats', () => {
    expect(run([{ type: 'done', stats: { tok_s: 40 } }])).toMatchObject({ ended: true, status: 'done', stats: { tok_s: 40 } })
    expect(run([{ type: 'stopped' }])).toMatchObject({ ended: true, status: 'stopped' })
    expect(run([{ type: 'error', error: 'boom' }])).toMatchObject({ ended: true, status: 'error', error: 'boom' })
    expect(run([{ type: 'idle' }]).status).toBe('idle')
  })

  it('lays the live answer over its own message only', () => {
    const live = run([{ type: 'snapshot', message_id: 'm2', content: 'live', reasoning: '', tools: [], sources: [], rid: null, status: 'streaming' }])
    const m = { ...msg('m2', 'm1', 'assistant'), status: 'streaming' as const, content: '' }
    expect(withLive(m, live).content).toBe('live')
    expect(withLive(msg('m1', null), live).content).toBe('m1')
  })
})

describe('citations', () => {
  it('finds numbers outside code, in order', () => {
    expect(citedNumbers('A [2] and [1, 3]. `x[4]` ```\n[5]\n``` [2]')).toEqual([2, 1, 3])
  })

  it('links only numbers that have a source, and leaves links and images alone', () => {
    const v = new Set([1, 2])
    expect(linkCitations('see [1] and [2][1], not [7]', v)).toBe('see [1](#cite-1) and [2](#cite-2)[1](#cite-1), not [7]')
    expect(linkCitations('[1](https://x.example) ![1](a.png) [1]: def', v)).toBe('[1](https://x.example) ![1](a.png) [1]: def')
    expect(linkCitations('both [1, 2]', v)).toBe('both [1](#cite-1)[2](#cite-2)')
    expect(linkCitations('`[1]`', v)).toBe('`[1]`')
  })

  it('reads the number back from the rendered link', () => {
    expect(citeOf('#cite-3')).toBe(3)
    expect(citeOf('#user-content-cite-12')).toBe(12)
    expect(citeOf('https://x.example/#cite-3x')).toBeNull()
    expect(citeOf(undefined)).toBeNull()
  })

  it('lists only cited sources, opened pages first', () => {
    const src = (n: number, opened = false): Source => ({ n, url: `https://s${n}.example`, title: `S${n}`, domain: `s${n}.example`, kind: opened ? 'page' : 'result', opened })
    const out = citedSources('x [3] y [1] z [2]', [src(1), src(2, true), src(3), src(4, true)])
    expect(out.map((s) => s.n)).toEqual([2, 1, 3])
  })
})

describe('tool blocks in the answer', () => {
  it('cuts the text where each call happened, grouping calls at the same place', () => {
    const text = 'First line.\nSecond line.\n'
    const parts = interleave(text, [tool('a', 0), tool('b', 0), tool('c', 12)])
    expect(parts.map((p) => (p.kind === 'text' ? `T:${p.text}` : `G:${p.tools.map((t) => t.id).join('')}`))).toEqual([
      'G:ab',
      'T:First line.\n',
      'G:c',
      'T:Second line.\n',
    ])
  })

  it('moves a cut inside a line to the end of that line', () => {
    const parts = interleave('Hello world.\nMore.', [tool('a', 5)])
    expect(parts.map((p) => p.kind)).toEqual(['text', 'tools', 'text'])
    expect(parts[0]).toMatchObject({ text: 'Hello world.\n' })
  })

  it('keeps calls past the end at the end, in the order they ran', () => {
    const parts = interleave('abc', [tool('b', 99), tool('a', 99)])
    expect(parts).toHaveLength(2)
    expect(parts[1].kind === 'tools' && parts[1].tools.map((t) => t.id)).toEqual(['b', 'a'])
  })

  it('says what a call is doing when it has no summary yet', () => {
    expect(toolLine(tool('x', 0, { state: 'running' }))).toBe('Searching “x”…')
    expect(toolLine({ ...tool('y', 0), name: 'open_page', args: { url: 'https://www.nvidia.com/a' }, state: 'waiting' })).toBe('Open nvidia.com?')
    expect(toolLine(tool('z', 0, { summary: 'Read x · y' }))).toBe('Read x · y')
  })
})

describe('the sidebar', () => {
  it('groups by Today, Yesterday, This week and Earlier', () => {
    const now = new Date(2026, 10, 7, 15, 0, 0)
    const t = (d: number, h = 12) => new Date(2026, 10, d, h).getTime() / 1000
    const groups = groupByDate([chat('a', t(7, 9)), chat('b', t(6)), chat('c', t(3)), chat('d', t(-1)), chat('e', t(7, 14))], now)
    expect(groups.map((g) => [g.label, g.chats.map((c) => c.id)])).toEqual([
      ['Today', ['e', 'a']],
      ['Yesterday', ['b']],
      ['This week', ['c']],
      ['Earlier', ['d']],
    ])
  })

  it('upserts newest first', () => {
    const out = upsertChat([chat('a', 3), chat('b', 2)], chat('b', 5))
    expect(out.map((c) => c.id)).toEqual(['b', 'a'])
  })

  it('selects a range in screen order, both ways', () => {
    const o = ['a', 'b', 'c', 'd']
    expect(rangeIds(o, 'b', 'd')).toEqual(['b', 'c', 'd'])
    expect(rangeIds(o, 'd', 'a')).toEqual(['a', 'b', 'c', 'd'])
    expect(rangeIds(o, 'x', 'c')).toEqual(['c'])
  })

  it('reorders by dropping on another', () => {
    expect(reorder(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b'])
    expect(reorder(['a', 'b', 'c'], 'a', 'c', true)).toEqual(['b', 'c', 'a'])
  })

  it('a new turn keeps the branch up to its parent', () => {
    const msgs = [msg('u1', null), msg('a1', 'u1', 'assistant'), msg('u2', 'a1'), msg('a2', 'u2', 'assistant')]
    const c = chat('c', 1)
    // regenerate a1: the new answer replaces it and what came after
    expect(applyTurn(msgs, { chat: c, assistant: msg('a1b', 'u1', 'assistant') }).map((m) => m.id)).toEqual(['u1', 'a1b'])
    // edit the first question (parent null)
    expect(applyTurn(msgs, { chat: c, user: msg('u1b', null), assistant: msg('x', 'u1b', 'assistant') }).map((m) => m.id)).toEqual(['u1b', 'x'])
    // a follow-up
    const out = applyTurn(msgs, { chat: c, user: msg('u3', 'a2'), assistant: msg('a3', 'u3', 'assistant') })
    expect(out.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 'a3'])
    expect(out[5].versions).toEqual({ index: 0, count: 1, ids: ['a3'] })
  })
})

describe('search', () => {
  it('splits a snippet into highlighted pieces', () => {
    expect(splitHighlights('the boiler pressure', [[4, 10], [8, 12]])).toEqual([
      { text: 'the ', hit: false },
      { text: 'boiler p', hit: true },
      { text: 'ressure', hit: false },
    ])
    expect(splitHighlights('abc', [])).toEqual([{ text: 'abc', hit: false }])
  })

  it('names spaces the way in: does', () => {
    expect(spaceSlug('Home lab')).toBe('homelab')
    expect(spaceSlug('Café & Co.')).toBe('caféco')
    expect(splitQuery('boiler in:home')).toEqual({ text: 'boiler', space: 'home' })
    expect(splitQuery('boiler')).toEqual({ text: 'boiler', space: null })
  })
})

describe('small things', () => {
  it('makes monograms from the name of the site', () => {
    expect(monogram('en.wikipedia.org').letter).toBe('W')
    expect(monogram('www.nvidia.com').letter).toBe('N')
    expect(monogram('bbc.co.uk').letter).toBe('B')
    expect(monogram('x.example').tone).toBe(monogram('x.example').tone)
  })

  it('turns the context meter amber, then full', () => {
    expect(contextLevel(10, 100)).toBe('ok')
    expect(contextLevel(75, 100)).toBe('warn')
    expect(contextLevel(90, 100)).toBe('full')
    expect(contextLevel(5, null)).toBe('ok')
    expect(kTokens(18_432)).toBe('18K')
    expect(kTokens(2500)).toBe('2.5K')
    expect(kTokens(950)).toBe('950')
    expect(kTokens(262_144)).toBe('262K')
  })
})
