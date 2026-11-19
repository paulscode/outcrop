import { describe, expect, it } from 'vitest'
import { activeRid, decodeRate, emptyRiver, finished, firstToken, inflightList, isOk, outcomeText, reduceRiver } from './requests'

const start = { type: 'request.start', rid: 'r1', app: 'Claude Code', client_ip: '192.168.1.50', token: 'laptop', token_id: 'T1', started_at: 100, phase: 'waiting', kind: 'messages', seq: 1 }

describe('the request river', () => {
  it('follows a request from start to end, then adds the engine stats', () => {
    let s = reduceRiver(emptyRiver, 'requests', start)
    expect(inflightList(s).map((f) => f.rid)).toEqual(['r1'])
    expect(s.inflight.r1).not.toHaveProperty('type')
    s = reduceRiver(s, 'requests', { type: 'request.first_byte', rid: 'r1', at: 101 })
    expect(s.inflight.r1.first_byte_at).toBe(101)
    s = reduceRiver(s, 'requests', { type: 'request.progress', rid: 'r1', phase: 'thinking', tokens: 1, think_tokens: 1, first_token_at: 102, at: 102 })
    expect(s.inflight.r1.phase).toBe('thinking')
    s = reduceRiver(s, 'requests', { type: 'request.progress', rid: 'r1', phase: 'answering', tokens: 21, answer_at: 102.5, at: 103 })
    expect(s.inflight.r1.tokens).toBe(21)
    expect(activeRid(s)).toBe('r1')
    s = reduceRiver(s, 'requests', { type: 'request.end', rid: 'r1', status: 200, outcome: 'ok', ended_at: 105, ttft_ms: 2000, output_tokens: 80, prompt_tokens: 120, phase: 'done' })
    expect(s.inflight).toEqual({})
    expect(s.recent[0].rid).toBe('r1')
    expect(s.recent[0].app).toBe('Claude Code')
    expect(firstToken(s.recent[0])).toBe(2)
    expect(isOk(s.recent[0])).toBe(true)
    s = reduceRiver(s, 'requests', { type: 'request.stats', rid: 'r1', hit_rate: 0.91, decode_tok_s: 39.3 })
    expect(s.recent[0].hit_rate).toBe(0.91)
    expect(decodeRate(s.recent[0])).toBe(39.3)
  })

  it('marks held requests, and the held one is not the active one', () => {
    let s = reduceRiver(emptyRiver, 'requests', start)
    s = reduceRiver(s, 'requests', { ...start, rid: 'r2', started_at: 101 })
    s = reduceRiver(s, 'requests', { type: 'request.held', rid: 'r2', reason: 'switching to speed' })
    expect(s.inflight.r2.phase).toBe('held')
    expect(s.inflight.r2.held_reason).toBe('switching to speed')
    expect(activeRid(s)).toBe('r1')
  })

  it('ignores events for requests it never saw start, except the end', () => {
    const s = reduceRiver(emptyRiver, 'requests', { type: 'request.progress', rid: 'x', phase: 'answering' })
    expect(s).toBe(emptyRiver)
    const e = reduceRiver(emptyRiver, 'requests', { type: 'request.end', rid: 'x', status: 502, outcome: 'error', started_at: 1, ended_at: 2 })
    expect(e.recent[0].rid).toBe('x')
    expect(isOk(e.recent[0])).toBe(false)
  })

  it('takes the snapshot on subscribe, newest finish first', () => {
    const s = reduceRiver(emptyRiver, 'requests.snapshot', {
      inflight: [{ ...start, rid: 'live' }],
      recent: [
        { rid: 'a', started_at: 1, ended_at: 5 },
        { rid: 'b', started_at: 2, ended_at: 9 },
      ],
    })
    expect(Object.keys(s.inflight)).toEqual(['live'])
    expect(s.recent.map((r) => r.rid)).toEqual(['b', 'a'])
  })

  it('shows refusals as finished lanes, mixed in by time', () => {
    let s = reduceRiver(emptyRiver, 'requests', start)
    s = reduceRiver(s, 'requests', { type: 'request.end', rid: 'r1', status: 200, outcome: 'ok', ended_at: 105 })
    s = reduceRiver(s, 'auth', { type: 'auth.fail', rid: 'd1', ip: '192.168.1.77', app: 'curl', path: '/v1/models', listener: 'openai', status: 401, reason: 'unknown key "sk-a…"', token: null, at: 110 })
    const f = finished(s)
    expect(f.map((x) => x.rid)).toEqual(['d1', 'r1'])
    expect(f[0].denied).toBe(true)
    expect(outcomeText(f[0])).toBe('unknown key "sk-a…"')
  })
})

describe('seeding from the request log', () => {
  it('adds logged requests the river has not seen, refusals as refusals, without duplicates', async () => {
    const { mergeLog } = await import('./requests')
    let s = reduceRiver(emptyRiver, 'requests', start)
    s = reduceRiver(s, 'requests', { type: 'request.end', rid: 'r1', status: 200, outcome: 'ok', ended_at: 105 })
    const rows = [
      { id: 3, rid: 'r1', started_at: 100, ended_at: 105, auth: 'token', status: 200, outcome: 'ok', token_name: 'laptop' },
      { id: 2, rid: 'old', started_at: 50, ended_at: 60, auth: 'token', status: 200, outcome: 'ok', token_name: 'n8n', app: 'n8n' },
      { id: 1, rid: 'no', started_at: 40, ended_at: 40, auth: 'denied', status: 401, outcome: 'denied', auth_reason: 'no token', app: 'curl' },
    ]
    const m = mergeLog(s, rows as never)
    expect(m.recent.map((r) => r.rid)).toEqual(['r1', 'old'])
    expect(m.recent[1].token).toBe('n8n')
    expect(m.denied.map((r) => [r.rid, r.denied, r.reason])).toEqual([['no', true, 'no token']])
    expect(finished(m).map((r) => r.rid)).toEqual(['r1', 'old', 'no'])
    expect(mergeLog(m, rows as never)).toBe(m)
  })
})

describe('the snapshot after a seed', () => {
  it('keeps the seeded finished requests', async () => {
    const { mergeLog } = await import('./requests')
    const seeded = mergeLog(emptyRiver, [{ id: 1, rid: 'logged', started_at: 10, ended_at: 20, auth: 'token', status: 200, outcome: 'ok' }] as never)
    const s = reduceRiver(seeded, 'requests.snapshot', { inflight: [], recent: [{ rid: 'fresh', started_at: 30, ended_at: 40 }] })
    expect(s.recent.map((r) => r.rid)).toEqual(['fresh', 'logged'])
  })
})
