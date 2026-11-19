// The review's fixes to the chat page's logic (2026-11-07): the stream's timers, finished snapshots, highlights that
// count code points, links only over http(s), the list keeping older pages, the waiting page's deadline, drafts,
// the dialogs' chats and the live client's listeners after signing in again.
import { afterEach, describe, expect, it } from 'vitest'
import { live, resetLive, wireCoreTopics } from '../live'
import { queryClient } from '../queries'
import { ck, knownChats, markTitled, titledStore } from './data'
import { draftCount, dropDraft, getDraft, updateDraft } from './drafts'
import { CHAT_PICTURES, fitPictures, pictureProblem } from '../pictures'
import { codePointRanges, emptyLive, mergeFirstPage, reduceStream, safeHref, splitHighlights, upsertTool, waitDeadline, WAIT_S, withLive } from './logic'
import type { Chat, ChatDetail, Message, StreamEvent, ToolCall } from './types'

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

const snap = (extra: Partial<Extract<StreamEvent, { type: 'snapshot' }>> = {}): StreamEvent => ({
  type: 'snapshot',
  message_id: 'm1',
  content: '',
  reasoning: '',
  tools: [],
  sources: [],
  rid: 'r1',
  status: 'streaming',
  ...extra,
})

describe('the stream: the phase timer comes from the server', () => {
  it('a snapshot takes rid_at, so a reload or another device does not restart the timer', () => {
    const s = reduceStream(emptyLive(), snap({ rid_at: 1000 }), 1042)
    expect(s.ridAt).toBe(1000)
  })
  it('without rid_at, the time it was first seen (kept across a reconnect to the same request)', () => {
    const a = reduceStream(emptyLive(), snap(), 50)
    expect(a.ridAt).toBe(50)
    expect(reduceStream(a, snap(), 60).ridAt).toBe(50)
  })
  it('a request event starts the timer when it arrives, and its `at` measures the clocks\' difference', () => {
    const s = reduceStream(emptyLive(), { type: 'request', rid: 'r2', at: 777 }, 900)
    expect(s.rid).toBe('r2')
    expect(s.ridAt).toBe(900)
    expect(s.skew).toBe(123)
    expect(reduceStream(emptyLive(), { type: 'request', rid: 'r3' }, 900).ridAt).toBe(900)
  })
  it('a snapshot of a run that has just ended is the end, not "writing"', () => {
    const s = reduceStream(emptyLive(), snap({ status: 'done', content: 'all of it' }), 5)
    expect(s.ended).toBe(true)
    expect(s.phase).toBe('ended')
    const m = { id: 'm1', status: 'streaming', content: '', sources: [], tools: [], stats: {}, error: null } as unknown as Message
    expect(withLive(m, s).status).toBe('done')
  })
  it("an error's status is the HTTP code; the message is still an error", () => {
    const s = reduceStream(emptyLive(), { type: 'error', error: 'engine said no', status: 502 }, 1)
    expect(s.status).toBe('error')
    expect(s.error).toBe('engine said no')
  })
})

describe('search highlights count code points (as the server does)', () => {
  it('an emoji before the match does not shift it', () => {
    const text = '🏠 boiler pressure'
    // the server's offsets: "boiler" is characters 2..8
    expect(codePointRanges(text, [[2, 8]])).toEqual([[3, 9]])
    expect(splitHighlights(text, [[2, 8]]).find((p) => p.hit)?.text).toBe('boiler')
  })
  it('plain text is left as it is', () => {
    expect(codePointRanges('abc def', [[4, 7]])).toEqual([[4, 7]])
  })
  it('ranges past the end are clamped', () => {
    expect(splitHighlights('🙂 hi', [[2, 99]]).find((p) => p.hit)?.text).toBe('hi')
  })
})

describe('links from the web or the model', () => {
  it('only http and https become links', () => {
    expect(safeHref('https://example.com/a?b=1')).toBe('https://example.com/a?b=1')
    expect(safeHref('http://example.com')).toBe('http://example.com/')
    for (const bad of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'file:///etc/passwd', 'not a url', '', null, undefined]) {
      expect(safeHref(bad as string)).toBeNull()
    }
  })
})

describe('the chat list keeps older pages across a refetch', () => {
  const page = Array.from({ length: 3 }, (_, i) => chat(`n${i}`, 100 - i))
  it('without older pages, the page is the list', () => {
    expect(mergeFirstPage(undefined, page, 3)).toEqual({ chats: page, more: true })
  })
  it('with older pages loaded, they stay below the fresh page (and a chat pushed off the page stays too)', () => {
    const prev = { chats: [...page, chat('o1', 50), chat('o2', 40)], more: false, older: true }
    const fresh = [chat('new', 120), ...page.slice(0, 2)]
    const out = mergeFirstPage(prev, fresh, 3)
    expect(out.chats.map((c) => c.id)).toEqual(['new', 'n0', 'n1', 'n2', 'o1', 'o2'])
    expect(out.more).toBe(false)
    expect(out.older).toBe(true)
  })
  it('a short first page is the whole list', () => {
    const prev = { chats: [chat('o1', 50)], more: false, older: true }
    expect(mergeFirstPage(prev, [chat('a', 100)], 3).chats.map((c) => c.id)).toEqual(['a'])
  })
})

describe('ask before opening: the deadline', () => {
  it('counts from when the call began, else from when it was seen', () => {
    expect(waitDeadline({ id: 'x', name: 'open_page', args: {}, state: 'waiting', at: 0, started: 1000 }, 5000)).toBe(1000 + WAIT_S)
    expect(waitDeadline({ id: 'x', name: 'open_page', args: {}, state: 'waiting', at: 0 }, 5000)).toBe(5000 + WAIT_S)
  })
})

describe('drafts', () => {
  afterEach(() => dropDraft('t'))
  it('a change starts from the draft as it is now (a picture read late keeps the typing)', () => {
    updateDraft('t', (d) => ({ ...d, text: 'typed meanwhile' }))
    updateDraft('t', (d) => ({ ...d, images: [...d.images, 'data:image/png;base64,AA'] }))
    expect(getDraft('t')).toEqual({ text: 'typed meanwhile', images: ['data:image/png;base64,AA'] })
  })
  it('an empty draft is removed', () => {
    const n = draftCount()
    updateDraft('t', () => ({ text: 'x', images: [] }))
    expect(draftCount()).toBe(n + 1)
    updateDraft('t', () => ({ text: '', images: [] }))
    expect(draftCount()).toBe(n)
  })
})

describe('the dialogs find their chats', () => {
  afterEach(() => queryClient.clear())
  it('from the list, else an open chat, else a stand-in with the id', () => {
    const open = chat('opened', 10, { title: 'Old chat', messages: 6 })
    queryClient.setQueryData<ChatDetail>(ck.chat('opened'), { chat: open, messages: [], context: null, space: null, suggested_space: null })
    const out = knownChats(['listed', 'opened', 'unknown'], [chat('listed', 20)])
    expect(out.map((c) => c.id)).toEqual(['listed', 'opened', 'unknown'])
    expect(out[1].title).toBe('Old chat')
    expect(out[2].created_at).toBe(0)
    expect(knownChats(null, [])).toEqual([])
  })
  it('title marks are pruned', () => {
    titledStore.set({ old: Date.now() - 60_000 })
    markTitled('new')
    expect(Object.keys(titledStore.get())).toEqual(['new'])
  })
})

describe('the live client after signing in again', () => {
  it('the core topics are wired once, not once per sign-in', () => {
    wireCoreTopics()
    expect(live.listenerCount('auth')).toBe(1)
    resetLive()
    expect(live.listenerCount('auth')).toBe(0)
    wireCoreTopics()
    wireCoreTopics()
    expect(live.listenerCount('auth')).toBe(1)
    expect(live.listenerCount('metrics')).toBe(1)
    resetLive()
  })
})

// ---------------------------------------------------------------------------------------- the second review's fixes
describe('the server\'s times on this browser\'s clock', () => {
  it('a snapshot measures the difference from the Date header and moves rid_at and the tools\' starts by it', () => {
    const s = reduceStream(
      emptyLive(),
      snap({ server_now: 1000, rid_at: 990, tools: [{ id: 'a', name: 'open_page', args: {}, state: 'waiting', at: 0, started: 995 }] }),
      1300,
    )
    expect(s.skew).toBe(300)
    expect(s.ridAt).toBe(1290)
    expect(s.tools[0].started).toBe(1295)
    expect(waitDeadline(s.tools[0], 0)).toBe(1295 + WAIT_S)
  })
  it('a difference under 2 s (the header has whole seconds) counts as none', () => {
    const s = reduceStream(emptyLive(), snap({ server_now: 1000, rid_at: 990 }), 1001.4)
    expect(s.skew).toBe(0)
    expect(s.ridAt).toBe(990)
  })
  it('a tool event later is moved by the difference known then', () => {
    const s = reduceStream(emptyLive(), { type: 'request', rid: 'r', at: 100 }, 160)
    const t = reduceStream(s, { type: 'tool', tool: { id: 'x', name: 'open_page', args: {}, state: 'waiting', at: 0, started: 110 } }, 170)
    expect(t.tools[0].started).toBe(170)
  })
})

describe('tools: an id an engine uses again', () => {
  it('a finished call and a new running one with the same id are two rows; updates go to the newest', () => {
    const tl = (state: ToolCall['state'], summary?: string): ToolCall => ({ id: 'call_0', name: 'web_search', args: { query: state }, state, at: 0, summary })
    let tools = upsertTool([], tl('running'))
    tools = upsertTool(tools, tl('done', 'first'))
    expect(tools).toHaveLength(1)
    tools = upsertTool(tools, tl('running'))
    expect(tools).toHaveLength(2)
    tools = upsertTool(tools, tl('done', 'second'))
    expect(tools.map((t) => t.summary)).toEqual(['first', 'second'])
  })
  it('waiting, then running again (allowed), then done stays one row', () => {
    const tl = (state: ToolCall['state']): ToolCall => ({ id: 'p', name: 'open_page', args: {}, state, at: 0 })
    const tools = [tl('running'), tl('waiting'), tl('running'), tl('done')].reduce<ToolCall[]>((a, t) => upsertTool(a, t), [])
    expect(tools).toHaveLength(1)
    expect(tools[0].state).toBe('done')
  })
})

describe('a snapshot of a failed run', () => {
  it('takes the error when it has one, and says it failed until the reload when it has none', () => {
    expect(reduceStream(emptyLive(), snap({ status: 'error', error: 'boom' }), 1).error).toBe('boom')
    const live = reduceStream(emptyLive(), snap({ status: 'error' }), 1)
    const m = { id: 'm1', status: 'streaming', error: null } as unknown as Message
    expect(withLive(m, live)).toMatchObject({ status: 'error', error: 'The answer failed.' })
  })
})

describe('pictures', () => {
  const rules = { ...CHAT_PICTURES, maxTotal: 100 }
  it('only PNG, JPEG, GIF or WebP, at most 8 MB each, for the chat', () => {
    expect(pictureProblem({ name: 'a.png', type: 'image/png', size: 10 }, { ...CHAT_PICTURES, maxTotal: 1e9 })).toBeNull()
    expect(pictureProblem({ name: 'a.avif', type: 'image/avif', size: 10 }, { ...CHAT_PICTURES, maxTotal: 1e9 })).toMatch(/PNG, JPEG/)
    expect(pictureProblem({ name: 'b.heic', type: 'image/heic', size: 10 }, { ...CHAT_PICTURES, maxTotal: 1e9 })).not.toBeNull()
    expect(pictureProblem({ name: 'c.png', type: 'image/png', size: 10 * 1024 * 1024 }, { ...CHAT_PICTURES, maxTotal: 1e9 })).toMatch(/over 8 MB/)
    expect(pictureProblem({ name: 'd.svg', type: 'image/svg+xml', size: 10 }, { maxTotal: 1e9 })).toBeNull() // the playground: any picture
  })
  it('counts against the list as it is now, not as it was when the files were picked', () => {
    const five = ['a', 'b', 'c', 'd', 'e']
    const first = fitPictures([], five, rules)
    expect(first.list).toHaveLength(5)
    const second = fitPictures(first.list, ['f', 'g', 'h', 'i', 'j'], rules)
    expect(second.list).toHaveLength(8)
    expect(second.overCount).toBe(2)
  })
  it('and against the total size of the list as it is now', () => {
    const big = 'x'.repeat(40)
    const r = fitPictures([big, big], [big, 'y'], rules)
    expect(r.list).toEqual([big, big, 'y'])
    expect(r.overSize).toBe(1)
  })
})

describe('the list after the connection comes back', () => {
  it('a list no longer marked as having older pages keeps only the fresh first page', () => {
    const page = Array.from({ length: 3 }, (_, i) => chat(`n${i}`, 100 - i))
    const prev = { chats: [...page, chat('gone', 10)], more: true, older: false }
    expect(mergeFirstPage(prev, page, 3).chats.map((c) => c.id)).toEqual(['n0', 'n1', 'n2'])
  })
})
