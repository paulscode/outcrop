import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Panel, PanelHeader } from '@/components/ui/misc'
import { cn } from '@/lib/utils'

/** One section of the Settings page: an anchor (#id), a panel with a header, a plain sentence, the controls. */
export function SettingsSection({
  id,
  title,
  icon: Icon,
  meta,
  description,
  actions,
  children,
  className,
}: {
  id: string
  title: string
  icon: LucideIcon
  meta?: ReactNode
  description?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className={cn('scroll-mt-20', className)}>
      <Panel>
        <PanelHeader id={`${id}-title`} title={title} icon={<Icon />} meta={meta} actions={actions} />
        {description ? <div className="px-4 pt-4 text-[13px] leading-relaxed text-muted sm:px-5">{description}</div> : null}
        <div className="p-4 sm:p-5">{children}</div>
      </Panel>
    </section>
  )
}

/** A small notice inside a section: amber for care, rose for a problem, neutral for a hint. */
export function Callout({
  tone = 'neutral',
  icon: Icon,
  title,
  children,
  className,
}: {
  tone?: 'neutral' | 'warn' | 'error' | 'ok'
  icon?: LucideIcon
  title?: ReactNode
  children?: ReactNode
  className?: string
}) {
  const styles = {
    neutral: 'border-line-strong bg-panel-2/60',
    warn: 'border-warn/35 bg-warn-bg',
    error: 'border-error/35 bg-error-bg',
    ok: 'border-ok/30 bg-ok-bg',
  }[tone]
  const iconColor = { neutral: 'text-faint', warn: 'text-warn', error: 'text-error', ok: 'text-ok' }[tone]
  return (
    <div className={cn('flex gap-3 rounded-lg border p-3 text-[13px] leading-relaxed', styles, className)}>
      {Icon ? <Icon className={cn('mt-0.5 size-4 shrink-0', iconColor)} aria-hidden /> : null}
      <div className="min-w-0">
        {title ? <p className="font-medium text-fg">{title}</p> : null}
        {children ? <div className={cn('text-muted', title && 'mt-0.5')}>{children}</div> : null}
      </div>
    </div>
  )
}
