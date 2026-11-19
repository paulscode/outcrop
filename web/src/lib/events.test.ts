import { describe, expect, it } from 'vitest'
import { actorWords, detailRows, eventLinks, eventTone, familyOf, FAMILIES, groupByDay, mergeEvents } from './events'
import type { EventRow } from './types'

const ev = (id: number, at: number, kind = 'token.create', extra: Partial<EventRow> = {}): EventRow => ({
  id,
  at,
  kind,
  level: 'info',
  actor: 'dev',
  source: '192.168.1.50',
  summary: `event ${id}`,
  details: {},
  ...extra,
})

describe('familyOf', () => {
  it('sorts the backend kinds into families', () => {
    expect(familyOf('preset.switch')).toBe('presets')
    expect(familyOf('presets.edit')).toBe('presets')
    expect(familyOf('auth.open')).toBe('access')
    expect(familyOf('auth.tokenless')).toBe('access')
    expect(familyOf('token.rotate')).toBe('tokens')
    expect(familyOf('signin.fail')).toBe('signins')
    expect(familyOf('account.password')).toBe('signins')
    expect(familyOf('alert.gpu_hot')).toBe('alerts')
    expect(familyOf('alert.gpu_hot.clear')).toBe('alerts')
    expect(familyOf('alerts.telegram')).toBe('alerts')
    expect(familyOf('bench.end')).toBe('bench')
    expect(familyOf('console')).toBe('console')
    expect(familyOf('console.hsts')).toBe('console')
    expect(familyOf('capture.on')).toBe('console')
    expect(familyOf('gateway.restart')).toBe('gateway')
    expect(familyOf('hold')).toBe('gateway')
    expect(familyOf('something.new')).toBe('other')
  })
  it('has a backend filter for every family', () => {
    for (const f of FAMILIES) expect(f.filter.length).toBeGreaterThan(2)
  })
})

describe('eventTone', () => {
  it('reads cleared alerts as good news and failures as errors', () => {
    expect(eventTone({ kind: 'alert.disk.clear', level: 'info' })).toBe('ok')
    expect(eventTone({ kind: 'auth.close', level: 'info' })).toBe('ok')
    expect(eventTone({ kind: 'auth.open', level: 'warn' })).toBe('warn')
    expect(eventTone({ kind: 'signin.fail', level: 'info' })).toBe('warn')
    expect(eventTone({ kind: 'alert.service', level: 'error' })).toBe('error')
    expect(eventTone({ kind: 'token.create', level: 'info' })).toBe('neutral')
  })
})

describe('actorWords', () => {
  it('says who did it in plain words', () => {
    expect(actorWords('dev', '192.168.1.50')).toBe('dev from 192.168.1.50')
    expect(actorWords('cli', 'ssh')).toBe('outcrop over SSH')
    expect(actorWords('console', '')).toBe('the console')
    expect(actorWords('', '')).toBe('the system')
  })
})

describe('groupByDay', () => {
  it('groups newest-first events by local day with Today and Yesterday', () => {
    const now = new Date(2026, 10, 6, 15, 0, 0).getTime() / 1000
    const list = [ev(3, now - 60), ev(2, now - 3600), ev(1, now - 86400), ev(0, now - 5 * 86400)]
    const g = groupByDay(list, now)
    expect(g.map((x) => x.label).slice(0, 2)).toEqual(['Today', 'Yesterday'])
    expect(g[0].events.map((e) => e.id)).toEqual([3, 2])
    expect(g).toHaveLength(3)
  })
})

describe('mergeEvents', () => {
  it('drops duplicates across pages and keeps newest first', () => {
    const a = [ev(5, 50), ev(4, 40)]
    const b = [ev(4, 40), ev(3, 30)]
    expect(mergeEvents([a, b]).map((e) => e.id)).toEqual([5, 4, 3])
  })
})

describe('eventLinks', () => {
  it('links a token event to the token and an alert to the rules', () => {
    expect(eventLinks(ev(1, 1, 'token.revoke', { details: { token_id: 'S3UFPmrl' } }))[0]).toEqual({
      label: 'Open the token',
      to: '/access',
      search: { token: 'S3UFPmrl' },
    })
    expect(eventLinks(ev(2, 1, 'alert.disk')).some((l) => l.hash === 'alerts')).toBe(true)
  })
})

describe('detailRows', () => {
  const fmt = (ts: number) => `T${ts}`
  it('turns flat details into plain rows', () => {
    expect(
      detailRows({ token_id: 'S3UFPmrl', scopes: ['inference', 'telemetry'], cidrs: [], expires_at: 1794455164, remember: true, n: 3 }, fmt),
    ).toEqual([
      ['token id', 'S3UFPmrl'],
      ['scopes', 'inference, telemetry'],
      ['cidrs', 'none'],
      ['expires at', 'T1794455164'],
      ['remember', 'yes'],
      ['n', '3'],
    ])
  })
  it('gives up on nested details', () => {
    expect(detailRows({ a: { b: 1 } }, fmt)).toBeNull()
    expect(detailRows({ ips: [['10.0.0.1', 3]] }, fmt)).toBeNull()
  })
})
