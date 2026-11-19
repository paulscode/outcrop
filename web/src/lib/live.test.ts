import { describe, expect, it, vi } from 'vitest'
import { LiveClient, type SocketLike } from './live'

class FakeSocket implements SocketLike {
  readyState = 0
  sent: string[] = []
  onopen: ((ev: unknown) => void) | null = null
  onclose: ((ev: { code: number }) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  send(d: string) {
    this.sent.push(d)
  }
  close() {
    this.readyState = 3
  }
  open() {
    this.readyState = 1
    this.onopen?.({})
  }
  msg(m: unknown) {
    this.onmessage?.({ data: JSON.stringify(m) })
  }
  drop(code = 1006) {
    this.readyState = 3
    this.onclose?.({ code })
  }
}

function setup() {
  const sockets: FakeSocket[] = []
  const timers: Array<{ fn: () => void; ms: number }> = []
  const signout = vi.fn()
  const c = new LiveClient({
    url: () => 'ws://test/api/live',
    makeSocket: () => {
      const s = new FakeSocket()
      sockets.push(s)
      return s
    },
    onSignout: signout,
    setTimer: (fn, ms) => {
      timers.push({ fn, ms })
      return timers.length
    },
    clearTimer: () => {},
    random: () => 0.5,
    now: () => 0,
  })
  return { c, sockets, timers, signout }
}

describe('the live socket', () => {
  it('subscribes the topics that have listeners, once each, and again after a reconnect', () => {
    const { c, sockets, timers } = setup()
    const a = vi.fn()
    c.on('metrics', a)
    c.on('metrics', vi.fn())
    c.start()
    sockets[0].open()
    expect(sockets[0].sent.map((s) => JSON.parse(s))).toEqual([{ op: 'sub', topics: ['metrics'] }])
    sockets[0].msg({ t: 'metrics', d: { t: 1 }, at: 1 })
    sockets[0].msg({ t: 'metrics.history', d: [], at: 1 })
    expect(a).toHaveBeenCalledTimes(2)
    // the connection drops: it waits (backoff), reconnects and subscribes again
    sockets[0].drop()
    expect(c.status.get()).toBe('reconnecting')
    const retry = timers[timers.length - 1]
    expect(retry.ms).toBe(400)
    retry.fn()
    sockets[1].open()
    expect(JSON.parse(sockets[1].sent[0])).toEqual({ op: 'sub', topics: ['metrics'] })
    expect(c.status.get()).toBe('open')
  })

  it('backs off longer each time, up to 15 s', () => {
    const { c, sockets, timers } = setup()
    c.start()
    const delays: number[] = []
    for (let i = 0; i < 8; i++) {
      sockets[sockets.length - 1].drop()
      delays.push(timers[timers.length - 1].ms)
      timers[timers.length - 1].fn()
    }
    expect(delays).toEqual([400, 1000, 2000, 4000, 8000, 15000, 15000, 15000])
  })

  it('replays the last message of a topic to a late listener', () => {
    const { c, sockets } = setup()
    c.on('gateway', () => {})
    c.start()
    sockets[0].open()
    sockets[0].msg({ t: 'gateway', d: { up: true }, at: 1 })
    const late = vi.fn()
    c.on('gateway', late)
    expect(late).toHaveBeenCalledWith(expect.objectContaining({ t: 'gateway', snapshot: true }))
  })

  it('unsubscribes when the last listener leaves', () => {
    const { c, sockets } = setup()
    c.start()
    sockets[0].open()
    const off = c.on('logs', () => {})
    off()
    expect(sockets[0].sent.map((s) => JSON.parse(s))).toEqual([
      { op: 'sub', topics: ['logs'] },
      { op: 'unsub', topics: ['logs'] },
    ])
  })

  it('goes to sign-in on a signout message or a 4401 close, and stops reconnecting', () => {
    const one = setup()
    one.c.start()
    one.sockets[0].open()
    one.sockets[0].msg({ t: 'signout', d: {}, at: 1 })
    expect(one.signout).toHaveBeenCalled()
    const two = setup()
    two.c.start()
    two.sockets[0].drop(4401)
    expect(two.signout).toHaveBeenCalled()
    expect(two.c.status.get()).toBe('closed')
    expect(two.timers.length).toBe(0)
  })

  it('ignores heartbeats and bad JSON', () => {
    const { c, sockets } = setup()
    const fn = vi.fn()
    c.on('hb', fn)
    c.start()
    sockets[0].open()
    sockets[0].msg({ t: 'hb', d: {}, at: 1 })
    sockets[0].onmessage?.({ data: '{nope' })
    expect(fn).not.toHaveBeenCalled()
  })
})
