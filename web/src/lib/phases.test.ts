import { describe, expect, it } from 'vitest'
import { packRows, phaseDurations, segments } from './phases'
import type { Flight } from './types'

describe('request phases', () => {
  it('splits a finished request into waiting, reading, thinking and answering', () => {
    const f: Flight = {
      rid: 'r',
      started_at: 100,
      first_token_at: 112,
      answer_at: 113,
      ended_at: 115,
      prompt_tokens: 2000,
      reused_tokens: 100,
      prefill_tok_s: 190,
      think_tokens: 20,
    }
    const s = segments(f, 200)
    expect(s.map((x) => x.key)).toEqual(['waiting', 'reading', 'thinking', 'answering'])
    const d = phaseDurations(s)
    expect(d.reading).toBeCloseTo(1900 / 190)
    expect(d.thinking).toBeCloseTo(1)
    expect(d.answering).toBeCloseTo(2)
  })

  it('works from a log row (ttft and thinking time, no timestamps), after a hold', () => {
    const f: Flight = { rid: 'r', started_at: 100, ended_at: 140, held_ms: 19000, ttft_ms: 12000, think_ms: 500, prompt_tokens: 2314, prefill_tok_s: 190 }
    const s = segments(f, 200)
    expect(s[0]).toMatchObject({ key: 'held', start: 100, end: 119 })
    expect(s.map((x) => x.key)).toEqual(['held', 'reading', 'thinking', 'answering'])
  })

  it('an in-flight request reading its prompt', () => {
    const f: Flight = { rid: 'r', started_at: 100, phase: 'waiting' }
    expect(segments(f, 130, true, 110).map((x) => [x.key, x.start, x.end])).toEqual([
      ['waiting', 100, 110],
      ['reading', 110, 130],
    ])
    expect(segments(f, 130).map((x) => x.key)).toEqual(['waiting'])
  })

  it('packs overlapping bands into rows', () => {
    const rows = packRows([
      { start: 0, end: 10 },
      { start: 5, end: 8 },
      { start: 11, end: 20 },
    ])
    expect(rows.map((r) => r.row)).toEqual([0, 1, 0])
  })
})

describe('a request that was not streamed', () => {
  it('places reading and answering back from its end with the engine’s speeds', () => {
    const f: Flight = { rid: 'n', started_at: 0, ended_at: 10, stream: 0, prompt_tokens: 380, prefill_tok_s: 190, output_tokens: 80, decode_tok_s: 40, ttft_ms: 10000 }
    const s = segments(f, 100)
    expect(s.map((x) => [x.key, x.start, x.end])).toEqual([
      ['waiting', 0, 6],
      ['reading', 6, 8],
      ['answering', 8, 10],
    ])
  })
})
