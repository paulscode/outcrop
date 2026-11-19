import { useNavigate, useSearch } from '@tanstack/react-router'
import { CheckCircle2, FileCode2, History, Layers, XCircle } from 'lucide-react'
import { useState } from 'react'
import { PresetEditor } from '@/components/presets/Editor'
import { LaunchSequence, useSwitch } from '@/components/presets/LaunchSequence'
import { PresetCard } from '@/components/presets/PresetCard'
import { Schedules } from '@/components/presets/Schedules'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/controls'
import { Empty, Panel, PanelHeader } from '@/components/ui/misc'
import { dateTime, dur } from '@/lib/format'
import { usePresets, useSwitches } from '@/lib/queries'
import { useNow } from '@/lib/utils'

function SwitchHistory() {
  const { data } = useSwitches()
  if (!data?.length)
    return (
      <Panel>
        <Empty icon={<History />} title="No switches yet">
          Every switch is recorded here with its phases and how long each took.
        </Empty>
      </Panel>
    )
  return (
    <Panel className="overflow-hidden">
      <PanelHeader icon={<History />} title="Switches" meta="the newest first" />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-[13px]">
          <thead>
            <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-faint">
              <th className="px-4 py-2 font-medium">When</th>
              <th className="px-4 py-2 font-medium">From → to</th>
              <th className="px-4 py-2 font-medium">By</th>
              <th className="px-4 py-2 font-medium">Phases</th>
              <th className="px-4 py-2 text-right font-medium">Took</th>
            </tr>
          </thead>
          <tbody>
            {data.map((s) => {
              const total = s.ended_at ? s.ended_at - s.started_at : null
              return (
                <tr key={s.id} className="border-b border-line last:border-0 hover:bg-panel-2/50">
                  <td className="num whitespace-nowrap px-4 py-2.5 text-muted">{dateTime(s.started_at)}</td>
                  <td className="px-4 py-2.5">
                    <span className="inline-flex items-center gap-1.5">
                      {s.ok ? <CheckCircle2 className="size-3.5 text-ok" aria-label="succeeded" /> : <XCircle className="size-3.5 text-error" aria-label="failed" />}
                      <span className="text-muted">{s.from_preset ?? '—'}</span> → <span className="font-medium">{s.to_preset}</span>
                    </span>
                    {s.error ? <div className="mt-1 max-w-md truncate text-xs text-error">{s.error}</div> : null}
                  </td>
                  <td className="px-4 py-2.5 text-muted">{s.by}</td>
                  <td className="px-4 py-2.5">
                    {/* each phase as a segment of the total time */}
                    <div className="flex h-2 w-56 overflow-hidden rounded-full bg-line" role="img" aria-label="phases by duration">
                      {s.phases
                        .filter((p) => p.end && p.start)
                        .map((p, i) => (
                          <div
                            key={i}
                            title={`${p.label}: ${dur((p.end ?? 0) - p.start)}`}
                            className="h-full border-r border-panel last:border-0"
                            style={{
                              width: `${(((p.end ?? 0) - p.start) / (total || 1)) * 100}%`,
                              backgroundColor: p.key === 'experts' ? 'var(--layer-1)' : p.key === 'stop' ? 'var(--layer-7)' : p.key === 'weights' ? 'var(--layer-2)' : p.key === 'gpu_cache' ? 'var(--layer-5)' : 'var(--layer-3)',
                            }}
                          />
                        ))}
                    </div>
                  </td>
                  <td className="num px-4 py-2.5 text-right">{total ? dur(total, { precise: true }) : '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}

export default function Presets() {
  const search = useSearch({ strict: false }) as { tab?: string }
  const navigate = useNavigate()
  const { data, isLoading } = usePresets()
  const sw = useSwitch(data?.switch)
  const now = useNow(5000)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const active = sw && (sw.status === 'running' || sw.status === 'waiting')
  const recent = sw && !active && sw.ended_at && now - sw.ended_at < 15 * 60 && dismissed !== sw.id
  const tab = search.tab === 'editor' || search.tab === 'history' ? search.tab : 'presets'
  const ctx262 = data?.presets.filter((p) => p.context <= 262144) ?? []
  const ctx1m = data?.presets.filter((p) => p.context > 262144) ?? []

  return (
    <div className="grid gap-4">
      {sw && (active || recent) ? <LaunchSequence sw={sw} onDismiss={() => setDismissed(sw.id)} /> : null}
      <Tabs value={tab} onValueChange={(v) => navigate({ to: '/presets', search: v === 'presets' ? {} : { tab: v }, replace: true })}>
        <TabsList>
          <TabsTrigger value="presets">
            <Layers /> Presets
          </TabsTrigger>
          <TabsTrigger value="history">
            <History /> Switches and schedules
          </TabsTrigger>
          <TabsTrigger value="editor">
            <FileCode2 /> Editor
          </TabsTrigger>
        </TabsList>
        <TabsContent value="presets" className="mt-4 grid gap-6">
          {isLoading ? (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-96 animate-pulse rounded-xl border border-line bg-panel" />
              ))}
            </div>
          ) : (
            <>
              <section aria-labelledby="h-262">
                <div className="mb-3 flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
                  <h2 id="h-262" className="text-[13px] font-semibold">
                    262K context
                  </h2>
                  <p className="text-xs text-faint">The everyday presets: the same model at three sizes of its expert pack.</p>
                </div>
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                  {ctx262.map((p) => (
                    <PresetCard key={p.name} p={p} switching={active ? sw!.to : null} />
                  ))}
                </div>
              </section>
              {ctx1m.length ? (
                <section aria-labelledby="h-1m">
                  <div className="mb-3 flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
                    <h2 id="h-1m" className="text-[13px] font-semibold">
                      1M context
                    </h2>
                    <p className="text-xs text-faint">For very long documents (YaRN ×4); slightly different answers at every length.</p>
                  </div>
                  <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                    {ctx1m.map((p) => (
                      <PresetCard key={p.name} p={p} switching={active ? sw!.to : null} />
                    ))}
                  </div>
                </section>
              ) : null}
            </>
          )}
        </TabsContent>
        <TabsContent value="history" className="mt-4 grid gap-4">
          <Schedules presets={data?.presets.map((p) => p.name) ?? []} />
          <SwitchHistory />
        </TabsContent>
        <TabsContent value="editor" className="mt-4">
          <PresetEditor />
        </TabsContent>
      </Tabs>
    </div>
  )
}
