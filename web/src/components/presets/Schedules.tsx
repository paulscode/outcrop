import { useQuery } from '@tanstack/react-query'
import { CalendarClock, Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { api, ApiError, getOptional } from '@/lib/api'
import { ago } from '@/lib/format'
import { queryClient } from '@/lib/queries'
import { cn } from '@/lib/utils'
import { Button } from '../ui/button'
import { Switch } from '../ui/controls'
import { Input, Select } from '../ui/input'
import { Empty, Panel, PanelHeader } from '../ui/misc'

interface Schedule {
  id?: string
  at: string
  days: string[]
  preset: string
  enabled: boolean
  last_run?: number | null
}

const DAY_LABEL: Record<string, string> = { mon: 'Mo', tue: 'Tu', wed: 'We', thu: 'Th', fri: 'Fr', sat: 'Sa', sun: 'Su' }

/** Scheduled switches: for example quality-1m overnight, speed again in the morning. */
export function Schedules({ presets }: { presets: string[] }) {
  const q = useQuery({ queryKey: ['schedules'], queryFn: () => getOptional<{ schedules: Schedule[]; days: string[] }>('/api/schedules') })
  const [list, setList] = useState<Schedule[] | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (q.data && list === null) setList(q.data.schedules)
  }, [q.data, list])
  if (q.isLoading) return <Panel className="h-48 animate-pulse" />
  if (!q.data)
    return (
      <Panel>
        <Empty icon={<CalendarClock />} title="Scheduled switches are not on this server yet" />
      </Panel>
    )
  const days = q.data.days
  const items = list ?? []
  const dirty = JSON.stringify(items) !== JSON.stringify(q.data.schedules)
  const update = (i: number, patch: Partial<Schedule>) => setList(items.map((it, j) => (j === i ? { ...it, ...patch } : it)))
  const save = async () => {
    setBusy(true)
    try {
      const r = await api.put<{ schedules: Schedule[] }>('/api/schedules', { schedules: items })
      setList(r.schedules)
      await queryClient.invalidateQueries({ queryKey: ['schedules'] })
      toast.success('Schedules saved', { description: 'Each switch waits until no request is running.' })
    } catch (e) {
      toast.error('Saving failed', { description: e instanceof ApiError ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Panel>
      <PanelHeader
        icon={<CalendarClock />}
        title="Scheduled switches"
        meta="for example quality-1m overnight"
        actions={
          <>
            <Button size="sm" variant="ghost" onClick={() => setList([...items, { at: '22:00', days: [], preset: presets.find((p) => p.endsWith('-1m')) ?? presets[0], enabled: true }])}>
              <Plus /> Add
            </Button>
            <Button size="sm" variant={dirty ? 'primary' : 'secondary'} disabled={!dirty} loading={busy} onClick={save}>
              Save
            </Button>
          </>
        }
      />
      {items.length ? (
        <ul className="divide-y divide-line">
          {items.map((s, i) => (
            <li key={s.id ?? `new-${i}`} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <Switch checked={s.enabled} onCheckedChange={(v) => update(i, { enabled: v })} aria-label={`Schedule ${i + 1} on`} />
              <span className="text-[13px] text-muted">Switch to</span>
              <Select aria-label="Preset" value={s.preset} onChange={(e) => update(i, { preset: e.target.value })} className="h-8 w-40">
                {presets.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </Select>
              <span className="text-[13px] text-muted">at</span>
              <Input aria-label="Time" type="time" value={s.at} onChange={(e) => update(i, { at: e.target.value })} className="num h-8 w-28" />
              <div className="flex gap-1" role="group" aria-label="Days (none: every day)">
                {days.map((d) => {
                  const on = s.days.includes(d)
                  return (
                    <button
                      key={d}
                      type="button"
                      aria-pressed={on}
                      onClick={() => update(i, { days: on ? s.days.filter((x) => x !== d) : [...s.days, d] })}
                      className={cn('h-7 w-8 rounded-md border text-[11px] font-medium', on ? 'border-fg bg-fg text-bg' : 'border-line-strong text-muted hover:text-fg')}
                    >
                      {DAY_LABEL[d] ?? d}
                    </button>
                  )
                })}
              </div>
              <span className="text-xs text-faint">{s.days.length ? '' : 'every day'}</span>
              <span className="ml-auto text-xs text-faint">{s.last_run ? `last ran ${ago(s.last_run)}` : 'not run yet'}</span>
              <Button size="icon-xs" variant="ghost" onClick={() => setList(items.filter((_, j) => j !== i))} aria-label="Remove this schedule">
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <Empty title="No scheduled switches">Add one to run a preset at a set time, for example a 1M-token preset overnight for long documents.</Empty>
      )}
    </Panel>
  )
}
