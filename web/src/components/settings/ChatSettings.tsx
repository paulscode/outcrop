import { Download, Globe, MessagesSquare } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { ApiError, download } from '@/lib/api'
import { saveChatSettings, useChatSettings } from '@/lib/chat/data'
import type { ChatSettings } from '@/lib/chat/types'
import { ago } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/controls'
import { Input, Label } from '@/components/ui/input'
import { Dot, Skeleton } from '@/components/ui/misc'
import { Callout, SettingsSection } from './Section'

function Row({ id, title, hint, checked, onChange, disabled }: { id: string; title: string; hint: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4 py-3 first:pt-0">
      <div className="grid gap-0.5">
        <Label htmlFor={id}>{title}</Label>
        <p className="text-xs leading-relaxed text-muted" id={`${id}-hint`}>
          {hint}
        </p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} aria-describedby={`${id}-hint`} className="mt-0.5" />
    </div>
  )
}

function NumberField({ id, label, value, min, max, unit, onSave }: { id: string; label: string; value: number; min: number; max: number; unit: string; onSave: (n: number) => void }) {
  const [v, setV] = useState(String(value))
  useEffect(() => setV(String(value)), [value])
  const n = Number(v)
  const bad = !Number.isInteger(n) || n < min || n > max
  const commit = () => {
    if (!bad && n !== value) onSave(n)
    else if (bad) setV(String(value))
  }
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          inputMode="numeric"
          value={v}
          onChange={(e) => setV(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && commit()}
          aria-invalid={bad || undefined}
          className="num w-20"
        />
        <span className="text-xs text-faint">
          {unit} ({min}–{max})
        </span>
      </div>
    </div>
  )
}

export function ChatSettingsSection() {
  const { data, isPending } = useChatSettings()
  const [busy, setBusy] = useState(false)
  const save = async (p: Partial<ChatSettings>, what: string) => {
    setBusy(true)
    try {
      await saveChatSettings(p)
      toast.success(what)
    } catch (e) {
      if (!(e instanceof ApiError && e.reauth)) toast.error('Saving failed', { description: e instanceof ApiError ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }
  const ws = data?.web_status
  return (
    <SettingsSection
      id="chat"
      title="Chat"
      icon={MessagesSquare}
      description="How Chat, and apps with the web scope, may use the web. Searches and pages run on this server; an app gets them only through a token you gave the web scope (Connect → Web search for your apps)."
      actions={
        <Button size="xs" variant="outline" onClick={() => void download('/api/chats/export', 'chats.json').catch(() => toast.error('Exporting failed'))}>
          <Download aria-hidden /> Export all chats
        </Button>
      }
    >
      {isPending || !data ? (
        <Skeleton className="h-40" />
      ) : (
        <div className="grid gap-5">
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-panel-2/50 px-3 py-2 text-[13px]" role="status" data-testid="web-status">
            <Globe className="size-4 text-faint" aria-hidden />
            <span className="font-medium">Web</span>
            <Dot tone={data.web_ready ? 'ok' : data.web_allowed ? 'warn' : 'neutral'} />
            <span className="text-muted">{data.web_ready ? 'ready' : (ws?.why ?? (data.web_allowed ? 'not reachable' : 'blocked'))}</span>
            {ws ? (
              <span className="ml-auto text-xs text-faint">
                search {ws.search === null ? '—' : ws.search ? 'up' : 'down'} · page fetcher {ws.fetch === null ? '—' : ws.fetch ? 'up' : 'down'} · checked {ago(ws.checked)}
              </span>
            ) : null}
          </div>
          <div className="divide-y divide-line">
            <Row
              id="chat-web-allowed"
              title="Internet access (chat and apps)"
              hint={
                data.web_allowed
                  ? 'Allowed: chats with 🌐 on, and apps whose token has the web scope, may search and read pages. Blocking it greys out 🌐 everywhere and stops the page fetcher.'
                  : 'Blocked: no chat or app can search or open pages. Allowing it asks for your password if you entered it more than 10 minutes ago.'
              }
              checked={data.web_allowed}
              disabled={busy}
              onChange={(v) => void save({ web_allowed: v }, v ? 'Internet access allowed' : 'Internet access blocked')}
            />
            <Row id="chat-web-default" title="Web on for new chats" hint="🌐 starts on in a new chat. A space can set its own default." checked={data.web_default} disabled={busy} onChange={(v) => void save({ web_default: v }, v ? 'New chats start with the web on' : 'New chats start with the web off')} />
            <Row
              id="chat-ask"
              title="Ask before opening pages"
              hint="Each page the model wants to read waits for your Allow. Off by default: the model can only open links from its own searches or that you wrote."
              checked={data.ask_before_open}
              disabled={busy}
              onChange={(v) => void save({ ask_before_open: v }, v ? 'Pages now wait for your yes' : 'Pages open without asking')}
            />
            <Row
              id="chat-apps-any"
              title="Apps may open any public link"
              hint="Off: an app’s open_page opens only links from that token’s own searches, so a page cannot send it elsewhere. On: any public link, for when you paste links into an app. Turning it on asks for your password again."
              checked={!!data.apps_any_link}
              disabled={busy}
              onChange={(v) => void save({ apps_any_link: v }, v ? 'Apps may open any public link' : 'Apps open only links from their own searches')}
            />
            <Row id="chat-suggest" title="Suggest spaces" hint="When a title is written, the header may offer once to move the chat into the space that fits. Nothing moves without your click." checked={data.suggest_spaces} disabled={busy} onChange={(v) => void save({ suggest_spaces: v }, v ? 'Spaces will be suggested' : 'No more space suggestions')} />
          </div>
          <div className="flex flex-wrap gap-6">
            <NumberField id="chat-max-tools" label="Tool calls per answer, at most" value={data.max_tool_calls} min={1} max={20} unit="calls" onSave={(n) => void save({ max_tool_calls: n }, `At most ${n} tool calls per answer`)} />
            <NumberField id="chat-tool-time" label="Time for tools per answer, at most" value={data.tool_time_s} min={10} max={300} unit="seconds" onSave={(n) => void save({ tool_time_s: n }, `At most ${n} s of tools per answer`)} />
          </div>
          {!data.web_allowed ? (
            <Callout tone="neutral" icon={Globe}>
              With internet access blocked, chats still work: they answer from what the model knows.
            </Callout>
          ) : null}
        </div>
      )}
    </SettingsSection>
  )
}
