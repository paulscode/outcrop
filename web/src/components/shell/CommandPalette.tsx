import { useNavigate, useRouterState } from '@tanstack/react-router'
import { Command } from 'cmdk'
import {
  ArrowRight,
  BookOpenText,
  FolderInput,
  MessageSquarePlus,
  MessagesSquare,
  CheckCheck,
  Clipboard,
  FlaskConical,
  KeyRound,
  Layers,
  ListFilter,
  LogOut,
  Moon,
  Plus,
  RotateCcw,
  ShieldCheck,
  ShieldOff,
  Star,
  Sun,
} from 'lucide-react'
import { Dialog as D } from 'radix-ui'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { copyText } from '@/lib/api'
import { APPS } from '@/lib/apps'
import { ackAlerts, closeApi, openApi, setDefaultPreset, signOut, switchPreset } from '@/lib/actions'
import { useRequestsSummary, useServerState, useSessions, useTokens } from '@/lib/queries'
import { useStore } from '@/lib/store'
import { setTheme, useResolvedTheme } from '@/lib/theme'
import { day, hoursSinceMidnight } from '@/lib/format'
import { openChatUi, useChatSearch, useSpaces } from '@/lib/chat/data'
import { useDebounced } from '@/lib/utils'
import { MOD } from '../chat/bits'
import { Kbd } from '../ui/misc'
import { useAuthMode } from './Banners'
import { NAV } from './nav'
import { paletteStore } from './paletteStore'

const item =
  'flex cursor-pointer select-none items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] text-fg outline-none data-[selected=true]:bg-panel-3 data-[disabled=true]:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-faint'
const group =
  '[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-faint'

export default function CommandPalette() {
  const open = useStore(paletteStore)
  const navigate = useNavigate()
  const { data: st } = useServerState()
  const { data: tokens } = useTokens()
  const { data: sessions } = useSessions()
  const { data: summary } = useRequestsSummary(hoursSinceMidnight())
  const { open: apiOpen } = useAuthMode()
  const theme = useResolvedTheme()
  const [search, setSearch] = useState('')
  const myIp = sessions?.find((s) => s.current)?.ip ?? null
  const { data: spaces = [] } = useSpaces()
  const path = useRouterState({ select: (s) => s.location.pathname })
  const openChat = /^\/chat\/([^/]+)$/.exec(path)?.[1] ?? null
  const dq = useDebounced(search.trim(), 180)
  const found = useChatSearch(dq.length >= 2 ? dq : '')
  const chatHits = dq.length >= 2 ? (found.data?.results ?? []).slice(0, 8) : []

  const close = () => {
    paletteStore.set(false)
    setSearch('')
  }
  const run = (fn: () => unknown) => () => {
    close()
    void fn()
  }
  const copy = (label: string, value?: string) => async () => {
    close()
    if (!value) return toast.error(`No ${label} yet`)
    if (await copyText(value)) toast.success(`Copied the ${label}`, { description: value })
  }

  const presets = st?.server.presets ?? []
  const current = st?.server.preset ?? null
  const apps = useMemo(() => (summary?.by_app ?? []).map((a) => a.app).filter(Boolean), [summary])

  return (
    <D.Root open={open} onOpenChange={(o) => (o ? paletteStore.set(true) : close())}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <D.Content
          className="fixed left-1/2 top-[12vh] z-50 w-[min(640px,calc(100vw-1.5rem))] -translate-x-1/2 overflow-hidden rounded-xl border border-line-strong bg-panel shadow-2xl outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.98]"
          aria-describedby={undefined}
        >
          <D.Title className="sr-only">Search or run a command</D.Title>
          <Command label="Command palette" loop className="flex max-h-[min(560px,70vh)] flex-col">
            <div className="flex items-center gap-2 border-b border-line px-3">
              <ListFilter className="size-4 text-faint" aria-hidden />
              <Command.Input
                autoFocus
                value={search}
                onValueChange={setSearch}
                placeholder="Search chats, switch to speed, open the API…"
                className="h-12 flex-1 bg-transparent text-[14px] text-fg outline-none placeholder:text-faint"
              />
              <Kbd>Esc</Kbd>
            </div>
            <Command.List className="overflow-y-auto p-1.5 scrollbar-thin">
              <Command.Empty className="px-3 py-8 text-center text-[13px] text-muted">Nothing matches “{search}”.</Command.Empty>

              <Command.Group heading="Chat" className={group}>
                <Command.Item className={item} onSelect={run(() => navigate({ to: '/chat' }))} keywords={['new', 'chat', 'ask', 'conversation']}>
                  <MessageSquarePlus /> New chat
                  <span className="ml-auto flex gap-0.5">
                    <Kbd>{MOD}</Kbd>
                    <Kbd>⇧</Kbd>
                    <Kbd>O</Kbd>
                  </span>
                </Command.Item>
                {spaces.map((sp) => (
                  <Command.Item
                    key={sp.id}
                    className={item}
                    value={`New chat in ${sp.name}`}
                    keywords={['new chat in', 'space', sp.name]}
                    onSelect={run(() => navigate({ to: '/chat', search: { space: sp.id } }))}
                  >
                    <MessageSquarePlus /> New chat in {sp.emoji ? `${sp.emoji} ` : ''}
                    {sp.name}
                  </Command.Item>
                ))}
                {openChat ? (
                  <Command.Item className={item} onSelect={run(() => openChatUi({ move: [openChat] }))} keywords={['move', 'space', 'folder']}>
                    <FolderInput /> Move this chat to…
                  </Command.Item>
                ) : null}
                <Command.Item className={item} onSelect={run(() => navigate({ to: '/strata' }))} keywords={['strata', 'engine', 'page', 'iframe']}>
                  <BookOpenText /> The engine’s own page (Strata)
                </Command.Item>
              </Command.Group>

              {chatHits.length ? (
                <Command.Group heading="Chats" className={group}>
                  {chatHits.map((r) => {
                    const sp = spaces.find((x) => x.id === r.chat.space_id)
                    return (
                      <Command.Item
                        key={`${r.chat.id}-${r.msg_id}`}
                        className={item}
                        value={`chat ${r.chat.id} ${r.msg_id ?? ''}`}
                        keywords={[search]}
                        onSelect={run(() => navigate({ to: '/chat/$chatId', params: { chatId: r.chat.id }, search: r.msg_id ? { msg: r.msg_id } : {} }))}
                      >
                        <MessagesSquare />
                        <span className="grid min-w-0 flex-1">
                          <span className="truncate">{r.chat.title || 'Untitled chat'}</span>
                          {r.snippet ? <span className="truncate text-xs text-faint">{r.snippet.text}</span> : null}
                        </span>
                        {sp ? <span className="shrink-0 text-xs text-faint">{sp.emoji} {sp.name}</span> : null}
                        <span className="num shrink-0 text-xs text-faint">{day(r.chat.updated_at)}</span>
                      </Command.Item>
                    )
                  })}
                </Command.Group>
              ) : null}

              <Command.Group heading="Actions" className={group}>
                {apiOpen ? (
                  <Command.Item className={item} onSelect={run(closeApi)} keywords={['close', 'enforce', 'lock', 'api']}>
                    <ShieldCheck /> Close the API now
                  </Command.Item>
                ) : null}
                {[15, 60, 240].map((m) => (
                  <Command.Item key={m} className={item} onSelect={run(() => openApi(m))} keywords={['open', 'api', 'test', 'without token']}>
                    <ShieldOff /> Open the API for {m < 60 ? `${m} min` : `${m / 60} h`}
                    <span className="ml-auto text-xs text-faint">whole LAN</span>
                  </Command.Item>
                ))}
                {myIp ? (
                  <Command.Item
                    className={item}
                    onSelect={run(() => openApi(15, [myIp]))}
                    keywords={['open', 'api', 'this laptop', 'this device', 'me', myIp]}
                  >
                    <ShieldOff /> Open the API for 15 min for this device
                    <span className="num ml-auto text-xs text-faint">{myIp}</span>
                  </Command.Item>
                ) : null}
                {presets
                  .filter((p) => p !== current)
                  .map((p) => (
                    <Command.Item key={p} className={item} onSelect={run(() => switchPreset(p))} keywords={['switch', 'preset', 'load', p]}>
                      <Layers /> Switch to {p}
                    </Command.Item>
                  ))}
                {current ? (
                  <Command.Item className={item} onSelect={run(() => switchPreset(current))} keywords={['restart', 'reload']}>
                    <RotateCcw /> Restart {current}
                  </Command.Item>
                ) : null}
                <Command.Item className={item} onSelect={run(() => navigate({ to: '/access', search: { new: '1' } }))} keywords={['create', 'token', 'key', 'new']}>
                  <Plus /> New token…
                </Command.Item>
                {APPS.map((a) => (
                  <Command.Item
                    key={a.id}
                    className={item}
                    onSelect={run(() => navigate({ to: '/connect', search: { app: a.id } }))}
                    keywords={['new token for', 'connect', 'setup', a.name]}
                    value={`New token for ${a.name}`}
                  >
                    <KeyRound /> New token for {a.name}
                    <span className="ml-auto text-xs text-faint">Connect</span>
                  </Command.Item>
                ))}
                <Command.Item className={item} onSelect={copy('OpenAI base URL', st?.urls.openai)} keywords={['copy', 'url', 'openai']}>
                  <Clipboard /> Copy the OpenAI base URL
                  <span className="num ml-auto truncate text-xs text-faint">{st?.urls.openai}</span>
                </Command.Item>
                <Command.Item className={item} onSelect={copy('Anthropic base URL', st?.urls.anthropic)} keywords={['copy', 'url', 'anthropic', 'claude']}>
                  <Clipboard /> Copy the Anthropic base URL
                  <span className="num ml-auto truncate text-xs text-faint">{st?.urls.anthropic}</span>
                </Command.Item>
                <Command.Item className={item} onSelect={copy('Ollama URL', st?.urls.ollama)} keywords={['copy', 'url', 'ollama']}>
                  <Clipboard /> Copy the Ollama URL
                  <span className="num ml-auto truncate text-xs text-faint">{st?.urls.ollama}</span>
                </Command.Item>
                {presets
                  .filter((p) => p !== st?.server.default)
                  .map((p) => (
                    <Command.Item key={`d-${p}`} className={item} onSelect={run(() => setDefaultPreset(p))} keywords={['boot', 'default', 'startup', p]}>
                      <Star /> Make {p} the boot default
                    </Command.Item>
                  ))}
                <Command.Item className={item} onSelect={run(() => navigate({ to: '/lab', search: { run: 'quickbench' } }))} keywords={['benchmark', 'speed', 'test']}>
                  <FlaskConical /> Run quickbench…
                </Command.Item>
                <Command.Item className={item} onSelect={run(() => ackAlerts())} keywords={['alerts', 'read', 'acknowledge']}>
                  <CheckCheck /> Mark all alerts read
                </Command.Item>
                <Command.Item className={item} onSelect={run(() => setTheme(theme === 'dark' ? 'light' : 'dark'))} keywords={['theme', 'dark', 'light', 'mode']}>
                  {theme === 'dark' ? <Sun /> : <Moon />} Use the {theme === 'dark' ? 'light' : 'dark'} theme
                </Command.Item>
                <Command.Item className={item} onSelect={run(signOut)} keywords={['logout', 'sign out']}>
                  <LogOut /> Sign out
                </Command.Item>
              </Command.Group>

              {apps.length ? (
                <Command.Group heading="Requests today" className={group}>
                  {apps.map((a) => (
                    <Command.Item
                      key={a}
                      className={item}
                      value={`Requests from ${a} today`}
                      onSelect={run(() => navigate({ to: '/requests', search: { app: a } }))}
                    >
                      <ListFilter /> Requests from {a} today
                    </Command.Item>
                  ))}
                </Command.Group>
              ) : null}

              {tokens?.length ? (
                <Command.Group heading="Tokens" className={group}>
                  {tokens
                    .filter((t) => t.status === 'active')
                    .map((t) => (
                      <Command.Item
                        key={t.id}
                        className={item}
                        value={`token ${t.name} ${t.id}`}
                        onSelect={run(() => navigate({ to: '/access', search: { token: t.id } }))}
                      >
                        <KeyRound /> {t.name}
                        <span className="num ml-auto text-xs text-faint">{t.hint}</span>
                      </Command.Item>
                    ))}
                </Command.Group>
              ) : null}

              <Command.Group heading="Pages" className={group}>
                {NAV.flatMap((g) => g.items).map((n) => {
                  const Icon = n.icon
                  return (
                    <Command.Item key={n.to} className={item} onSelect={run(() => navigate({ to: n.to }))} keywords={[n.keywords ?? '']} value={`Go to ${n.label}`}>
                      <Icon /> {n.label}
                      {n.key ? (
                        <span className="ml-auto flex gap-0.5">
                          <Kbd>g</Kbd>
                          <Kbd>{n.key}</Kbd>
                        </span>
                      ) : (
                        <ArrowRight className="ml-auto" />
                      )}
                    </Command.Item>
                  )
                })}
              </Command.Group>
            </Command.List>
            <div className="flex items-center gap-3 border-t border-line px-3 py-2 text-[11px] text-faint">
              <span className="flex items-center gap-1">
                <Kbd>↑</Kbd>
                <Kbd>↓</Kbd> move
              </span>
              <span className="flex items-center gap-1">
                <Kbd>↵</Kbd> run
              </span>
              <span className="ml-auto">
                <Kbd>g</Kbd> then a letter jumps to a page
              </span>
            </div>
          </Command>
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}
