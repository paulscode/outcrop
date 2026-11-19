import { useRef, useSyncExternalStore } from 'react'

/** A tiny external store: get, set, subscribe; React reads it with useStore (useSyncExternalStore). */
export interface Store<T> {
  get(): T
  set(next: T | ((prev: T) => T)): void
  subscribe(fn: () => void): () => void
}

export function createStore<T>(initial: T): Store<T> {
  let value = initial
  const subs = new Set<() => void>()
  return {
    get: () => value,
    set(next) {
      const v = typeof next === 'function' ? (next as (p: T) => T)(value) : next
      if (Object.is(v, value)) return
      value = v
      for (const fn of [...subs]) fn()
    },
    subscribe(fn) {
      subs.add(fn)
      return () => subs.delete(fn)
    },
  }
}

/** Read a store, optionally through a selector; re-renders only when the selected value changes (Object.is). */
export function useStore<T, S = T>(store: Store<T>, select?: (v: T) => S, equal: (a: S, b: S) => boolean = Object.is): S {
  const sel = (select ?? ((v: T) => v as unknown as S)) as (v: T) => S
  const last = useRef<{ src: T; out: S } | null>(null)
  const getSnapshot = () => {
    const src = store.get()
    if (last.current && last.current.src === src) return last.current.out
    const out = sel(src)
    if (last.current && equal(last.current.out, out)) {
      last.current = { src, out: last.current.out }
      return last.current.out
    }
    last.current = { src, out }
    return out
  }
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot)
}

/** Shallow equality for arrays and plain objects (for selectors that build small objects). */
export function shallow<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a as object)
  const kb = Object.keys(b as object)
  if (ka.length !== kb.length) return false
  for (const k of ka) {
    if (!Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false
  }
  return true
}
