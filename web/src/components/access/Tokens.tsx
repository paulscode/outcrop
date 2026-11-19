import { Link, useNavigate } from '@tanstack/react-router'
import { Ban, ChevronDown, Download, KeyRound, MoreHorizontal, Pencil, Plus, RefreshCw, TriangleAlert, UserX } from 'lucide-react'
import { useMemo, useState } from 'react'
import { ago, compact, dateTime, int, lastDays, ms, tps, when } from '@/lib/format'
import { useAccess, useToken, useTokens } from '@/lib/queries'
import type { Token } from '@/lib/types'
import { cn, useNow } from '@/lib/utils'
import { Button } from '../ui/button'
import { Dialog, DialogDescription, DialogTitle, SheetContent } from '../ui/dialog'
import { Badge, Empty, KV, Panel, PanelHeader } from '../ui/misc'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Tip } from '../ui/menu'
import { MiniBars } from '../viz/basic'
import { EditTokenDialog, NewTokenDialog, RevokeDialog, RotateDialog } from './TokenDialogs'

const DAYS = 30

function usageBars(t: Token): number[] {
  const days = lastDays(DAYS)
  return days.map((d) => t.usage?.days?.[d] ?? 0)
}

function ScopeBadges({ t }: { t: Token }) {
  return (
    <span className="flex flex-wrap gap-1">
      {t.scopes.map((s) => (
        <Badge key={s} tone={s === 'admin' ? 'warn' : s === 'web' ? 'info' : 'neutral'} title={s === 'web' ? 'Web tools: this app’s model may search the web and read pages through the server' : undefined}>
          {s}
        </Badge>
      ))}
      {t.listeners.length === 1 ? <Badge>{t.listeners[0] === 'ollama' ? ':11434 only' : ':8080 only'}</Badge> : null}
      {t.cidrs.length ? (
        <Tip content={`Only from ${t.cidrs.join(', ')}`}>
          <Badge>{t.cidrs.length === 1 ? t.cidrs[0] : `${t.cidrs.length} networks`}</Badge>
        </Tip>
      ) : null}
    </span>
  )
}

function Expiry({ t, now }: { t: Token; now: number }) {
  if (!t.expires_at) return <span className="text-faint">never</span>
  const left = t.expires_at - now
  return (
    <Tip content={dateTime(t.expires_at)}>
      <span className={cn('num', left < 7 * 86400 ? 'text-warn' : 'text-muted')}>{left > 0 ? ago(t.expires_at, now) : 'expired'}</span>
    </Tip>
  )
}

function RowMenu({ t, onEdit, onRotate, onRevoke, onOpen }: { t: Token; onEdit: () => void; onRotate: () => void; onRevoke: () => void; onOpen: () => void }) {
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button variant="ghost" size="icon-xs" aria-label={`More for ${t.name}`}>
          <MoreHorizontal />
        </Button>
      </MenuTrigger>
      <MenuContent>
        <MenuItem onSelect={onOpen}>
          <KeyRound /> Details and recent requests
        </MenuItem>
        <MenuItem onSelect={onEdit}>
          <Pencil /> Edit limits and expiry
        </MenuItem>
        <MenuItem onSelect={onRotate}>
          <RefreshCw /> Rotate (new value)
        </MenuItem>
        <MenuSeparator />
        <MenuItem danger onSelect={onRevoke}>
          <Ban /> Revoke
        </MenuItem>
      </MenuContent>
    </Menu>
  )
}

/** One token's details: the apps and addresses seen, its recent requests. */
function TokenSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { data: t } = useToken(id)
  const now = useNow(30_000)
  return (
    <Dialog open={!!id} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="gap-0 p-0">
        <div className="border-b border-line p-5 pr-12">
          <DialogTitle className="text-[15px] font-semibold">{t?.name ?? 'Token'}</DialogTitle>
          <DialogDescription className="num mt-1 text-xs text-faint">{t?.hint}</DialogDescription>
          {t ? (
            <div className="mt-3">
              <ScopeBadges t={t} />
            </div>
          ) : null}
        </div>
        {t ? (
          <div className="grid gap-5 p-5">
            <KV
              rows={[
                ['Status', t.status === 'active' ? 'active' : t.status === 'revoked' ? `revoked ${dateTime(t.revoked_at)}${t.revoke_reason ? `: ${t.revoke_reason}` : ''}` : 'expired'],
                ['Created', `${dateTime(t.created_at)} by ${t.created_by || '—'}${t.imported ? ' (imported)' : ''}`],
                ['Expires', t.expires_at ? dateTime(t.expires_at) : 'never'],
                ['Last used', t.last_used_at ? `${ago(t.last_used_at, now)} · ${t.last_app ?? '—'} from ${t.last_ip ?? '—'}` : 'never'],
                ['Limits', `${t.rpm ? `${t.rpm} a minute` : 'no rate limit'} · ${t.concurrency ? `${t.concurrency} at once` : 'no limit at once'}`],
                ['30 days', `${int(t.usage?.requests ?? 0)} requests · ${compact((t.usage?.prompt_tokens ?? 0) + (t.usage?.output_tokens ?? 0))} tokens · ${int(t.usage?.errors ?? 0)} errors`],
                ...(t.notes ? ([['Notes', t.notes]] as Array<[string, string]>) : []),
              ]}
            />
            <div>
              <div className="eyebrow mb-2">Seen from</div>
              {t.seen.length ? (
                <ul className="grid gap-1 text-[13px]">
                  {t.seen.map((s) => (
                    <li key={`${s.app}-${s.client_ip}`} className="flex items-center gap-2">
                      <span className="font-medium">{s.app}</span>
                      <span className="num text-faint">{s.client_ip}</span>
                      <span className="num ml-auto text-xs text-muted">
                        {int(s.n)} · {ago(s.last, now)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[13px] text-muted">Not used in the last 30 days.</p>
              )}
            </div>
            <div>
              <div className="eyebrow mb-2">Recent requests</div>
              {t.recent.length ? (
                <ul className="grid text-[13px]">
                  {t.recent.map((r) => (
                    <li key={r.rid} className="border-b border-line py-1.5 last:border-0">
                      <Link to="/requests" search={{ rid: r.rid }} className="flex items-center gap-2 hover:text-fg">
                        <span className={cn('size-1.5 shrink-0 rounded-full', (r.status ?? 200) < 400 && r.outcome === 'ok' ? 'bg-ok' : 'bg-error')} aria-hidden />
                        <span className="num text-xs text-faint">{when(r.started_at, now)}</span>
                        <span className="truncate">{r.app}</span>
                        <span className="num ml-auto shrink-0 text-xs text-muted">
                          {compact(r.prompt_tokens)} → {compact(r.output_tokens)} · {ms(r.ttft_ms)} · {tps(r.decode_tok_s)}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[13px] text-muted">No requests yet.</p>
              )}
            </div>
          </div>
        ) : (
          <div className="p-5 text-[13px] text-muted">Loading…</div>
        )}
      </SheetContent>
    </Dialog>
  )
}

/** Tokens: usage sparklines, the last app and address seen, rotate with grace, revoke and disconnect. */
export function TokensPanel({ openId, newOpen, onCloseDetail, onCloseNew }: { openId?: string; newOpen?: boolean; onCloseDetail: () => void; onCloseNew: () => void }) {
  const { data: tokens, isLoading } = useTokens()
  const navigate = useNavigate()
  const now = useNow(30_000)
  const [creating, setCreating] = useState<'create' | 'import' | null>(null)
  const [edit, setEdit] = useState<Token | null>(null)
  const [rotate, setRotate] = useState<Token | null>(null)
  const [revoke, setRevoke] = useState<Token | null>(null)
  const [showOld, setShowOld] = useState(false)
  const active = useMemo(() => (tokens ?? []).filter((t) => t.status === 'active'), [tokens])
  const old = useMemo(() => (tokens ?? []).filter((t) => t.status !== 'active'), [tokens])
  const open = (id: string) => navigate({ to: '/access', search: { token: id }, replace: true })
  const isNew = creating !== null || !!newOpen

  return (
    <Panel className="overflow-hidden">
      <PanelHeader
        icon={<KeyRound />}
        title="Tokens"
        meta={`${active.length} active`}
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={() => setCreating('import')} aria-label="Import a token">
              <Download /> <span className="hidden sm:inline" aria-hidden>Import</span>
            </Button>
            <Button variant="primary" size="sm" onClick={() => setCreating('create')} data-testid="new-token">
              <Plus /> New token
            </Button>
          </>
        }
      />
      {isLoading ? (
        <div className="h-48 animate-pulse" />
      ) : !active.length ? (
        <Empty icon={<KeyRound />} title="No tokens yet" action={<Button variant="primary" onClick={() => setCreating('create')}>Make the first one</Button>}>
          Each app gets its own token, so it can be revoked alone.
        </Empty>
      ) : (
        <>
          {/* desktop table */}
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-faint">
                  <th className="px-4 py-2 font-medium">Name</th>
                  <th className="px-4 py-2 font-medium">Token</th>
                  <th className="px-4 py-2 font-medium">May</th>
                  <th className="px-4 py-2 font-medium">Last used</th>
                  <th className="px-4 py-2 font-medium">30 days</th>
                  <th className="px-4 py-2 font-medium">Expires</th>
                  <th className="w-24 px-2 py-2" />
                </tr>
              </thead>
              <tbody>
                {active.map((t) => (
                  <tr key={t.id} className="group border-b border-line last:border-0 hover:bg-panel-2/40" data-testid={`token-row-${t.name}`}>
                    <td className="px-4 py-2.5 align-top">
                      <button type="button" className="text-left font-medium hover:underline" onClick={() => open(t.id)}>
                        {t.name}
                      </button>
                      {t.kind === 'local-tools' ? <Badge className="ml-2">this server</Badge> : null}
                      {t.notes ? <div className="max-w-[16rem] truncate text-xs text-faint">{t.notes}</div> : null}
                      {t.rotated_at ? <div className="text-xs text-faint">rotated {ago(t.rotated_at, now)}</div> : null}
                    </td>
                    <td className="num px-4 py-2.5 align-top text-xs text-muted">{t.hint}</td>
                    <td className="px-4 py-2.5 align-top">
                      <ScopeBadges t={t} />
                    </td>
                    <td className="px-4 py-2.5 align-top">
                      {t.last_used_at ? (
                        <>
                          <div className="num">{ago(t.last_used_at, now)}</div>
                          <div className="text-xs text-faint">
                            {t.last_app ?? '—'} · <span className="num">{t.last_ip}</span>
                          </div>
                        </>
                      ) : (
                        <span className="text-faint">never</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 align-top">
                      <div className="flex items-center gap-2">
                        <MiniBars values={usageBars(t)} width={72} height={20} color="var(--answer)" label={`${t.name}: requests a day, the last 30 days`} />
                        <span className="num text-xs text-muted">{compact((t.usage?.prompt_tokens ?? 0) + (t.usage?.output_tokens ?? 0))}</span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 align-top">
                      <Expiry t={t} now={now} />
                    </td>
                    <td className="px-2 py-2 align-top">
                      <div className="flex items-center justify-end gap-0.5">
                        <Tip content="Revoke">
                          <Button variant="ghost" size="icon-xs" onClick={() => setRevoke(t)} aria-label={`Revoke ${t.name}`} className="hover:text-error">
                            <Ban />
                          </Button>
                        </Tip>
                        <RowMenu t={t} onEdit={() => setEdit(t)} onRotate={() => setRotate(t)} onRevoke={() => setRevoke(t)} onOpen={() => open(t.id)} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* phone cards: revoke is one tap, then confirm */}
          <ul className="grid divide-y divide-line md:hidden">
            {active.map((t) => (
              <li key={t.id} className="grid gap-2 p-4">
                <div className="flex items-start gap-2">
                  <button type="button" className="min-w-0 text-left" onClick={() => open(t.id)}>
                    <div className="font-medium">{t.name}</div>
                    <div className="num text-xs text-faint">{t.hint}</div>
                  </button>
                  <div className="ml-auto flex items-center gap-1">
                    <Button variant="danger-outline" size="xs" onClick={() => setRevoke(t)}>
                      <Ban /> Revoke
                    </Button>
                    <RowMenu t={t} onEdit={() => setEdit(t)} onRotate={() => setRotate(t)} onRevoke={() => setRevoke(t)} onOpen={() => open(t.id)} />
                  </div>
                </div>
                <ScopeBadges t={t} />
                <div className="flex items-center gap-3 text-xs text-muted">
                  <MiniBars values={usageBars(t)} width={64} height={16} color="var(--answer)" label={`${t.name}: requests a day`} />
                  <span>{t.last_used_at ? `${ago(t.last_used_at, now)} · ${t.last_app ?? ''}` : 'never used'}</span>
                  <span className="ml-auto">
                    <Expiry t={t} now={now} />
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      {old.length ? (
        <div className="border-t border-line">
          <button type="button" onClick={() => setShowOld((s) => !s)} className="flex w-full items-center gap-2 px-4 py-2.5 text-xs text-faint hover:text-fg" aria-expanded={showOld}>
            <ChevronDown className={cn('size-3.5 transition-transform', showOld && 'rotate-180')} aria-hidden />
            {old.length} revoked or expired
          </button>
          {showOld ? (
            <ul className="grid gap-1 px-4 pb-3 text-[13px]">
              {old.map((t) => (
                <li key={t.id} className="flex flex-wrap items-center gap-2 text-muted">
                  <span className="text-fg line-through decoration-faint">{t.name}</span>
                  <span className="num text-xs">{t.hint}</span>
                  <span className="text-xs">
                    {t.status === 'revoked' ? `revoked ${dateTime(t.revoked_at)}${t.revoke_reason ? ` (${t.revoke_reason})` : ''}` : `expired ${dateTime(t.expires_at)}`}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      <NewTokenDialog
        open={isNew}
        mode={creating === 'import' ? 'import' : 'create'}
        onOpenChange={(o) => {
          if (!o) {
            setCreating(null)
            onCloseNew()
          }
        }}
      />
      <EditTokenDialog token={edit} onOpenChange={(o) => !o && setEdit(null)} />
      <RotateDialog token={rotate} onOpenChange={(o) => !o && setRotate(null)} />
      <RevokeDialog token={revoke} onOpenChange={(o) => !o && setRevoke(null)} />
      <TokenSheet id={openId ?? null} onClose={onCloseDetail} />
    </Panel>
  )
}

/** The migration list: clients still calling without a valid token (the last 7 days). */
export function MigrationPanel() {
  const { data } = useAccess()
  const now = useNow(30_000)
  const [make, setMake] = useState<string | null>(null)
  const list = data?.anonymous ?? []
  if (!list.length)
    return (
      <Panel>
        <PanelHeader icon={<UserX />} title="Clients without a token" />
        <Empty title="Every client sends a valid token">Requests refused or let in without one in the last 7 days would show here.</Empty>
      </Panel>
    )
  return (
    <Panel className="overflow-hidden border-warn/30">
      <PanelHeader icon={<TriangleAlert className="text-warn" />} title="Clients still calling without a token" meta="the last 7 days" />
      <ul className="divide-y divide-line">
        {list.map((a) => (
          <li key={`${a.client_ip}-${a.app}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-[13px]" data-testid="anonymous-client">
            <span className="num font-medium">{a.client_ip}</span>
            <span className="text-muted">{a.app}</span>
            <span className="num text-xs text-faint">
              {int(a.n)} request{a.n === 1 ? '' : 's'}
              {a.denied ? ` · ${int(a.denied)} refused` : ''} · {ago(a.last, now)}
            </span>
            {a.reason ? <Badge tone={a.denied ? 'error' : 'warn'}>{a.reason}</Badge> : null}
            <Button size="xs" variant="outline" className="ml-auto" onClick={() => setMake(a.app && a.app !== 'unknown' ? a.app.toLowerCase().replace(/[^a-z0-9.@_ -]+/g, '-').slice(0, 60) : a.client_ip)}>
              <Plus /> Make it a token
            </Button>
          </li>
        ))}
      </ul>
      <NewTokenDialog open={!!make} initialName={make ?? ''} onOpenChange={(o) => !o && setMake(null)} />
    </Panel>
  )
}
