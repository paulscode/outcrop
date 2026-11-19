import { useInfiniteQuery } from '@tanstack/react-query'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { CheckCircle2, ListTree, Search, X, XCircle } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { RequestDrawer } from '@/components/requests/RequestDrawer'
import { Button } from '@/components/ui/button'
import { Input, Select } from '@/components/ui/input'
import { Badge, Empty, Panel } from '@/components/ui/misc'
import { Tip } from '@/components/ui/menu'
import { shortPath } from '@/lib/engine'
import { compact, dur, fixed, hoursSinceMidnight, ms, pct, when } from '@/lib/format'
import { fetchRequests, useRequestsSummary, useTokens } from '@/lib/queries'
import { isOk, outcomeText } from '@/lib/requests'
import type { RequestRow } from '@/lib/types'
import { cn, useDebounced, useNow } from '@/lib/utils'

type Filters = { app?: string; token?: string; status?: string; q?: string; ip?: string; rid?: string }

const PAGE = 100

export default function Requests() {
  const search = useSearch({ strict: false }) as Filters
  const navigate = useNavigate()
  const set = (patch: Partial<Filters>) => navigate({ to: '/requests', search: (prev: Filters) => ({ ...prev, ...patch }), replace: true })
  const [q, setQ] = useState(search.q ?? '')
  const dq = useDebounced(q, 350)
  useEffect(() => {
    if ((search.q ?? '') !== dq) set({ q: dq || undefined })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dq])
  const { data: tokens } = useTokens()
  const { data: summary } = useRequestsSummary(Math.max(24, hoursSinceMidnight()))
  const now = useNow(30_000)
  const filters = { app: search.app, token: search.token, status: search.status, q: search.q, ip: search.ip }
  const query = useInfiniteQuery({
    queryKey: ['requests', filters],
    queryFn: ({ pageParam }) => fetchRequests({ ...filters, limit: PAGE, before: pageParam }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => (last.length === PAGE ? last[last.length - 1].started_at : undefined),
    refetchInterval: 10_000,
  })
  const rows = useMemo(() => query.data?.pages.flat() ?? [], [query.data])
  const apps = useMemo(() => {
    const s = new Set((summary?.by_app ?? []).map((a) => a.app).filter(Boolean))
    if (search.app) s.add(search.app)
    return [...s].sort()
  }, [summary, search.app])
  const openRow = rows.find((r) => r.rid === search.rid) ?? null
  const active = Object.entries(filters).filter(([, v]) => v)

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-faint" aria-hidden />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search path, app, address, model, request ID" className="pl-8" aria-label="Search the requests" />
        </div>
        <Select aria-label="App" value={search.app ?? ''} onChange={(e) => set({ app: e.target.value || undefined })} className="w-40">
          <option value="">Every app</option>
          {apps.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </Select>
        <Select aria-label="Token" value={search.token ?? ''} onChange={(e) => set({ token: e.target.value || undefined })} className="w-40">
          <option value="">Every token</option>
          {(tokens ?? []).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
              {t.status !== 'active' ? ` (${t.status})` : ''}
            </option>
          ))}
        </Select>
        <Select aria-label="Outcome" value={search.status ?? ''} onChange={(e) => set({ status: e.target.value || undefined })} className="w-36">
          <option value="">Any outcome</option>
          <option value="ok">Answered</option>
          <option value="error">Errors</option>
          <option value="denied">Refused</option>
        </Select>
        {search.ip ? (
          <Badge className="h-7 gap-1.5 text-xs">
            from {search.ip}
            <button type="button" onClick={() => set({ ip: undefined })} aria-label="Remove the address filter">
              <X className="size-3" />
            </button>
          </Badge>
        ) : null}
        {active.length ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setQ('')
              navigate({ to: '/requests', search: {}, replace: true })
            }}
          >
            Clear
          </Button>
        ) : null}
        <span className="num ml-auto text-xs text-faint">{rows.length ? `${rows.length}${query.hasNextPage ? '+' : ''} shown` : ''}</span>
      </div>

      <Panel className="overflow-hidden">
        {query.isLoading ? (
          <div className="h-64 animate-pulse" />
        ) : !rows.length ? (
          <Empty icon={<ListTree />} title={active.length ? 'Nothing matches these filters' : 'No requests yet'}>
            {active.length ? 'Try fewer filters.' : 'Every request through the gateway is logged here: who sent it, how big, how fast.'}
          </Empty>
        ) : (
          <>
            <div className="hidden overflow-x-auto lg:block">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-faint">
                    <th className="w-8 py-2 pl-4" />
                    <th className="px-3 py-2 font-medium">When</th>
                    <th className="px-3 py-2 font-medium">App</th>
                    <th className="px-3 py-2 font-medium">Token</th>
                    <th className="px-3 py-2 font-medium">From</th>
                    <th className="px-3 py-2 font-medium">Endpoint</th>
                    <th className="px-3 py-2 text-right font-medium">In → out</th>
                    <th className="px-3 py-2 text-right font-medium">
                      <Tip content="time to the first token">
                        <span>First token</span>
                      </Tip>
                    </th>
                    <th className="px-3 py-2 text-right font-medium">Speed</th>
                    <th className="px-3 py-2 text-right font-medium">
                      <Tip content="experts already in VRAM (expert-cache hit rate)">
                        <span>In VRAM</span>
                      </Tip>
                    </th>
                    <th className="px-3 py-2 pr-4 text-right font-medium">Took</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <Row key={r.rid} r={r} now={now} onOpen={() => set({ rid: r.rid })} selected={r.rid === search.rid} />
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="divide-y divide-line lg:hidden">
              {rows.map((r) => (
                <li key={r.rid}>
                  <button type="button" className="grid w-full gap-1 px-4 py-3 text-left" onClick={() => set({ rid: r.rid })}>
                    <span className="flex items-center gap-2">
                      {isOk(r) ? <CheckCircle2 className="size-4 text-ok" aria-label="answered" /> : <XCircle className="size-4 text-error" aria-label="failed or refused" />}
                      <span className="font-medium">{r.app}</span>
                      <span className="text-xs text-faint">{r.token_name ?? ''}</span>
                      <span className="num ml-auto text-xs text-faint">{when(r.started_at, now)}</span>
                    </span>
                    <span className="num text-xs text-muted">
                      {r.auth === 'denied'
                        ? `${r.status} ${r.auth_reason ?? ''} · ${r.client_ip}`
                        : `${compact(r.prompt_tokens)} → ${compact(r.output_tokens)} · ${ms(r.ttft_ms)} · ${r.decode_tok_s ? `${fixed(r.decode_tok_s, 1)} tok/s` : '—'} · ${shortPath(r.path)}`}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {query.hasNextPage ? (
              <div className="border-t border-line p-3 text-center">
                <Button variant="secondary" size="sm" loading={query.isFetchingNextPage} onClick={() => query.fetchNextPage()}>
                  Load older
                </Button>
              </div>
            ) : null}
          </>
        )}
      </Panel>
      <RequestDrawer rid={search.rid ?? null} fallback={openRow} onClose={() => set({ rid: undefined })} />
    </div>
  )
}

function Row({ r, now, onOpen, selected }: { r: RequestRow; now: number; onOpen: () => void; selected: boolean }) {
  const ok = isOk(r)
  const denied = r.auth === 'denied'
  return (
    <tr
      className={cn('cursor-pointer border-b border-line last:border-0 hover:bg-panel-2/50', selected && 'bg-panel-2')}
      onClick={onOpen}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onOpen())}
      tabIndex={0}
      aria-label={`${r.app} at ${when(r.started_at, now)}: ${ok ? 'answered' : outcomeText(r)}`}
      data-testid="request-row"
    >
      <td className="py-2 pl-4">{ok ? <CheckCircle2 className="size-4 text-ok" aria-hidden /> : <XCircle className="size-4 text-error" aria-hidden />}</td>
      <td className="num whitespace-nowrap px-3 py-2 text-xs text-muted">{when(r.started_at, now)}</td>
      <td className="max-w-[10rem] truncate px-3 py-2 font-medium">{r.app}</td>
      <td className="max-w-[9rem] truncate px-3 py-2 text-muted">{r.token_name ?? (r.auth === 'open' ? <Badge tone="warn">open</Badge> : '—')}</td>
      <td className="num px-3 py-2 text-xs text-muted">{r.client_ip}</td>
      <td className="num max-w-[12rem] truncate px-3 py-2 text-xs text-muted">
        {denied ? <span className="text-error">{`${r.status} ${r.auth_reason ?? 'refused'}`}</span> : shortPath(r.path)}
      </td>
      <td className="num whitespace-nowrap px-3 py-2 text-right text-xs">
        {denied ? '—' : `${compact(r.prompt_tokens)} → ${compact(r.output_tokens)}`}
        {!ok && !denied ? <div className="text-error">{outcomeText(r)}</div> : null}
      </td>
      <td className="num px-3 py-2 text-right text-xs">{ms(r.ttft_ms)}</td>
      <td className="num px-3 py-2 text-right text-xs">{r.decode_tok_s ? `${fixed(r.decode_tok_s, 1)}/s` : '—'}</td>
      <td className="num px-3 py-2 text-right text-xs">{pct(r.hit_rate)}</td>
      <td className="num px-3 py-2 pr-4 text-right text-xs text-faint">{r.ended_at ? dur(r.ended_at - r.started_at) : '—'}</td>
    </tr>
  )
}
