import { describe, expect, it } from 'vitest'
import { prefillFrom } from './progress'
import type { MetricsSample } from './types'

const sample = (t: number, state: string, read: number | null, total: number | null): MetricsSample => ({
  t,
  gpu: {},
  host: {},
  engine: { state, prompt_read: read, prompt_total: total },
  gw: {},
})

describe('prompt-reading progress', () => {
  it('uses the engine’s position and its speed over the last samples', () => {
    const h = [sample(10, 'reading', 1000, 10000), sample(12, 'reading', 1400, 10000), sample(14, 'reading', 1800, 10000)]
    const p = prefillFrom(h, null, 190)
    expect(p.reading).toBe(true)
    expect(p.fraction).toBeCloseTo(0.18)
    expect(p.speed).toBeCloseTo(200)
    expect(p.left).toBeCloseTo((10000 - 1800) / 200)
    expect(p.estimated).toBe(false)
  })

  it('estimates from the time spent and the measured speed when the engine reports no position', () => {
    const h = [sample(10, 'reading', null, null), sample(15, 'reading', null, null), sample(20, 'reading', null, null)]
    const p = prefillFrom(h, { prompt_tokens: 5778, elapsed_s: 10 }, 200)
    expect(p.estimated).toBe(true)
    expect(p.read).toBeCloseTo(2000)
    expect(p.left).toBeCloseTo((5778 - 2000) / 200)
  })

  it('is not reading when the engine is idle', () => {
    expect(prefillFrom([sample(1, 'idle', null, null)], null, 190).reading).toBe(false)
    expect(prefillFrom([], null, 190).reading).toBe(false)
  })
})
