import { useQueryClient } from '@tanstack/react-query'
import { RotateCcw, SlidersHorizontal } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Empty, Skeleton } from '@/components/ui/misc'
import { switchPreset } from '@/lib/actions'
import { api, ApiError } from '@/lib/api'
import { qk, useEngineSettings } from '@/lib/queries'
import type { EngineSettings } from '@/lib/types'
import { cn } from '@/lib/utils'
import { Callout, SettingsSection } from './Section'

/** The settings for every preset (presets.json's "settings"): each with what it trades, and a restart to apply them. */
export function EngineSettingsSection() {
  const qc = useQueryClient()
  const { data, isPending } = useEngineSettings()
  const [busy, setBusy] = useState<string | null>(null)
  // the choice shows at once; it goes back if saving it fails
  const [chosen, setChosen] = useState<Record<string, string>>({})
  // whether the running preset has them is unknown when its engine config cannot be read: then a change made here asks
  const [changedHere, setChangedHere] = useState(false)

  const choose = async (key: string, value: string) => {
    setBusy(key)
    setChosen((c) => ({ ...c, [key]: value }))
    try {
      const r = await api.put<EngineSettings>('/api/settings/engine', { key, value })
      qc.setQueryData(qk.engineSettings, r)
      setChangedHere(true)
      void qc.invalidateQueries({ queryKey: qk.presets })
      toast.success('Setting saved', {
        description: r.running ? `Restart ${r.running} to use it (below).` : 'The next preset that starts uses it.',
      })
    } catch (e) {
      toast.error('Saving the setting failed', { description: e instanceof ApiError ? e.message : String(e) })
    } finally {
      setChosen((c) => {
        const { [key]: _gone, ...rest } = c
        return rest
      })
      setBusy(null)
    }
  }

  const restart = async () => {
    if (!data?.running) return
    setBusy('restart')
    if (await switchPreset(data.running, 'idle')) {
      setChangedHere(false)
      void qc.invalidateQueries({ queryKey: qk.engineSettings })
    }
    setBusy(null)
  }

  return (
    <SettingsSection
      id="engine"
      title="Answers and memory"
      icon={SlidersHorizontal}
      description="Choices that apply to every preset. Each one says what it trades; the recommended choice is the default. They are kept when a hardware profile is applied, and the command line has them too (outcrop setting)."
    >
      {isPending ? (
        <Skeleton className="h-40" />
      ) : data === null ? (
        <Empty icon={<SlidersHorizontal />} title="This console has no settings for the engine yet" className="py-6">
          This backend has no <code className="text-xs">GET /api/settings/engine</code>.
        </Empty>
      ) : (
        <div className="grid gap-6">
          {data?.settings.map((s) => (
            <fieldset key={s.key} className="grid gap-2" disabled={busy !== null}>
              <legend className="text-sm font-medium text-fg">{s.title}</legend>
              <p className="text-[13px] leading-relaxed text-muted">{s.about}</p>
              <div className="grid gap-1.5" role="radiogroup" aria-label={s.title}>
                {s.values.map((v) => {
                  const on = v.value === (chosen[s.key] ?? s.value)
                  return (
                    <label
                      key={v.value}
                      className={cn(
                        'flex cursor-pointer items-center gap-2.5 rounded-md border px-3 py-2 text-[13px] transition-colors',
                        on ? 'border-fg/40 bg-panel-2 text-fg' : 'border-line text-muted hover:bg-panel-2/60',
                      )}
                    >
                      <input
                        type="radio"
                        name={`engine-${s.key}`}
                        value={v.value}
                        checked={on}
                        onChange={() => void choose(s.key, v.value)}
                        className="accent-current"
                      />
                      {v.label}
                    </label>
                  )
                })}
              </div>
            </fieldset>
          ))}
          {data?.running && (data.pending || (data.pending === null && changedHere)) ? (
            <Callout tone="warn" icon={RotateCcw} title={`${data.running} is still running with the earlier settings`}>
              <p>
                Restarting it applies them. It takes a minute or two; requests wait at the gateway meanwhile and are
                answered after, and a request already being answered finishes first.
              </p>
              <Button className="mt-2" variant="primary" onClick={restart} loading={busy === 'restart'}>
                Restart {data.running} when idle
              </Button>
            </Callout>
          ) : null}
        </div>
      )}
    </SettingsSection>
  )
}
