import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router'
import { LogOut, Menu as MenuIcon, Monitor, Moon, MoreHorizontal, Search, Settings, Sun } from 'lucide-react'
import { lazy, Suspense, useEffect, useState } from 'react'
import { signOut } from '@/lib/actions'
import { engineWords, toneBg } from '@/lib/engine'
import { live, metricsStore, riverStore, switchStore, useConnStatus, wireCoreTopics } from '@/lib/live'
import { useServerState } from '@/lib/queries'
import { useStore } from '@/lib/store'
import { setTheme, useTheme, type ThemePref } from '@/lib/theme'
import { cn } from '@/lib/utils'
import { Button } from '../ui/button'
import { Dialog, SheetContent } from '../ui/dialog'
import { Kbd } from '../ui/misc'
import { Menu, MenuContent, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from '../ui/menu'
import { AlertBell } from './AlertBell'
import { AuthPill } from './AuthPill'
import { AuthBanner, ConnectionNotice, GatewayDownNotice, SwitchStrip, UpdateNotice, useAuthMode } from './Banners'
import { Wordmark } from './Logo'
import { NAV, titleFor, type NavItem } from './nav'
import { paletteStore } from './paletteStore'

const CommandPalette = lazy(() => import('./CommandPalette'))

function useEngineDot() {
  const latest = useStore(metricsStore, (s) => s.latest?.engine)
  const sw = useStore(switchStore, (s) => !!s && (s.status === 'running' || s.status === 'waiting'))
  return engineWords(latest, sw)
}

function NavBadge({ item }: { item: NavItem }) {
  const inflight = useStore(riverStore, (s) => Object.keys(s.inflight).length)
  const sw = useStore(switchStore, (s) => !!s && (s.status === 'running' || s.status === 'waiting'))
  const { open } = useAuthMode()
  if (item.to === '/live' && inflight)
    return (
      <span className="num ml-auto rounded-full bg-answer-bg px-1.5 text-[11px] text-answer" aria-label={`${inflight} in flight`}>
        {inflight}
      </span>
    )
  if (item.to === '/presets' && sw) return <span className="ml-auto size-1.5 rounded-full bg-warn" aria-label="switching" />
  if (item.to === '/access' && open)
    return (
      <span className="ml-auto rounded-full bg-warn-bg px-1.5 text-[10px] font-semibold uppercase tracking-wide text-warn">open</span>
    )
  return null
}

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  const path = useRouterState({ select: (s) => s.location.pathname })
  return (
    <nav aria-label="Main" className="grid gap-5">
      {NAV.map((g) => (
        <div key={g.group || 'top'}>
          {g.group ? <div className="eyebrow mb-1.5 px-2.5">{g.group}</div> : null}
          <ul className="grid gap-0.5">
            {g.items.map((it) => {
              const active = it.to === '/' ? path === '/' : path.startsWith(it.to)
              const Icon = it.icon
              return (
                <li key={it.to}>
                  <Link
                    to={it.to}
                    onClick={onNavigate}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] transition-colors',
                      active ? 'bg-panel-2 font-medium text-fg shadow-[inset_0_0_0_1px_var(--line)]' : 'text-muted hover:bg-panel-2/60 hover:text-fg',
                    )}
                  >
                    <Icon className={cn('size-4 shrink-0', active ? 'text-fg' : 'text-faint')} aria-hidden />
                    <span className="truncate">{it.label}</span>
                    <NavBadge item={it} />
                  </Link>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </nav>
  )
}

function ConnLine() {
  const st = useConnStatus()
  const { data } = useServerState()
  const ok = st === 'open'
  return (
    <div className="flex items-center gap-2 px-2.5 text-xs text-faint" role="status">
      <span className={cn('size-1.5 rounded-full', ok ? 'bg-ok' : st === 'reconnecting' ? 'bg-warn' : 'bg-faint')} aria-hidden />
      <span>{ok ? 'Live' : st === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'}</span>
      <span className="ml-auto num">v{data?.version ?? '—'}</span>
    </div>
  )
}

function Sidebar() {
  const { data } = useServerState()
  const dot = useEngineDot()
  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-[228px] flex-col border-r border-line bg-bg lg:flex">
      <div className="flex h-14 items-center gap-2 px-4">
        <Wordmark host={data ? `${data.host} · ${data.server.preset ?? 'stopped'}` : undefined} />
        <span className={cn('ml-auto size-2 rounded-full', toneBg[dot.tone])} title={`Engine: ${dot.label}`} aria-hidden />
      </div>
      <div className="flex-1 overflow-y-auto px-2.5 py-3 scrollbar-thin">
        <NavList />
      </div>
      <div className="border-t border-line py-3">
        <ConnLine />
      </div>
    </aside>
  )
}

function UserMenu() {
  const { data } = useServerState()
  const theme = useTheme()
  const navigate = useNavigate()
  const user = data?.user ?? '…'
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          className="inline-flex h-8 items-center gap-2 rounded-full border border-line-strong bg-panel-2 pl-1 pr-1 text-xs font-medium hover:bg-panel-3 sm:pr-2.5"
          data-testid="user-menu"
        >
          <span className="flex size-6 items-center justify-center rounded-full bg-panel-3 text-[11px] font-semibold uppercase text-fg" aria-hidden>
            {user.slice(0, 1)}
          </span>
          <span className="sr-only">Account menu for </span>
          <span className="sr-only sm:not-sr-only">{user}</span>
        </button>
      </MenuTrigger>
      <MenuContent className="w-56">
        <MenuLabel>Signed in as {user}</MenuLabel>
        <MenuSeparator />
        <MenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as ThemePref)}>
          <MenuRadioItem value="dark">
            <Moon className="size-4 text-faint" aria-hidden /> Dark
          </MenuRadioItem>
          <MenuRadioItem value="light">
            <Sun className="size-4 text-faint" aria-hidden /> Light
          </MenuRadioItem>
          <MenuRadioItem value="system">
            <Monitor className="size-4 text-faint" aria-hidden /> Same as the system
          </MenuRadioItem>
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuItem onSelect={() => navigate({ to: '/settings' })}>
          <Settings /> Settings
        </MenuItem>
        <MenuItem onSelect={() => signOut()}>
          <LogOut /> Sign out
        </MenuItem>
      </MenuContent>
    </Menu>
  )
}

function TopBar({ onMenu }: { onMenu: () => void }) {
  const path = useRouterState({ select: (s) => s.location.pathname })
  const title = titleFor(path)
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
  return (
    <header className="sticky top-0 z-20 border-b border-line bg-bg/85 backdrop-blur-md supports-[backdrop-filter]:bg-bg/70">
      <div className="flex h-14 items-center gap-2 px-3 sm:px-6">
        <Button variant="ghost" size="icon-sm" className="lg:hidden" onClick={onMenu} aria-label="Open the menu">
          <MenuIcon />
        </Button>
        <h1 className="truncate text-[15px] font-semibold tracking-tight">{title}</h1>
        <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
          <button
            type="button"
            onClick={() => paletteStore.set(true)}
            className="hidden h-8 w-64 items-center gap-2 whitespace-nowrap rounded-md border border-line-strong bg-panel-2/70 px-2.5 text-xs text-muted transition-colors hover:bg-panel-2 hover:text-fg md:inline-flex"
            aria-keyshortcuts="Control+K Meta+K"
          >
            <Search className="size-3.5" aria-hidden />
            <span className="truncate">Search or run a command…</span>
            <span className="ml-auto flex gap-0.5" aria-hidden>
              <Kbd>{isMac ? '⌘' : 'Ctrl'}</Kbd>
              <Kbd>K</Kbd>
            </span>
          </button>
          <Button variant="ghost" size="icon-sm" className="md:hidden" onClick={() => paletteStore.set(true)} aria-label="Search or run a command">
            <Search />
          </Button>
          <AuthPill />
          <AlertBell />
          <UserMenu />
        </div>
      </div>
    </header>
  )
}

const TABS: Array<{ to: string; label: string }> = [
  { to: '/chat', label: 'Chat' },
  { to: '/', label: 'Overview' },
  { to: '/live', label: 'Live' },
  { to: '/presets', label: 'Presets' },
]

function MobileTabs({ onMore }: { onMore: () => void }) {
  const path = useRouterState({ select: (s) => s.location.pathname })
  const items = NAV.flatMap((g) => g.items)
  return (
    <nav
      aria-label="Quick"
      className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-line bg-bg/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-md md:hidden"
    >
      {TABS.map((t) => {
        const it = items.find((i) => i.to === t.to)!
        const Icon = it.icon
        const active = t.to === '/' ? path === '/' : path.startsWith(t.to)
        return (
          <Link
            key={t.to}
            to={t.to}
            aria-current={active ? 'page' : undefined}
            className={cn('flex h-14 flex-col items-center justify-center gap-0.5 text-[10.5px] font-medium', active ? 'text-fg' : 'text-faint')}
          >
            <span className="relative">
              <Icon className="size-5" aria-hidden />
            </span>
            {t.label}
          </Link>
        )
      })}
      <button type="button" onClick={onMore} className="flex h-14 flex-col items-center justify-center gap-0.5 text-[10.5px] font-medium text-faint">
        <MoreHorizontal className="size-5" aria-hidden />
        More
      </button>
    </nav>
  )
}

/** Keyboard: ⌘K / Ctrl+K opens the palette; "g" then a letter jumps to a page. */
function useShortcuts() {
  const navigate = useNavigate()
  useEffect(() => {
    let g = 0
    // a dialog other than the palette (a token shown once, a confirmation): no shortcut takes the page away under it
    const dialogOpen = () => !paletteStore.get() && !!document.querySelector('[role="dialog"], [role="alertdialog"]')
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        if (dialogOpen()) return
        e.preventDefault()
        paletteStore.set(!paletteStore.get())
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'o') {
        if (dialogOpen()) return
        e.preventDefault()
        paletteStore.set(false)
        navigate({ to: '/chat' })
        return
      }
      const t = e.target as HTMLElement | null
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (dialogOpen()) return
      if (e.key === '/' && !paletteStore.get()) {
        e.preventDefault()
        // a page's own search box (Chat's), when it is on screen; else the palette
        const own = [...document.querySelectorAll<HTMLElement>('[data-slash-focus]')].find((el) => el.offsetParent !== null)
        if (own) own.focus()
        else paletteStore.set(true)
        return
      }
      if (e.key === 'g') {
        g = Date.now()
        return
      }
      if (g && Date.now() - g < 1200) {
        const it = NAV.flatMap((x) => x.items).find((i) => i.key === e.key)
        g = 0
        if (it) {
          e.preventDefault()
          navigate({ to: it.to })
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navigate])
}

export function AppShell() {
  const [menu, setMenu] = useState(false)
  const palette = useStore(paletteStore)
  const [paletteLoaded, setPaletteLoaded] = useState(false)
  useEffect(() => {
    wireCoreTopics()
    live.start()
  }, [])
  useEffect(() => {
    if (palette) setPaletteLoaded(true)
  }, [palette])
  useShortcuts()
  const { data } = useServerState()
  // Chat fills the window under the top bar, with its own scrolling
  const full = useRouterState({ select: (s) => s.location.pathname === '/chat' || s.location.pathname.startsWith('/chat/') })
  return (
    <div className="min-h-dvh">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[70] focus:rounded-md focus:bg-panel-3 focus:px-3 focus:py-2">
        Skip to the content
      </a>
      <Sidebar />
      <Dialog open={menu} onOpenChange={setMenu}>
        <SheetContent side="left" aria-describedby={undefined} className="p-0">
          <div className="flex h-14 items-center border-b border-line px-4">
            <Wordmark host={data?.host} />
          </div>
          <div className="flex-1 overflow-y-auto px-2.5 py-3">
            <NavList onNavigate={() => setMenu(false)} />
          </div>
          <div className="border-t border-line py-3">
            <ConnLine />
          </div>
          <span className="sr-only" id="menu-title">
            Menu
          </span>
        </SheetContent>
      </Dialog>
      <div className={cn('lg:pl-[228px]', full && 'flex h-dvh flex-col')}>
        <TopBar onMenu={() => setMenu(true)} />
        <UpdateNotice />
        <AuthBanner />
        <GatewayDownNotice />
        <SwitchStrip />
        <main
          id="main"
          className={
            full
              ? 'min-h-0 w-full flex-1 pb-[calc(3.5rem+env(safe-area-inset-bottom))] md:pb-0'
              : 'mx-auto w-full max-w-[1480px] px-3 pb-24 pt-4 sm:px-6 sm:pt-5 md:pb-10'
          }
        >
          <Outlet />
        </main>
      </div>
      <MobileTabs onMore={() => setMenu(true)} />
      <ConnectionNotice />
      {paletteLoaded ? (
        <Suspense fallback={null}>
          <CommandPalette />
        </Suspense>
      ) : null}
    </div>
  )
}
