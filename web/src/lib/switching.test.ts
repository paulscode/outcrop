import { describe, expect, it } from 'vitest'
import { switchProgress } from './switching'
import type { SwitchState } from './types'

const base: SwitchState = { id: 'sw_1', to: 'balanced', from: 'quality', status: 'running', when: 'now', events: [], started_at: 1000, by: 'dev', restart: false }

describe('the launch sequence', () => {
  it('lists the phases done, the current one and the ones to come', () => {
    const sw: SwitchState = {
      ...base,
      events: [
        { type: 'plan', preset: 'balanced', warm: 0.41, estimate_s: 66, ram_need_gib: 57, ram_avail_gib: 150, low_ram: false },
        { type: 'phase', phase: 'hold', label: 'Hold new requests', at: 1000 },
        { type: 'phase', phase: 'stop', label: 'Stop quality', at: 1001 },
        { type: 'phase', phase: 'start', label: 'Start balanced', at: 1004 },
        { type: 'phase', phase: 'experts', label: 'Experts into RAM', at: 1010, gb: '59' },
      ],
      last: { type: 'progress', phase: 'experts', rss_gib: 28, target_gib: 40 },
    }
    const p = switchProgress(sw, 1020)
    expect(p.phases.map((r) => [r.key, r.status])).toEqual([
      ['hold', 'done'],
      ['stop', 'done'],
      ['start', 'done'],
      ['experts', 'current'],
      ['gpu_cache', 'pending'],
      ['final', 'pending'],
      ['ready', 'pending'],
    ])
    expect(p.phases[1].seconds).toBe(3)
    expect(p.currentLabel).toBe('Experts into RAM')
    expect(p.expert).toBe('28.0 of 40.0 GiB')
    expect(p.expertFraction).toBeCloseTo(0.7)
    expect(p.estimate).toBe(66)
    expect(p.fraction).toBeCloseTo(20 / 66)
    expect(p.done).toBe(false)
  })

  it('finishes: everything done, the total time, the experts loaded', () => {
    const sw: SwitchState = {
      ...base,
      status: 'done',
      ended_at: 1061,
      events: [
        { type: 'phase', phase: 'experts', label: 'Experts into RAM', at: 1010 },
        { type: 'experts_loaded', gib: '46.84', rate: '12.3' },
        { type: 'phase', phase: 'ready', label: 'Ready', at: 1061 },
        { type: 'done', ok: true, error: null, total_s: 61.2 },
      ],
    }
    const p = switchProgress(sw, 2000)
    expect(p.done).toBe(true)
    expect(p.ok).toBe(true)
    expect(p.total).toBe(61.2)
    expect(p.fraction).toBe(1)
    expect(p.phases.every((r) => r.status === 'done')).toBe(true)
    expect(p.phases[0].detail).toBe('46.8 GiB at 12.3 GiB/s')
  })

  it('a failure marks the phase it stopped in', () => {
    const sw: SwitchState = {
      ...base,
      status: 'failed',
      ended_at: 1030,
      error: 'balanced stopped while starting',
      events: [
        { type: 'phase', phase: 'start', label: 'Start balanced', at: 1004 },
        { type: 'phase', phase: 'weights', label: 'Model weights', at: 1006 },
        { type: 'done', ok: false, error: 'balanced stopped while starting', total_s: 30 },
      ],
    }
    const p = switchProgress(sw, 2000)
    expect(p.ok).toBe(false)
    expect(p.phases.at(-1)).toMatchObject({ key: 'weights', status: 'failed' })
    expect(p.error).toBe('balanced stopped while starting')
  })
})
