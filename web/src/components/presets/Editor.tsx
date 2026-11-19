import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, FileCode2, RotateCcw, Save, ShieldCheck } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { api, ApiError, getOptional } from '@/lib/api'
import { qk, queryClient } from '@/lib/queries'
import type { PresetsRaw, PresetsValidation } from '@/lib/types'
import { cn, useDebounced } from '@/lib/utils'
import { Button } from '../ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/controls'
import { Badge, Empty, Panel, PanelHeader } from '../ui/misc'

function DiffView({ diff }: { diff: string }) {
  const lines = diff.split('\n')
  if (!diff.trim()) return <p className="p-4 text-[13px] text-muted">No changes yet.</p>
  return (
    <pre className="max-h-[480px] overflow-auto p-3 font-mono text-xs leading-relaxed scrollbar-thin">
      {lines.map((l, i) => (
        <div
          key={i}
          className={cn(
            'px-2',
            l.startsWith('+') && !l.startsWith('+++') && 'bg-answer-bg text-answer',
            l.startsWith('-') && !l.startsWith('---') && 'bg-error-bg text-error',
            l.startsWith('@@') && 'text-info',
            (l.startsWith('+++') || l.startsWith('---')) && 'text-faint',
          )}
        >
          {l || ' '}
        </div>
      ))}
    </pre>
  )
}

/** presets.json, with validation as you type, the diff, the arguments each preset will run with, and a guarded save. */
export function PresetEditor() {
  const raw = useQuery({ queryKey: ['presets-raw'], queryFn: () => getOptional<PresetsRaw>('/api/presets/raw'), refetchOnWindowFocus: false })
  const [text, setText] = useState<string | null>(null)
  const [hash, setHash] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [conflict, setConflict] = useState(false)
  const gutter = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (raw.data && text === null) {
      setText(raw.data.text)
      setHash(raw.data.hash)
    }
  }, [raw.data, text])
  const debounced = useDebounced(text, 400)
  const dirty = raw.data && text !== null && text !== raw.data.text
  const v = useQuery({
    queryKey: ['presets-validate', debounced],
    queryFn: () => api.post<PresetsValidation>('/api/presets/validate', { text: debounced }),
    enabled: debounced !== null && !!raw.data,
    placeholderData: (p) => p,
  })
  const lineCount = useMemo(() => (text ?? '').split('\n').length, [text])

  if (raw.isLoading) return <Panel className="h-96 animate-pulse" />
  if (!raw.data)
    return (
      <Panel>
        <Empty icon={<FileCode2 />} title="The preset editor is not on this server yet">
          This console's backend does not have <code>/api/presets/raw</code>. Edit <code>presets.json</code> over SSH meanwhile.
        </Empty>
      </Panel>
    )

  const save = async () => {
    if (!text || !hash) return
    setSaving(true)
    try {
      const r = await api.put<{ hash: string; backup?: string }>('/api/presets/raw', { text, hash })
      setHash(r.hash)
      setConflict(false)
      await queryClient.invalidateQueries({ queryKey: ['presets-raw'] })
      await queryClient.invalidateQueries({ queryKey: qk.presets })
      setText(null)
      toast.success('presets.json saved', {
        description: `${r.backup ? `The old file is kept as ${r.backup}. ` : ''}A preset picks up its changes at its next start.`,
      })
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setConflict(true)
        toast.error('presets.json changed meanwhile', { description: 'Reload it, then make your edit again.' })
      } else if (!(e instanceof ApiError && e.reauth)) {
        toast.error('Saving failed', { description: (e as Error).message })
      }
    } finally {
      setSaving(false)
    }
  }

  const ok = v.data?.ok
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
      <Panel className="overflow-hidden">
        <PanelHeader
          icon={<FileCode2 />}
          title="presets.json"
          meta={dirty ? 'edited' : 'as on the server'}
          actions={
            <>
              <Button
                variant="ghost"
                size="sm"
                disabled={!dirty}
                onClick={() => {
                  setText(raw.data!.text)
                  setConflict(false)
                }}
              >
                <RotateCcw /> Undo all
              </Button>
              <Button variant="primary" size="sm" onClick={save} loading={saving} disabled={!dirty || ok === false}>
                <Save /> Save
              </Button>
            </>
          }
        />
        {conflict ? (
          <div className="flex items-center gap-2 border-b border-warn/30 bg-warn-bg px-4 py-2 text-[13px]" role="alert">
            <AlertTriangle className="size-4 text-warn" aria-hidden />
            Someone changed presets.json since you opened it.
            <Button size="xs" variant="warn-outline" className="ml-auto" onClick={() => { setText(null); setConflict(false); void raw.refetch() }}>
              Reload
            </Button>
          </div>
        ) : null}
        <div className="relative flex max-h-[70vh] min-h-[420px] overflow-auto bg-sunken/50 scrollbar-thin">
          <div ref={gutter} className="sticky left-0 select-none border-r border-line bg-panel px-2 py-3 text-right font-mono text-xs leading-[1.6] text-faint" aria-hidden>
            {Array.from({ length: lineCount }, (_, i) => (
              <div key={i}>{i + 1}</div>
            ))}
          </div>
          <textarea
            aria-label="presets.json"
            value={text ?? ''}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            wrap="off"
            className="min-h-full flex-1 resize-none bg-transparent px-3 py-3 font-mono text-xs leading-[1.6] text-fg outline-none"
            style={{ height: `${lineCount * 1.6 + 1.5}em` }}
            onKeyDown={(e) => {
              if (e.key === 'Tab') {
                e.preventDefault()
                const t = e.currentTarget
                const s = t.selectionStart
                const next = `${t.value.slice(0, s)}  ${t.value.slice(t.selectionEnd)}`
                setText(next)
                requestAnimationFrame(() => t.setSelectionRange(s + 2, s + 2))
              }
              if ((e.metaKey || e.ctrlKey) && e.key === 's') {
                e.preventDefault()
                void save()
              }
            }}
          />
        </div>
      </Panel>
      <Panel className="overflow-hidden">
        <div className="flex items-center gap-2 border-b border-line px-4 py-3" role="status" aria-live="polite">
          {v.isFetching && !v.data ? (
            <span className="text-[13px] text-muted">Checking…</span>
          ) : ok ? (
            <>
              <CheckCircle2 className="size-4 text-ok" aria-hidden />
              <span className="text-[13px]">Valid: every preset renders</span>
            </>
          ) : (
            <>
              <AlertTriangle className="size-4 text-error" aria-hidden />
              <span className="text-[13px] text-error">{v.data?.errors.length ?? 0} problem(s)</span>
            </>
          )}
          <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-faint">
            <ShieldCheck className="size-3" aria-hidden /> saving asks for your password
          </span>
        </div>
        {v.data?.errors.length ? (
          <ul className="grid gap-1 border-b border-line p-3">
            {v.data.errors.map((e, i) => (
              <li key={i} className="rounded-md bg-error-bg px-2.5 py-1.5 font-mono text-xs text-fg">
                {e}
              </li>
            ))}
          </ul>
        ) : null}
        <Tabs defaultValue="diff">
          <TabsList className="px-2">
            <TabsTrigger value="diff">Changes</TabsTrigger>
            <TabsTrigger value="rendered">What each preset runs</TabsTrigger>
          </TabsList>
          <TabsContent value="diff">
            <DiffView diff={dirty ? (v.data?.diff ?? '') : ''} />
          </TabsContent>
          <TabsContent value="rendered" className="max-h-[480px] overflow-auto p-3 scrollbar-thin">
            {Object.entries(v.data?.rendered ?? {}).map(([name, r]) => (
              <details key={name} className="group border-b border-line py-2 last:border-0">
                <summary className="flex cursor-pointer items-center gap-2 text-[13px] font-medium">
                  {name}
                  {(r as { notes?: string[] }).notes?.length ? <Badge tone="warn">{(r as { notes?: string[] }).notes!.length} note</Badge> : null}
                </summary>
                {(r as { notes?: string[] }).notes?.map((n) => (
                  <p key={n} className="mt-1 text-xs text-warn">
                    {n}
                  </p>
                ))}
                <pre className="mt-2 whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-muted">
                  {Object.entries(r.env)
                    .map(([k, val]) => `${k}=${val}`)
                    .join(' ')}
                  {'\n'}strata {r.args.join(' ')}
                </pre>
              </details>
            ))}
          </TabsContent>
        </Tabs>
      </Panel>
    </div>
  )
}
