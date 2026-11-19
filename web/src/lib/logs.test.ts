import { describe, expect, it } from 'vitest'
import { appendLines, normLevel, passesLevel, passesQuery, segments, toEntries } from './logs'

describe('normLevel', () => {
  it('keeps the backend level and guesses a missing one', () => {
    expect(normLevel('warn', 'x')).toBe('warn')
    expect(normLevel('warning', 'x')).toBe('warn')
    expect(normLevel(undefined, 'Traceback (most recent call last)')).toBe('error')
    expect(normLevel(undefined, '401 refused: unknown key')).toBe('warn')
    expect(normLevel(undefined, 'ready: http://127.0.0.1:18080')).toBe('info')
  })
})

describe('appendLines', () => {
  it('caps the list, dropping the oldest lines', () => {
    const a = toEntries(Array.from({ length: 8 }, (_, i) => ({ t: i, msg: `line ${i}`, level: 'info' as const })))
    const b = toEntries(Array.from({ length: 5 }, (_, i) => ({ t: 100 + i, msg: `new ${i}`, level: 'info' as const })))
    const out = appendLines(a, b, 10)
    expect(out).toHaveLength(10)
    expect(out[0].msg).toBe('line 3')
    expect(out[out.length - 1].msg).toBe('new 4')
  })
  it('skips a live line that repeats a fetched one', () => {
    const a = toEntries([{ t: 5, msg: 'same', level: 'info' }])
    const b = toEntries([{ t: 5, msg: 'same', level: 'info' }])
    expect(appendLines(a, b)).toBe(a)
  })
})

describe('filters', () => {
  it('filters by level and text', () => {
    expect(passesLevel({ level: 'info' }, 'warn')).toBe(false)
    expect(passesLevel({ level: 'error' }, 'warn')).toBe(true)
    expect(passesLevel({ level: 'warn' }, 'error')).toBe(false)
    expect(passesQuery({ msg: 'Hello World' }, 'world')).toBe(true)
    expect(passesQuery({ msg: 'Hello' }, '  ')).toBe(true)
  })
})

describe('segments', () => {
  it('links request ids and marks search matches', () => {
    const s = segments('done req_0123456789ab in 2 s, done', 'done')
    expect(s).toEqual([
      { kind: 'mark', text: 'done' },
      { kind: 'text', text: ' ' },
      { kind: 'rid', text: 'req_0123456789ab' },
      { kind: 'text', text: ' in 2 s, ' },
      { kind: 'mark', text: 'done' },
    ])
  })
  it('leaves plain text alone', () => {
    expect(segments('nothing here')).toEqual([{ kind: 'text', text: 'nothing here' }])
  })
})
