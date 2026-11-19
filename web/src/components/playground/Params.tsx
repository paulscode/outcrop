import { RotateCcw, SlidersHorizontal } from 'lucide-react'
import { useId } from 'react'
import { DEFAULT_PARAMS, parseTools, type Params } from '@/lib/playground'
import { Button } from '@/components/ui/button'
import { Segmented, Switch } from '@/components/ui/controls'
import { Field, Input, Textarea } from '@/components/ui/input'
import { Tip } from '@/components/ui/menu'
import { PanelHeader } from '@/components/ui/misc'

function num(v: string, lo: number, hi: number, fallback: number): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(hi, Math.max(lo, n))
}

export function summary(p: Params): string {
  return `thinking ${p.thinking ? 'on' : 'off'} · temp ${p.temperature} · ${p.maxTokens.toLocaleString('en-US')} max${p.toolsOn ? ' · tools' : ''}`
}

export function ParamsForm({
  value,
  onChange,
  compare,
  editing,
  setEditing,
  disabled,
  inSheet,
}: {
  value: Params
  onChange: (p: Params) => void
  compare: boolean
  editing: 'A' | 'B'
  setEditing: (c: 'A' | 'B') => void
  disabled?: boolean
  /** in the phone sheet: leave room for its close button */
  inSheet?: boolean
}) {
  const id = useId()
  const tools = value.toolsOn ? parseTools(value.tools) : null
  const set = <K extends keyof Params>(k: K, v: Params[K]) => onChange({ ...value, [k]: v })
  return (
    <div className="grid gap-0">
      <PanelHeader
        className={inSheet ? 'pr-12' : undefined}
        title="Settings"
        icon={<SlidersHorizontal />}
        meta={compare ? `for answer ${editing}` : undefined}
        actions={
          <Tip content="Back to the defaults">
            <Button size="icon-xs" variant="ghost" aria-label="Back to the defaults" onClick={() => onChange({ ...DEFAULT_PARAMS, thinking: value.thinking })}>
              <RotateCcw />
            </Button>
          </Tip>
        }
      />
      <fieldset className="grid gap-4 p-4" disabled={disabled}>
        {compare ? (
          <Segmented
            label="Which answer's settings"
            value={editing}
            onValueChange={(v) => setEditing(v)}
            options={[
              { value: 'A', label: 'Answer A' },
              { value: 'B', label: 'Answer B' },
            ]}
            className="w-full [&>*]:flex-1"
          />
        ) : null}
        <div className="flex items-start justify-between gap-3">
          <div>
            <label htmlFor={`${id}-think`} className="text-[13px] font-medium">
              Thinking
            </label>
            <p className="mt-0.5 text-xs leading-relaxed text-faint">
              The model reasons first (shown folded). Off, replies come much sooner.
            </p>
          </div>
          <Switch id={`${id}-think`} checked={value.thinking} onCheckedChange={(v) => set('thinking', v)} className="mt-0.5" />
        </div>
        <Field label="System prompt" htmlFor={`${id}-sys`} hint="Instructions the model follows for the whole conversation.">
          <Textarea
            id={`${id}-sys`}
            rows={3}
            value={value.system}
            onChange={(e) => set('system', e.target.value)}
            placeholder="You are a concise assistant…"
            className="resize-y"
          />
        </Field>
        <div className="grid grid-cols-3 gap-2">
          <Field label="Max tokens" htmlFor={`${id}-max`}>
            <Input
              id={`${id}-max`}
              type="number"
              inputMode="numeric"
              min={1}
              max={262144}
              step={256}
              value={value.maxTokens}
              onChange={(e) => set('maxTokens', Math.round(num(e.target.value, 1, 262144, value.maxTokens)))}
              className="num"
            />
          </Field>
          <Field label="Temperature" htmlFor={`${id}-temp`}>
            <Input
              id={`${id}-temp`}
              type="number"
              inputMode="decimal"
              min={0}
              max={2}
              step={0.05}
              value={value.temperature}
              onChange={(e) => set('temperature', num(e.target.value, 0, 2, value.temperature))}
              className="num"
            />
          </Field>
          <Field label="Top P" htmlFor={`${id}-topp`}>
            <Input
              id={`${id}-topp`}
              type="number"
              inputMode="decimal"
              min={0}
              max={1}
              step={0.05}
              value={value.topP}
              onChange={(e) => set('topP', num(e.target.value, 0, 1, value.topP))}
              className="num"
            />
          </Field>
        </div>
        <p className="-mt-2 text-xs leading-relaxed text-faint">
          Lower temperature gives steadier answers; higher, more varied ones.
        </p>
        <div className="grid gap-2">
          <div className="flex items-start justify-between gap-3">
            <div>
              <label htmlFor={`${id}-tools`} className="text-[13px] font-medium">
                Tools
              </label>
              <p className="mt-0.5 text-xs leading-relaxed text-faint">Functions the model may call (OpenAI format). Calls are shown, not run.</p>
            </div>
            <Switch id={`${id}-tools`} checked={value.toolsOn} onCheckedChange={(v) => set('toolsOn', v)} className="mt-0.5" />
          </div>
          {value.toolsOn ? (
            <>
              <Textarea
                aria-label="Tools, as JSON"
                rows={9}
                spellCheck={false}
                value={value.tools}
                onChange={(e) => set('tools', e.target.value)}
                aria-invalid={tools ? !tools.ok : undefined}
                className="resize-y font-mono text-[12px] leading-relaxed"
              />
              {tools && !tools.ok ? (
                <p className="text-xs text-error" role="alert">
                  {tools.error}: the tools are not sent until this is fixed.
                </p>
              ) : tools?.ok ? (
                <p className="text-xs text-faint">
                  {tools.tools.length} tool{tools.tools.length === 1 ? '' : 's'}
                </p>
              ) : null}
            </>
          ) : null}
        </div>
      </fieldset>
    </div>
  )
}
