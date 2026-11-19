import { createStore, useStore } from './store'

export type ThemePref = 'dark' | 'light' | 'system'
const KEY = 'outcrop.theme'

function read(): ThemePref {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'dark' || v === 'light' || v === 'system') return v
  } catch {
    /* private mode */
  }
  return 'dark' // the default until a choice is saved
}

export const themeStore = createStore<ThemePref>(read())

function resolved(p: ThemePref): 'dark' | 'light' {
  if (p === 'system') return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  return p
}

export function applyTheme(p: ThemePref = themeStore.get()) {
  const r = resolved(p)
  document.documentElement.setAttribute('data-theme', r)
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', r === 'light' ? '#f4f4f1' : '#0a0c0f')
}

export function setTheme(p: ThemePref) {
  try {
    localStorage.setItem(KEY, p)
  } catch {
    /* ignore */
  }
  themeStore.set(p)
  applyTheme(p)
}

export function initTheme() {
  applyTheme()
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (themeStore.get() === 'system') applyTheme('system')
  })
}

export function useTheme() {
  return useStore(themeStore)
}

export function useResolvedTheme(): 'dark' | 'light' {
  const p = useTheme()
  return resolved(p)
}
