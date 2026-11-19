import { describe, expect, it } from 'vitest'
import { ago, bytes, clock, compact, ctx, device, dur, fixed, hint, int, lastDays, mean, median, mib, ms, pct, pct100, plural, tps } from './format'

describe('format', () => {
  it('turns missing values into a dash, never NaN', () => {
    for (const f of [int, compact, pct, pct100, bytes, mib, dur, ms, clock, ctx, tps]) {
      expect(f(null as never)).toBe('—')
      expect(f(undefined as never)).toBe('—')
      expect(f(Number.NaN as never)).toBe('—')
    }
    expect(fixed(null)).toBe('—')
  })
  it('counts', () => {
    expect(int(12408)).toBe('12,408')
    expect(compact(950)).toBe('950')
    expect(compact(1234)).toBe('1.2 K')
    expect(compact(84_000)).toBe('84 K')
    expect(compact(1_900_000)).toBe('1.9 M')
    expect(plural(1, 'request')).toBe('1 request')
    expect(plural(3, 'request')).toBe('3 requests')
  })
  it('shares and percentages', () => {
    expect(pct(0.913)).toBe('91%')
    expect(pct(0.004, 1)).toBe('0.4%')
    expect(pct100(97)).toBe('97%')
  })
  it('sizes', () => {
    expect(bytes(716320040)).toBe('683 MiB')
    expect(bytes(512)).toBe('512 B')
    expect(mib(16139)).toBe('15.8 GiB')
    expect(mib(640)).toBe('640 MiB')
  })
  it('durations and clocks', () => {
    expect(dur(0.42)).toBe('420 ms')
    expect(dur(4.25)).toBe('4.3 s')
    expect(dur(61.2)).toBe('1 min')
    expect(dur(425, { precise: true })).toBe('7 min 5 s')
    expect(dur(7300)).toBe('2 h 2 min')
    expect(ms(5304)).toBe('5.3 s')
    expect(clock(754)).toBe('12:34')
    expect(clock(4000)).toBe('1:06:40')
    expect(clock(-5)).toBe('0:00')
  })
  it('relative times', () => {
    expect(ago(1000, 1002)).toBe('just now')
    expect(ago(1000, 1120)).toBe('2 min ago')
    expect(ago(1000 + 3 * 86400, 1000)).toBe('in 3 days')
  })
  it('context sizes', () => {
    expect(ctx(262144)).toBe('262K')
    expect(ctx(1048576)).toBe('1M')
    expect(ctx(32768)).toBe('33K')
  })
  it('tokens per second', () => {
    expect(tps(41.83)).toBe('41.8 tok/s')
    expect(tps(168.4)).toBe('168 tok/s')
  })
  it('devices from user agents', () => {
    expect(device('Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0')).toBe('Firefox on Linux')
    expect(device('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1')).toBe('Safari on iOS')
    expect(device('curl/8.5.0')).toBe('curl')
    expect(device(null)).toBe('Unknown device')
  })
  it('small helpers', () => {
    expect(hint('lls_7QmK2xRf_abcdefgh', 12)).toBe('lls_7QmK2xRf…')
    expect(mean([1, null, 3])).toBe(2)
    expect(median([5, 1, 3, null])).toBe(3)
    expect(median([])).toBeNull()
    const d = lastDays(3, new Date(2026, 10, 6, 12))
    expect(d).toEqual(['2026-11-04', '2026-11-05', '2026-11-06'])
  })
})
