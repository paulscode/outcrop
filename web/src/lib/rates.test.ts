import { describe, expect, it } from 'vitest'
import { phaseRates } from './rates'
import type { MetricsSample } from './types'

const s = (t: number, engine: MetricsSample['engine']): MetricsSample => ({ t, gpu: {}, host: {}, engine, gw: {} }) as MetricsSample

describe('phaseRates', () => {
  it('splits thinking and answering by phase, using tok_s, and leaves reading and idle out', () => {
    const r = phaseRates([
      s(0, { state: 'reading', phase: 'reading the prompt', prompt_read: 8192 }),
      s(1, { state: 'generating', phase: 'thinking', tok_s: 30 }),
      s(2, { state: 'generating', phase: 'writing a tool call: read', tok_s: 40 }),
      s(3, { state: 'idle', tok_s: null }),
    ])
    expect(r.think).toEqual([null, 30, null, null])
    expect(r.answer).toEqual([null, null, 40, null])
  })
})
