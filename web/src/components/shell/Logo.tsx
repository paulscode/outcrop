import { cn } from '@/lib/utils'

/** Outcrop's mark: three strata lines rising to the surface (sandstone, shale, the answering teal). */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn('size-7', className)} aria-hidden>
      <rect width="32" height="32" rx="8" className="fill-panel-3" />
      <rect x="0.5" y="0.5" width="31" height="31" rx="7.5" fill="none" className="stroke-line-strong" />
      <path d="M7 12 25 8.6" stroke="var(--layer-1)" strokeWidth="2.6" strokeLinecap="round" />
      <path d="M7 17.2 25 13.8" stroke="var(--layer-5)" strokeWidth="2.6" strokeLinecap="round" />
      <path d="M7 22.4 25 19" stroke="var(--answer)" strokeWidth="2.6" strokeLinecap="round" />
    </svg>
  )
}

export function Wordmark({ host }: { host?: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <LogoMark />
      <div className="min-w-0 leading-tight">
        <div className="text-[15px] font-semibold tracking-tight text-fg">Outcrop</div>
        {host ? <div className="num truncate text-[11px] text-faint">{host}</div> : null}
      </div>
    </div>
  )
}
