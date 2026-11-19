// The live WebSocket (/api/live): one connection, topics ref-counted, reconnect with backoff, the last message of each
// topic replayed to late listeners.  Core topics feed global stores that the shell and the pages read.

import { useEffect, useRef } from 'react'
import { api } from './api'
import { qk, queryClient } from './queries'
import { emptyRiver, mergeLog, reduceRiver, type RiverState } from './requests'
import { createStore, useStore } from './store'
import type {
  AlertsSummary,
  EngineSnapshot,
  GatewayState,
  MetricsSample,
  SwitchState,
  Units,
} from './types'

export interface LiveMsg {
  t: string
  d: unknown
  at: number
  snapshot?: boolean
}
type Listener = (m: LiveMsg) => void
export type ConnStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed'

export const BACKOFF_MS = [400, 1000, 2000, 4000, 8000, 15000]
const WATCHDOG_MS = 45_000

export interface SocketLike {
  readyState: number
  onopen: ((ev: unknown) => void) | null
  onclose: ((ev: { code: number }) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onerror: ((ev: unknown) => void) | null
  send(data: string): void
  close(code?: number): void
}

export interface LiveOptions {
  url?: () => string
  makeSocket?: (url: string) => SocketLike
  onSignout?: () => void
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (id: unknown) => void
  random?: () => number
}

function defaultUrl() {
  const p = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${p}//${location.host}/api/live`
}

export class LiveClient {
  status = createStore<ConnStatus>('idle')
  lastMessageAt = 0
  attempt = 0
  private ws: SocketLike | null = null
  private refs = new Map<string, number>()
  private listeners = new Map<string, Set<Listener>>()
  private last = new Map<string, LiveMsg>()
  private retry: unknown = null
  private watchdog: unknown = null
  private stopped = true
  private opts: Required<LiveOptions>

  constructor(opts: LiveOptions = {}) {
    this.opts = {
      url: opts.url ?? defaultUrl,
      makeSocket: opts.makeSocket ?? ((u) => new WebSocket(u) as unknown as SocketLike),
      onSignout: opts.onSignout ?? (() => {}),
      now: opts.now ?? (() => Date.now()),
      setTimer: opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimer: opts.clearTimer ?? ((id) => clearTimeout(id as number)),
      random: opts.random ?? Math.random,
    }
  }

  setSignoutHandler(fn: () => void) {
    this.opts.onSignout = fn
  }

  start() {
    if (!this.stopped) return
    this.stopped = false
    this.connect()
  }

  stop() {
    this.stopped = true
    if (this.retry) this.opts.clearTimer(this.retry)
    if (this.watchdog) this.opts.clearTimer(this.watchdog)
    this.retry = this.watchdog = null
    const ws = this.ws
    this.ws = null
    if (ws) {
      ws.onclose = ws.onmessage = ws.onerror = ws.onopen = null
      try {
        ws.close()
      } catch {
        /* already closed */
      }
    }
    this.status.set('closed')
    this.last.clear()
  }

  /** Listen to a topic (and its sub-messages, e.g. metrics.history); the server is subscribed while anyone listens. */
  on(topic: string, fn: Listener): () => void {
    let set = this.listeners.get(topic)
    if (!set) this.listeners.set(topic, (set = new Set()))
    set.add(fn)
    for (const [t, m] of this.last) {
      if (t === topic || t.startsWith(`${topic}.`)) fn({ ...m, snapshot: true })
    }
    this.ref(topic, +1)
    return () => {
      set!.delete(fn)
      this.ref(topic, -1)
    }
  }

  private ref(topic: string, delta: number) {
    const n = (this.refs.get(topic) ?? 0) + delta
    if (n <= 0) {
      this.refs.delete(topic)
      if (delta < 0) this.send({ op: 'unsub', topics: [topic] })
      return
    }
    this.refs.set(topic, n)
    if (n === 1 && delta > 0) this.send({ op: 'sub', topics: [topic] })
  }

  private send(obj: unknown) {
    if (this.ws && this.ws.readyState === 1) {
      try {
        this.ws.send(JSON.stringify(obj))
      } catch {
        /* the socket is closing; the reconnect resubscribes */
      }
    }
  }

  private connect() {
    if (this.stopped) return
    this.status.set(this.attempt ? 'reconnecting' : 'connecting')
    let ws: SocketLike
    try {
      ws = this.opts.makeSocket(this.opts.url())
    } catch {
      this.schedule()
      return
    }
    this.ws = ws
    ws.onopen = () => {
      this.attempt = 0
      this.status.set('open')
      this.lastMessageAt = this.opts.now()
      const topics = [...this.refs.keys()]
      if (topics.length) this.send({ op: 'sub', topics })
      this.arm()
    }
    ws.onmessage = (ev) => {
      this.lastMessageAt = this.opts.now()
      let m: LiveMsg
      try {
        m = JSON.parse(String(ev.data)) as LiveMsg
      } catch {
        return
      }
      this.dispatch(m)
    }
    ws.onerror = () => {
      /* onclose follows */
    }
    ws.onclose = (ev) => {
      if (this.ws !== ws) return
      this.ws = null
      if (this.watchdog) this.opts.clearTimer(this.watchdog)
      if (ev.code === 4401) {
        this.status.set('closed')
        this.stopped = true
        this.opts.onSignout()
        return
      }
      this.schedule()
    }
  }

  private arm() {
    if (this.watchdog) this.opts.clearTimer(this.watchdog)
    this.watchdog = this.opts.setTimer(() => {
      if (this.stopped || !this.ws) return
      if (this.opts.now() - this.lastMessageAt > WATCHDOG_MS) {
        const ws = this.ws
        this.ws = null
        ws.onclose = ws.onmessage = ws.onerror = ws.onopen = null
        try {
          ws.close()
        } catch {
          /* ignore */
        }
        this.schedule()
        return
      }
      this.arm()
    }, 5000)
  }

  private schedule() {
    if (this.stopped) return
    this.status.set('reconnecting')
    const base = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]
    const delay = Math.round(base * (0.8 + 0.4 * this.opts.random()))
    this.attempt++
    this.retry = this.opts.setTimer(() => {
      this.retry = null
      this.connect()
    }, delay)
  }

  /** How many listeners a topic has (tests). */
  listenerCount(topic: string): number {
    return this.listeners.get(topic)?.size ?? 0
  }

  /** Deliver a message to its topic's listeners (also used by tests). */
  dispatch(m: LiveMsg) {
    if (m.t === 'signout') {
      this.stop()
      this.opts.onSignout()
      return
    }
    if (m.t === 'hb' || m.t === 'pong') return
    this.last.set(m.t, m)
    const base = m.t.split('.')[0]
    const exact = this.listeners.get(m.t)
    if (exact) for (const fn of [...exact]) fn(m)
    if (base !== m.t) {
      const b = this.listeners.get(base)
      if (b) for (const fn of [...b]) fn(m)
    }
  }
}

export const live = new LiveClient()

// ------------------------------------------------------------------------------------------------- global stores
export const HISTORY_MAX = 900

export const metricsStore = createStore<{ latest: MetricsSample | null; history: MetricsSample[] }>({
  latest: null,
  history: [],
})
export const engineStore = createStore<EngineSnapshot | null>(null)
export const unitsStore = createStore<Units | null>(null)
export const gatewayStore = createStore<GatewayState | null>(null)
export const switchStore = createStore<SwitchState | null>(null)
export const alertsStore = createStore<AlertsSummary | null>(null)
export const riverStore = createStore<RiverState>(emptyRiver)
/** Counts gateway `events` messages, so pages can refetch when something happened. */
export const eventsTick = createStore(0)

export function pushSample(s: MetricsSample) {
  metricsStore.set((p) => {
    const history = p.history.length >= HISTORY_MAX ? p.history.slice(-HISTORY_MAX + 1) : p.history.slice()
    if (!history.length || history[history.length - 1].t < s.t) history.push(s)
    return { latest: s, history }
  })
}

let wired: Array<() => void> | null = null
/** Subscribe the core topics once, for the whole signed-in session (resetLive takes them off again). */
export function wireCoreTopics() {
  if (wired) return
  const offs: Array<() => void> = []
  wired = offs
  const on = (topic: string, fn: Listener) => offs.push(live.on(topic, fn))
  on('metrics', (m) => {
    if (m.t === 'metrics.history') {
      const hist = (m.d as MetricsSample[]) ?? []
      metricsStore.set((p) => {
        const merged = [...hist]
        for (const s of p.history) if (!merged.length || s.t > merged[merged.length - 1].t) merged.push(s)
        return { latest: p.latest ?? merged[merged.length - 1] ?? null, history: merged.slice(-HISTORY_MAX) }
      })
    } else if (m.t === 'metrics') {
      pushSample(m.d as MetricsSample)
    }
  })
  on('engine', (m) => engineStore.set(m.d as EngineSnapshot))
  on('units', (m) => unitsStore.set(m.d as Units))
  on('gateway', (m) => gatewayStore.set(m.d as GatewayState))
  on('switch', (m) => {
    const sw = (m.d as SwitchState) ?? null
    const prev = switchStore.get()
    switchStore.set(sw)
    // a switch from anywhere (this page, another browser, outcrop) changes the running preset: refetch what shows it
    if (sw && sw.status !== 'waiting' && sw.status !== 'running' && (prev?.id !== sw.id || prev.status !== sw.status)) {
      void queryClient.invalidateQueries({ queryKey: qk.presets })
      void queryClient.invalidateQueries({ queryKey: qk.state })
    }
  })
  on('alerts', (m) => alertsStore.set(m.d as AlertsSummary))
  on('requests', (m) => riverStore.set((s) => reduceRiver(s, m.t, m.d, m.at)))
  on('auth', (m) => {
    if (m.snapshot) return
    riverStore.set((s) => reduceRiver(s, 'auth', m.d, m.at))
  })
  on('events', (m) => {
    if (!m.snapshot) eventsTick.set((n) => n + 1)
  })
  void seedRiver()
}

/** Fill the river from the request log (the newest 50), for the time before this page was listening. */
export async function seedRiver(limit = 50) {
  try {
    const rows = await api.get<import('./types').RequestRow[]>(`/api/requests?limit=${limit}`)
    riverStore.set((s) => mergeLog(s, rows))
  } catch {
    /* the live events still fill it */
  }
}

export function resetLive() {
  // the listeners go first: signing in again wires them anew, once
  for (const off of wired ?? []) off()
  wired = null
  live.stop()
  metricsStore.set({ latest: null, history: [] })
  engineStore.set(null)
  unitsStore.set(null)
  gatewayStore.set(null)
  switchStore.set(null)
  alertsStore.set(null)
  riverStore.set(emptyRiver)
}

// --------------------------------------------------------------------------------------------------------- hooks
export function useConnStatus() {
  return useStore(live.status)
}

export function useLatestSample() {
  return useStore(metricsStore, (s) => s.latest)
}

/** Listen to a page-specific topic (logs, bench) while the component is mounted. */
export function useLiveTopic(topic: string, fn: (m: LiveMsg) => void, enabled = true) {
  const ref = useRef(fn)
  ref.current = fn
  useEffect(() => {
    if (!enabled) return
    return live.on(topic, (m) => ref.current(m))
  }, [topic, enabled])
}
