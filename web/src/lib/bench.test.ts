import { describe, expect, it } from 'vitest'
import { checksOf, compareRuns, defaultPair, noiseBand, speedLine, speedOf, verdictOf, type LabRun } from './bench'

let nextId = 1
function run(preset: string, chatDecode: number, t: number, extra: Partial<LabRun> = {}): LabRun {
  return {
    id: nextId++,
    kind: 'quickbench',
    preset,
    status: 'ok',
    started_at: t,
    ended_at: t + 60,
    contention: 0,
    source: null,
    result: { speed: { chat: { decode: chatDecode, prompt: 190, ttft: 1.2, runs: [chatDecode] } } },
    ...extra,
  }
}

describe('speedOf', () => {
  it('reads result.speed and the older top-level shape', () => {
    expect(speedOf({ result: { speed: { chat: { decode: 39.3, prompt: 190, ttft: 0.24, runs: [39.4, 39.3] } } } }).chat).toEqual({
      decode: 39.3,
      prompt: 190,
      ttft: 0.24,
      runs: [39.4, 39.3],
    })
    expect(speedOf({ result: { code: { decode: 40 } } }).code).toEqual({ decode: 40 })
    expect(speedOf({ result: {} })).toEqual({})
    expect(speedOf({ result: { speed: { chat: 'junk' } } })).toEqual({})
  })
})

describe('the noise band', () => {
  it('defaults to 3 % with fewer than three earlier runs', () => {
    const h = [run('quality', 38, 1), run('quality', 39, 2)]
    expect(noiseBand(h, 'quality', 'chat', 'decode')).toEqual({ pct: 3, n: 0, source: 'default' })
  })

  it('is twice the spread of earlier runs of the same preset, at least 1 %', () => {
    const h = [run('quality', 38, 1), run('quality', 39, 2), run('quality', 40, 3), run('speed', 60, 4)]
    const b = noiseBand(h, 'quality', 'chat', 'decode')
    expect(b.source).toBe('history')
    expect(b.n).toBe(3)
    // stdev 1, mean 39 -> 2 * 1/39 = 5.1 %
    expect(b.pct).toBeCloseTo(5.1, 1)
    const tight = [run('x', 40, 1), run('x', 40, 2), run('x', 40, 3)]
    expect(noiseBand(tight, 'x', 'chat', 'decode').pct).toBe(1)
  })

  it('leaves out the compared runs, later runs and runs with GPU contention', () => {
    const h = [run('q', 38, 1), run('q', 39, 2), run('q', 40, 3, { contention: 1 }), run('q', 41, 9)]
    expect(noiseBand(h, 'q', 'chat', 'decode', new Set(), 5).source).toBe('default')
  })
})

describe('verdicts', () => {
  const band = { pct: 3, n: 0, source: 'default' as const }
  it('calls changes inside the band the same', () => {
    expect(verdictOf(40, 41, band, 'higher')).toMatchObject({ verdict: 'same' })
  })
  it('knows which way is better', () => {
    expect(verdictOf(40, 36, band, 'higher').verdict).toBe('worse')
    expect(verdictOf(40, 44, band, 'higher').verdict).toBe('better')
    expect(verdictOf(1.0, 1.2, band, 'lower').verdict).toBe('worse')
    expect(verdictOf(1.0, 0.8, band, 'lower').verdict).toBe('better')
    expect(verdictOf(null, 1, band, 'lower').verdict).toBe('missing')
  })
  it('calls tiny absolute changes noise, whatever the percentage', () => {
    expect(verdictOf(0.25, 0.29, band, 'lower', 0.05).verdict).toBe('same')
    expect(verdictOf(0.25, 0.4, band, 'lower', 0.05).verdict).toBe('worse')
  })
})

describe('compareRuns and defaultPair', () => {
  it('compares every metric of the cases either run has', () => {
    const a = run('q', 40, 10)
    const b = run('q', 36, 20)
    const rows = compareRuns(a, b, [a, b])
    expect(rows.map((r) => `${r.case}.${r.metric}`)).toEqual(['chat.decode', 'chat.prompt', 'chat.ttft'])
    expect(rows[0].verdict).toBe('worse')
    expect(rows[0].deltaPct).toBeCloseTo(-10)
    expect(rows[1].verdict).toBe('same')
  })

  it('picks the newest run and the previous one of the same preset', () => {
    const runs = [run('q', 40, 1), run('s', 50, 2), run('q', 41, 3), run('q', 0, 4, { status: 'failed', result: {} })]
    const [a, b] = defaultPair(runs)
    expect(b?.started_at).toBe(3)
    expect(a?.started_at).toBe(1)
    expect(defaultPair([])).toEqual([null, null])
  })

  it('summarizes speeds and checks', () => {
    expect(speedLine(run('q', 39.31, 1))).toBe('chat 39.3 tok/s')
    expect(checksOf({ result: { checks: [{ cmd: 'apitest', passed: 13, total: 13 }, { junk: 1 }] } })).toEqual([
      { cmd: 'apitest', passed: 13, total: 13 },
    ])
  })
})
