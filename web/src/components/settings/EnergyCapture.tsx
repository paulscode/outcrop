import { useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { FileSearch, Lock, ShieldAlert, Zap } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Segmented } from '@/components/ui/controls'
import { Field, Input, Label, Select } from '@/components/ui/input'
import { Tip } from '@/components/ui/menu'
import { Empty, LiveRegion, Skeleton, Stat } from '@/components/ui/misc'
import { Ring } from '@/components/viz/basic'
import { api, ApiError } from '@/lib/api'
import { clock, dur, fixed, hm, int, isNum } from '@/lib/format'
import { qk, useCapture, useEnergy, useTokens } from '@/lib/queries'
import type { CaptureState } from '@/lib/types'
import { useNow } from '@/lib/utils'
import { Callout, SettingsSection } from './Section'

// ---------------------------------------------------------------------------------------------------- energy price
export function EnergySection() {
  const qc = useQueryClient()
  const { data, isPending } = useEnergy(1)
  const [price, setPrice] = useState('')
  const [busy, setBusy] = useState(false)
  const current = data?.price_per_kwh ?? null
  useEffect(() => {
    setPrice(isNum(current) ? String(current) : '')
  }, [current])

  const parsed = price.trim() === '' ? null : Number(price.replace(',', '.'))
  const invalid = parsed !== null && (!Number.isFinite(parsed) || parsed < 0 || parsed >= 100)
  const changed = (parsed ?? null) !== (current ?? null)

  const save = async (value: number | null) => {
    setBusy(true)
    try {
      await api.put('/api/settings/energy', { price_per_kwh: value })
      void qc.invalidateQueries({ queryKey: ['energy'] })
      toast.success(value === null ? 'Energy price removed' : `Energy price set to ${fixed(value, 2)} per kWh`)
    } catch (e) {
      toast.error('Saving the price failed', { description: e instanceof ApiError ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  const today = data?.today
  return (
    <SettingsSection
      id="energy"
      title="Energy price"
      icon={Zap}
      description="With a price per kWh, the energy figures on System also show what the GPU’s electricity cost. They count the GPU only (its power, measured by the driver every second): the server’s VM cannot read the CPU’s power."
    >
      {isPending ? (
        <Skeleton className="h-16" />
      ) : data === null ? (
        <Empty icon={<Zap />} title="Energy is not available from this console yet" className="py-6">
          This backend has no energy endpoint (<code className="text-xs">GET /api/energy</code>).
        </Empty>
      ) : (
        <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
          <form
            className="grid gap-1.5"
            onSubmit={(e) => {
              e.preventDefault()
              if (!invalid && changed) void save(parsed)
            }}
          >
            <Label htmlFor="energy-price">Price per kWh</Label>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                id="energy-price"
                inputMode="decimal"
                placeholder="0.15"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                aria-invalid={invalid || undefined}
                aria-describedby="energy-price-hint"
                className="num w-36"
              />
              <Button type="submit" variant="primary" disabled={invalid || !changed} loading={busy}>
                Save
              </Button>
              {current !== null ? (
                <Button type="button" variant="ghost" onClick={() => save(null)} disabled={busy}>
                  Remove
                </Button>
              ) : null}
            </div>
            {invalid ? (
              <p id="energy-price-hint" className="text-xs text-error" role="alert">
                A price from 0 to 99.99, like 0.15
              </p>
            ) : (
              <p id="energy-price-hint" className="text-xs text-faint">
                In your currency, for example 0.15. Leave it empty for no cost figures.
              </p>
            )}
          </form>
          <div className="flex gap-6">
            <Stat label="GPU today" value={today && isNum(today.kwh) ? `${fixed(today.kwh, 2)} kWh` : '—'} />
            <Stat
              label="Cost today"
              value={today && isNum(today.kwh) && isNum(current) ? fixed(today.kwh * current, 2) : '—'}
              sub={isNum(current) ? `at ${fixed(current, 2)} per kWh` : 'no price set'}
            />
          </div>
        </div>
      )}
    </SettingsSection>
  )
}

// ------------------------------------------------------------------------------------------------------- capture
const DURATIONS = [
  { value: '15', label: '15 min' },
  { value: '60', label: '1 h' },
  { value: '240', label: '4 h' },
  { value: '1440', label: '24 h' },
]

export function CaptureSection() {
  const qc = useQueryClient()
  const { data: cap, isPending } = useCapture()
  const { data: tokens } = useTokens()
  const now = useNow(1000)
  const [minutes, setMinutes] = useState('60')
  const [tokenId, setTokenId] = useState('')
  const [max, setMax] = useState('')
  const [busy, setBusy] = useState(false)
  const [announce, setAnnounce] = useState('')

  const on = !!cap?.enabled
  const until = cap?.until ?? null
  const left = until ? until - now : null
  const started = (cap as (CaptureState & { started_at?: number }) | null | undefined)?.started_at ?? null
  const tokenName = (id: string | null | undefined) => tokens?.find((t) => t.id === id)?.name ?? id
  const maxN = max.trim() ? Number(max) : null
  const maxInvalid = maxN !== null && (!Number.isInteger(maxN) || maxN < 1 || maxN > 100000)

  const put = async (body: Record<string, unknown>) => {
    setBusy(true)
    try {
      const r = await api.put<CaptureState>('/api/capture', body)
      qc.setQueryData(qk.capture, r)
      if (body.enabled) {
        toast.warning('Capture is on', { description: `Prompts and answers are stored for ${dur(Number(body.minutes) * 60)}.` })
        setAnnounce('Capture is on')
      } else {
        toast.success('Capture is off', { description: 'New requests are not stored any more.' })
        setAnnounce('Capture is off')
      }
    } catch (e) {
      toast.error('Changing capture failed', { description: e instanceof ApiError ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsSection
      id="capture"
      title="Capture mode"
      icon={FileSearch}
      meta={on ? 'on' : 'off'}
      description="To debug an app, the gateway can keep the full text of requests and answers for a while, so a request’s details show exactly what was sent and what came back. It is off unless you turn it on, and it turns itself off."
    >
      <LiveRegion message={announce} />
      {isPending ? (
        <Skeleton className="h-24" />
      ) : cap === null ? (
        <Empty icon={<FileSearch />} title="Capture is not available from this console yet" className="py-6">
          This backend has no capture endpoint (<code className="text-xs">/api/capture</code>).
        </Empty>
      ) : (
        <div className="grid gap-4">
          <Callout tone="warn" icon={ShieldAlert} title="Captured prompts and answers are stored on the server">
            Everything an app sends, including documents and code, is kept compressed in the console’s database until the
            retention clears it. Anyone signed in to the console can read it. Capture one app (one token) for a short time.
          </Callout>
          {on ? (
            <div className="flex flex-wrap items-center gap-4 rounded-lg border border-warn/40 bg-warn-bg/60 p-4" data-testid="capture-on">
              <Ring
                fraction={until && started ? (until - now) / Math.max(60, until - started) : 1}
                size={44}
                stroke={4}
                label="time left"
              >
                <FileSearch className="size-4 text-warn" aria-hidden />
              </Ring>
              <div className="min-w-0 flex-1 text-[13px] leading-relaxed">
                <p className="font-medium text-fg">
                  Capturing {cap?.token_id ? <>requests with the token <span className="num">{tokenName(cap.token_id)}</span></> : 'every request'}
                  {until ? <> until <span className="num">{hm(until)}</span></> : null}
                </p>
                <p className="text-muted">
                  <span className="num text-fg">{int(cap?.count ?? 0)}</span> captured
                  {cap?.max_requests ? <> of at most <span className="num">{int(cap.max_requests)}</span></> : null}
                  {left !== null ? <> · <span className="num">{clock(left)}</span> left</> : null} ·{' '}
                  <Link to="/requests" className="link">
                    see them in Requests
                  </Link>
                </p>
              </div>
              <Button variant="warn" onClick={() => put({ enabled: false })} loading={busy}>
                Turn off now
              </Button>
            </div>
          ) : (
            <form
              className="grid gap-4"
              onSubmit={(e) => {
                e.preventDefault()
                if (maxInvalid) return
                void put({ enabled: true, minutes: Number(minutes), token_id: tokenId || null, max_requests: maxN })
              }}
            >
              <div className="grid gap-4 sm:grid-cols-[auto_minmax(0,1fr)_9rem]">
                <div className="grid gap-1.5">
                  <span className="text-[13px] font-medium text-fg" id="cap-dur-label">
                    For
                  </span>
                  <Segmented label="Capture for" value={minutes} onValueChange={setMinutes} options={DURATIONS} />
                </div>
                <Field label="Which requests" htmlFor="cap-token">
                  <Select id="cap-token" value={tokenId} onChange={(e) => setTokenId(e.target.value)}>
                    <option value="">Every request (any token)</option>
                    {(tokens ?? [])
                      .filter((t) => t.status === 'active')
                      .map((t) => (
                        <option key={t.id} value={t.id}>
                          Only the token “{t.name}”{t.last_app ? ` (${t.last_app})` : ''}
                        </option>
                      ))}
                  </Select>
                </Field>
                <Field label="At most" htmlFor="cap-max" error={maxInvalid ? '1 to 100,000' : undefined}>
                  <Input
                    id="cap-max"
                    inputMode="numeric"
                    placeholder="no limit"
                    value={max}
                    onChange={(e) => setMax(e.target.value)}
                    aria-invalid={maxInvalid || undefined}
                    className="num"
                  />
                </Field>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Button type="submit" variant="warn-outline" loading={busy} disabled={maxInvalid}>
                  <FileSearch /> Start capturing
                </Button>
                <Tip content="Captured bodies are compressed (zstd) and kept with the request log; the gateway keeps at most 4 MiB of each.">
                  <span className="inline-flex cursor-help items-center gap-1.5 text-xs text-faint">
                    <Lock className="size-3.5" aria-hidden /> Up to 4 MiB per request and per answer
                  </span>
                </Tip>
              </div>
            </form>
          )}
        </div>
      )}
    </SettingsSection>
  )
}
