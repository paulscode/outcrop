import { Keyboard, Monitor, Moon, Palette, Sun } from 'lucide-react'
import { Segmented } from '@/components/ui/controls'
import { Kbd } from '@/components/ui/misc'
import { setTheme, useTheme, type ThemePref } from '@/lib/theme'
import { useReducedMotion } from '@/lib/utils'
import { SettingsSection } from './Section'

const SHORTCUTS: Array<{ keys: string[]; what: string }> = [
  { keys: ['⌘/Ctrl', 'K'], what: 'Search pages and run commands' },
  { keys: ['/'], what: 'The same, from anywhere outside a text field' },
  { keys: ['⌘/Ctrl', '⇧', 'O'], what: 'A new chat' },
  { keys: ['g', 'h'], what: 'Chat' },
  { keys: ['g', 'o'], what: 'Overview' },
  { keys: ['g', 'l'], what: 'Live' },
  { keys: ['g', 'r'], what: 'Requests' },
  { keys: ['g', 'p'], what: 'Presets' },
  { keys: ['g', 'a'], what: 'Access' },
  { keys: ['g', 't'], what: 'Timeline' },
]

export function AppearanceSection() {
  const theme = useTheme()
  const reduced = useReducedMotion()
  return (
    <SettingsSection id="appearance" title="Appearance" icon={Palette} description="These live in this browser only.">
      <div className="grid gap-6 md:grid-cols-2">
        <div className="grid content-start gap-3">
          <span className="text-[13px] font-medium text-fg">Theme</span>
          <Segmented<ThemePref>
            className="w-fit"
            label="Theme"
            value={theme}
            onValueChange={setTheme}
            options={[
              { value: 'dark', label: (<><Moon aria-hidden /> Dark</>) },
              { value: 'light', label: (<><Sun aria-hidden /> Light</>) },
              { value: 'system', label: (<><Monitor aria-hidden /> System</>) },
            ]}
          />
          <p className="text-xs leading-relaxed text-muted">
            Motion follows your system’s “reduce motion” setting
            {reduced ? ', which is on: counters jump to new values and nothing slides.' : ': counters ease and new requests slide in. Turn it on in the system to keep everything still.'}
          </p>
        </div>
        <div className="grid content-start gap-3">
          <span className="flex items-center gap-2 text-[13px] font-medium text-fg">
            <Keyboard className="size-4 text-faint" aria-hidden /> Keyboard
          </span>
          <ul className="grid gap-1.5 text-xs">
            {SHORTCUTS.map((s) => (
              <li key={s.what} className="flex items-center justify-between gap-3">
                <span className="text-muted">{s.what}</span>
                <span className="flex shrink-0 gap-1">
                  {s.keys.map((k) => (
                    <Kbd key={k}>{k}</Kbd>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </SettingsSection>
  )
}
