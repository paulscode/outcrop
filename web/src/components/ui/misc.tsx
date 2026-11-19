import { Check, Copy } from 'lucide-react'
import * as React from 'react'
import { toast } from 'sonner'
import { copyText } from '@/lib/api'
import { cn } from '@/lib/utils'

// ---------------------------------------------------------------------------------------------------------- panel
export function Panel({ className, ...props }: React.HTMLAttributes<HTMLElement> & { as?: 'section' | 'div' }) {
  return <section className={cn('panel relative min-w-0', className)} {...props} />
}

export function PanelHeader({
  title,
  icon,
  meta,
  actions,
  className,
  id,
}: {
  title: React.ReactNode
  icon?: React.ReactNode
  meta?: React.ReactNode
  actions?: React.ReactNode
  className?: string
  id?: string
}) {
  return (
    <header className={cn('flex min-h-11 items-center gap-2 border-b border-line px-4 py-2.5', className)}>
      {icon ? <span className="text-faint [&_svg]:size-4">{icon}</span> : null}
      <h2 id={id} className="text-[13px] font-semibold tracking-tight text-fg">
        {title}
      </h2>
      {meta ? <div className="hidden min-w-0 truncate text-xs text-faint sm:block">{meta}</div> : null}
      {actions ? <div className="ml-auto flex shrink-0 items-center gap-1.5">{actions}</div> : null}
    </header>
  )
}

// ---------------------------------------------------------------------------------------------------------- badge
type Tone = 'neutral' | 'read' | 'think' | 'answer' | 'warn' | 'error' | 'ok' | 'info' | 'solid'
const tones: Record<Tone, string> = {
  neutral: 'border-line-strong text-muted bg-panel-2',
  read: 'border-read/30 text-read bg-read-bg',
  think: 'border-think/30 text-think bg-think-bg',
  answer: 'border-answer/30 text-answer bg-answer-bg',
  warn: 'border-warn/35 text-warn bg-warn-bg',
  error: 'border-error/35 text-error bg-error-bg',
  ok: 'border-ok/30 text-ok bg-ok-bg',
  info: 'border-info/30 text-info bg-panel-2',
  solid: 'border-transparent bg-fg text-bg',
}

export function Badge({
  tone = 'neutral',
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return (
    <span
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-[5px] border px-1.5 text-[11px] font-medium leading-none [&_svg]:size-3',
        tones[tone],
        className,
      )}
      {...props}
    />
  )
}

/** A small colored dot with a text label (color is never the only signal). */
export function Dot({ tone, pulse, className }: { tone: Tone; pulse?: boolean; className?: string }) {
  const bg: Record<Tone, string> = {
    neutral: 'bg-faint',
    read: 'bg-read',
    think: 'bg-think',
    answer: 'bg-answer',
    warn: 'bg-warn',
    error: 'bg-error',
    ok: 'bg-ok',
    info: 'bg-info',
    solid: 'bg-fg',
  }
  return (
    <span className={cn('relative inline-flex size-2 shrink-0', className)} aria-hidden>
      {pulse ? <span className={cn('absolute inset-0 rounded-full animate-pulse-ring', bg[tone])} /> : null}
      <span className={cn('relative inline-flex size-2 rounded-full', bg[tone])} />
    </span>
  )
}

// ------------------------------------------------------------------------------------------------------------ kbd
export function Kbd({ className, ...props }: React.HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded border border-line-strong bg-panel-2 px-1 font-mono text-[10.5px] font-medium text-faint',
        className,
      )}
      {...props}
    />
  )
}

// ------------------------------------------------------------------------------------------------------- skeleton
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-panel-3/80', className)} aria-hidden />
}

// ---------------------------------------------------------------------------------------------------- empty state
export function Empty({
  icon,
  title,
  children,
  action,
  className,
}: {
  icon?: React.ReactNode
  title: React.ReactNode
  children?: React.ReactNode
  action?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 px-6 py-10 text-center', className)}>
      {icon ? <div className="mb-1 text-faint [&_svg]:size-6">{icon}</div> : null}
      <p className="text-[13px] font-medium text-fg">{title}</p>
      {children ? <div className="max-w-md text-[13px] leading-relaxed text-muted">{children}</div> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------- copy button
export function CopyButton({
  value,
  label = 'Copy',
  className,
  size = 'sm',
  showLabel = false,
  toastText,
}: {
  value: string
  label?: string
  className?: string
  size?: 'xs' | 'sm'
  showLabel?: boolean
  toastText?: string
}) {
  const [done, setDone] = React.useState(false)
  React.useEffect(() => {
    if (!done) return
    const id = setTimeout(() => setDone(false), 1600)
    return () => clearTimeout(id)
  }, [done])
  return (
    <button
      type="button"
      onClick={async (e) => {
        e.stopPropagation()
        const ok = await copyText(value)
        if (ok) {
          setDone(true)
          if (toastText) toast.success(toastText)
        } else toast.error('Copying failed: select the text and copy it by hand')
      }}
      aria-label={done ? 'Copied' : label}
      title={label}
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-md border border-line-strong bg-panel-2 text-muted transition-colors hover:bg-panel-3 hover:text-fg',
        size === 'xs' ? 'h-6 px-1.5 text-[11px] [&_svg]:size-3' : 'h-7 px-2 text-xs [&_svg]:size-3.5',
        done && 'text-ok',
        className,
      )}
    >
      {done ? <Check /> : <Copy />}
      {showLabel ? <span>{done ? 'Copied' : label}</span> : null}
    </button>
  )
}

// -------------------------------------------------------------------------------------------------- definition list
export function Stat({
  label,
  value,
  sub,
  className,
  title,
}: {
  label: React.ReactNode
  value: React.ReactNode
  sub?: React.ReactNode
  className?: string
  title?: string
}) {
  return (
    <div className={cn('min-w-0', className)} title={title}>
      <div className="text-[11px] font-medium uppercase tracking-wider text-faint">{label}</div>
      <div className="num mt-0.5 truncate text-[15px] text-fg">{value}</div>
      {sub ? <div className="mt-0.5 truncate text-xs text-faint">{sub}</div> : null}
    </div>
  )
}

export function KV({ rows, className }: { rows: Array<[React.ReactNode, React.ReactNode]>; className?: string }) {
  return (
    <dl className={cn('grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-4 gap-y-1.5 text-[13px]', className)}>
      {rows.map(([k, v], i) => (
        <React.Fragment key={i}>
          <dt className="text-faint">{k}</dt>
          <dd className="min-w-0 break-words text-fg">{v}</dd>
        </React.Fragment>
      ))}
    </dl>
  )
}

/** A screen-reader-only live region that announces status changes. */
export function LiveRegion({ message }: { message: string }) {
  return (
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {message}
    </div>
  )
}
