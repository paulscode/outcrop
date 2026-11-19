// Plain words for the engine's states, and the colors that mean them everywhere.

import type { Flight, MetricsSample } from './types'

export type Meaning = 'read' | 'think' | 'answer' | 'warn' | 'error' | 'ok' | 'neutral'

export interface StateWords {
  key: string
  label: string
  short: string
  tone: Meaning
  term?: string
}

/** The engine's live state as plain words: reading the prompt (prefill), thinking, answering (decode), idle. */
export function engineWords(e: MetricsSample['engine'] | undefined | null, switching?: boolean): StateWords {
  if (switching) return { key: 'switching', label: 'Switching preset', short: 'switching', tone: 'warn' }
  if (!e) return { key: 'unknown', label: 'No data yet', short: '—', tone: 'neutral' }
  if (e.loaded === false) return { key: 'unloaded', label: 'Model not loaded', short: 'not loaded', tone: 'warn' }
  const st = (e.state || '').toLowerCase()
  const ph = (e.phase || '').toLowerCase()
  if (st === 'reading' || st === 'prefill' || ph.includes('reading'))
    return { key: 'reading', label: 'Reading the prompt', short: 'reading', tone: 'read', term: 'prefill' }
  if (st === 'thinking' || ph.includes('think'))
    return { key: 'thinking', label: 'Thinking', short: 'thinking', tone: 'think', term: 'reasoning tokens' }
  if (st === 'answering' || st === 'generating' || st === 'decode' || ph.includes('answer'))
    return { key: 'answering', label: 'Answering', short: 'answering', tone: 'answer', term: 'decode' }
  if (st === 'idle' || !st) return { key: 'idle', label: 'Idle', short: 'idle', tone: 'ok' }
  return { key: st, label: st[0].toUpperCase() + st.slice(1), short: st, tone: 'neutral' }
}

/** A request's phase as plain words. */
export function flightWords(f: Flight, reading = false): StateWords {
  const p = f.phase
  if (f.denied) return { key: 'denied', label: 'refused', short: 'refused', tone: 'error' }
  if (p === 'done') {
    const ok = (f.status ?? 200) < 400 && (!f.outcome || f.outcome === 'ok')
    return ok
      ? { key: 'done', label: 'done', short: 'done', tone: 'ok' }
      : { key: 'failed', label: f.outcome === 'client_gone' ? 'hung up' : f.outcome === 'cancelled' ? 'cancelled' : 'failed', short: 'failed', tone: 'error' }
  }
  if (p === 'held') return { key: 'held', label: 'held for a switch', short: 'held', tone: 'warn', term: 'gateway hold' }
  if (p === 'thinking') return { key: 'thinking', label: 'thinking', short: 'thinking', tone: 'think' }
  if (p === 'answering') return { key: 'answering', label: 'answering', short: 'answering', tone: 'answer', term: 'decode' }
  if (reading) return { key: 'reading', label: 'reading the prompt', short: 'reading', tone: 'read', term: 'prefill' }
  return { key: 'waiting', label: 'waiting', short: 'waiting', tone: 'neutral', term: 'queued' }
}

export const toneText: Record<Meaning, string> = {
  read: 'text-read',
  think: 'text-think',
  answer: 'text-answer',
  warn: 'text-warn',
  error: 'text-error',
  ok: 'text-ok',
  neutral: 'text-muted',
}
export const toneBg: Record<Meaning, string> = {
  read: 'bg-read',
  think: 'bg-think',
  answer: 'bg-answer',
  warn: 'bg-warn',
  error: 'bg-error',
  ok: 'bg-ok',
  neutral: 'bg-faint',
}
export const toneSoft: Record<Meaning, string> = {
  read: 'bg-read-bg',
  think: 'bg-think-bg',
  answer: 'bg-answer-bg',
  warn: 'bg-warn-bg',
  error: 'bg-error-bg',
  ok: 'bg-ok-bg',
  neutral: 'bg-panel-2',
}
export const toneVar: Record<Meaning, string> = {
  read: 'var(--read)',
  think: 'var(--think)',
  answer: 'var(--answer)',
  warn: 'var(--warn)',
  error: 'var(--error)',
  ok: 'var(--ok)',
  neutral: 'var(--fg-faint)',
}

/** Endpoint paths, shortened for lanes: /v1/chat/completions -> chat/completions */
export function shortPath(p?: string | null): string {
  if (!p) return '—'
  return p.replace(/^\/v1\//, '').replace(/^\/api\//, 'ollama ')
}

/** The dialect of an endpoint, for a small label. */
export function dialect(path?: string | null, listener?: string | null): string {
  if (!path) return listener ?? ''
  if (path.startsWith('/v1/messages')) return 'Anthropic'
  if (path.startsWith('/v1/responses')) return 'Responses'
  if (path.startsWith('/v1/')) return 'OpenAI'
  if (path.startsWith('/api/')) return 'Ollama'
  return listener ?? ''
}
