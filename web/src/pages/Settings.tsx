import { Link, useRouterState } from '@tanstack/react-router'
import { Archive, Bell, FileSearch, LockKeyhole, MessagesSquare, MonitorSmartphone, Palette, UserRound, Zap, type LucideIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { AccountSection } from '@/components/settings/Account'
import { AlertsSection } from '@/components/settings/Alerts'
import { AppearanceSection } from '@/components/settings/Appearance'
import { ChatSettingsSection } from '@/components/settings/ChatSettings'
import { BackupSection } from '@/components/settings/Backup'
import { CertificateSection } from '@/components/settings/Certificate'
import { CaptureSection, EnergySection } from '@/components/settings/EnergyCapture'
import { SessionsSection } from '@/components/settings/Sessions'
import { cn, useReducedMotion } from '@/lib/utils'

const SECTIONS: Array<{ id: string; label: string; icon: LucideIcon }> = [
  { id: 'account', label: 'Account', icon: UserRound },
  { id: 'sessions', label: 'Sessions', icon: MonitorSmartphone },
  { id: 'chat', label: 'Chat', icon: MessagesSquare },
  { id: 'alerts', label: 'Alerts', icon: Bell },
  { id: 'energy', label: 'Energy price', icon: Zap },
  { id: 'capture', label: 'Capture', icon: FileSearch },
  { id: 'certificate', label: 'Certificate', icon: LockKeyhole },
  { id: 'backup', label: 'Backup', icon: Archive },
  { id: 'appearance', label: 'Appearance', icon: Palette },
]

/** Which section is on screen: the last one whose top has passed the top quarter of the window. */
function useActiveSection(ids: string[]): string {
  const [active, setActive] = useState(ids[0])
  useEffect(() => {
    const onScroll = () => {
      const line = window.innerHeight * 0.25
      let cur = ids[0]
      for (const id of ids) {
        const el = document.getElementById(id)
        if (el && el.getBoundingClientRect().top - line <= 0) cur = id
      }
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) cur = ids[ids.length - 1]
      setActive(cur)
    }
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
    }
  }, [ids])
  return active
}

export default function Settings() {
  const hash = useRouterState({ select: (s) => s.location.hash })
  const reduced = useReducedMotion()
  const active = useActiveSection(SECTIONS.map((s) => s.id))

  // Arriving at /settings#alerts (the bell's "Rules" link): scroll there, and again as the sections above finish loading
  // and grow, unless you start scrolling yourself.  In-page clicks scroll with the link itself.
  useEffect(() => {
    if (!hash) return
    let mine = true
    const stop = () => {
      mine = false
    }
    const opts: AddEventListenerOptions = { passive: true, once: true }
    window.addEventListener('wheel', stop, opts)
    window.addEventListener('touchmove', stop, opts)
    window.addEventListener('keydown', stop, { once: true })
    const timers = [60, 350, 900, 1600].map((ms) =>
      setTimeout(() => {
        if (mine) document.getElementById(hash)?.scrollIntoView({ block: 'start', behavior: 'auto' })
      }, ms),
    )
    return () => {
      timers.forEach(clearTimeout)
      window.removeEventListener('wheel', stop)
      window.removeEventListener('touchmove', stop)
      window.removeEventListener('keydown', stop)
    }
    // only on arrival: later hash changes come from the section links, which scroll smoothly by themselves
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const scrollOpts: ScrollIntoViewOptions = { block: 'start', behavior: reduced ? 'auto' : 'smooth' }

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[13rem_minmax(0,1fr)] xl:grid-cols-[14rem_minmax(0,56rem)]">
      <nav aria-label="Settings sections" className="min-w-0 lg:sticky lg:top-20 lg:self-start">
        <ul className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 scrollbar-thin lg:mx-0 lg:grid lg:gap-0.5 lg:overflow-visible lg:px-0">
          {SECTIONS.map((s) => {
            const Icon = s.icon
            const on = active === s.id
            return (
              <li key={s.id} className="shrink-0">
                <Link
                  to="/settings"
                  hash={s.id}
                  hashScrollIntoView={scrollOpts}
                  replace
                  aria-current={on ? 'location' : undefined}
                  className={cn(
                    'flex h-8 items-center gap-2 rounded-full border px-3 text-xs font-medium transition-colors lg:rounded-md lg:border-0 lg:px-2.5 lg:text-[13px] lg:font-normal',
                    on
                      ? 'border-fg bg-fg text-bg lg:bg-panel-2 lg:text-fg lg:shadow-[inset_0_0_0_1px_var(--line)]'
                      : 'border-line-strong bg-panel-2 text-muted hover:text-fg lg:bg-transparent lg:hover:bg-panel-2/60',
                  )}
                >
                  <Icon className={cn('size-3.5 lg:size-4', on ? 'lg:text-fg' : 'lg:text-faint')} aria-hidden />
                  {s.label}
                </Link>
              </li>
            )
          })}
        </ul>
      </nav>
      <div className="grid min-w-0 gap-6">
        <AccountSection />
        <SessionsSection />
        <ChatSettingsSection />
        <AlertsSection />
        <EnergySection />
        <CaptureSection />
        <CertificateSection />
        <BackupSection />
        <AppearanceSection />
      </div>
    </div>
  )
}
