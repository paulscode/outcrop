// Small pieces the chat page shares: space colours and chips, site monograms, the title that types itself in, and a menu
// that is a dropdown on a computer and a sheet on a phone.

import type { LucideIcon } from 'lucide-react'
import { Dialog as D } from 'radix-ui'
import { Fragment, useEffect, useState, type ReactElement, type ReactNode } from 'react'
import { monogram } from '@/lib/chat/logic'
import type { Space, SpaceColor } from '@/lib/chat/types'
import { cn, useMedia, useReducedMotion } from '@/lib/utils'
import { Dialog, DialogTitle, SheetContent } from '@/components/ui/dialog'
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from '@/components/ui/menu'
import { Kbd } from '@/components/ui/misc'

// --------------------------------------------------------------------------------------------------- space colours
export const SPACE_COLORS: Exclude<SpaceColor, ''>[] = ['slate', 'red', 'orange', 'amber', 'green', 'teal', 'sky', 'blue', 'violet', 'pink']

/** Whole class names (Tailwind finds them here): a dot, a soft chip, and a swatch. */
const DOT: Record<SpaceColor, string> = {
  '': 'bg-faint',
  slate: 'bg-slate-400',
  red: 'bg-red-500',
  orange: 'bg-orange-500',
  amber: 'bg-amber-500',
  green: 'bg-green-500',
  teal: 'bg-teal-500',
  sky: 'bg-sky-500',
  blue: 'bg-blue-500',
  violet: 'bg-violet-500',
  pink: 'bg-pink-500',
}
const CHIP: Record<SpaceColor, string> = {
  '': 'border-line-strong bg-panel-2 text-muted',
  slate: 'border-slate-500/30 bg-slate-500/10 text-slate-700 dark:text-slate-300',
  red: 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300',
  orange: 'border-orange-500/30 bg-orange-500/10 text-orange-800 dark:text-orange-300',
  amber: 'border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300',
  green: 'border-green-500/30 bg-green-500/10 text-green-800 dark:text-green-300',
  teal: 'border-teal-500/30 bg-teal-500/10 text-teal-800 dark:text-teal-300',
  sky: 'border-sky-500/30 bg-sky-500/10 text-sky-800 dark:text-sky-300',
  blue: 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300',
  violet: 'border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300',
  pink: 'border-pink-500/30 bg-pink-500/10 text-pink-700 dark:text-pink-300',
}
const TILE: Record<SpaceColor, string> = {
  '': 'bg-panel-3',
  slate: 'bg-slate-500/20',
  red: 'bg-red-500/20',
  orange: 'bg-orange-500/20',
  amber: 'bg-amber-500/20',
  green: 'bg-green-500/20',
  teal: 'bg-teal-500/20',
  sky: 'bg-sky-500/20',
  blue: 'bg-blue-500/20',
  violet: 'bg-violet-500/20',
  pink: 'bg-pink-500/20',
}

export const spaceDot = (c: SpaceColor | undefined) => DOT[c ?? ''] ?? DOT['']
export const spaceChip = (c: SpaceColor | undefined) => CHIP[c ?? ''] ?? CHIP['']
export const spaceTile = (c: SpaceColor | undefined) => TILE[c ?? ''] ?? TILE['']

/** The space's emoji, or its colour as a dot when it has none. */
export function SpaceMark({ space, className }: { space: Pick<Space, 'emoji' | 'color'>; className?: string }) {
  if (space.emoji)
    return (
      <span className={cn('inline-flex w-4 shrink-0 justify-center text-[13px] leading-none', className)} aria-hidden>
        {space.emoji}
      </span>
    )
  return (
    <span className={cn('inline-flex w-4 shrink-0 justify-center', className)} aria-hidden>
      <span className={cn('size-2 rounded-full', spaceDot(space.color))} />
    </span>
  )
}

export function SpaceChip({ space, className, children }: { space: Pick<Space, 'emoji' | 'color' | 'name'>; className?: string; children?: ReactNode }) {
  return (
    <span className={cn('inline-flex h-5 max-w-full items-center gap-1 rounded-full border px-1.5 text-[11px] font-medium', spaceChip(space.color), className)}>
      <SpaceMark space={space} className="w-auto text-[11px]" />
      <span className="truncate">{space.name}</span>
      {children}
    </span>
  )
}

export const EMOJIS = [
  '🏠', '🖥️', '🧪', '🛠️', '💼', '📚', '✍️', '💡', '🎯', '🧠',
  '🍳', '🌱', '🏃', '✈️', '🎵', '🎮', '📷', '🎨', '💰', '❤️',
  '🐧', '🐍', '🦀', '⚙️', '🔐', '🌐', '📈', '🧾', '🗺️', '🚗',
  '🐶', '👶', '🎓', '🏡', '🔧', '⚡', '🔬', '📝', '☕', '🌙',
]

// ------------------------------------------------------------------------------------------------------ monograms
const TONES = [
  'bg-teal-500/15 text-teal-800 dark:text-teal-200',
  'bg-violet-500/15 text-violet-800 dark:text-violet-200',
  'bg-amber-500/15 text-amber-800 dark:text-amber-200',
  'bg-sky-500/15 text-sky-800 dark:text-sky-200',
  'bg-pink-500/15 text-pink-800 dark:text-pink-200',
  'bg-green-500/15 text-green-800 dark:text-green-200',
]

/** A site's first letter in a coloured square: never its icon, which would tell the site you looked. */
export function Monogram({ domain, className }: { domain: string; className?: string }) {
  const m = monogram(domain)
  return (
    <span className={cn('inline-flex size-4 shrink-0 select-none items-center justify-center rounded-[4px] text-[9.5px] font-bold leading-none', TONES[m.tone], className)} aria-hidden>
      {m.letter}
    </span>
  )
}

// ---------------------------------------------------------------------------------------------- the title, typed in
/** A chat's title.  Just written by the model (`fresh`), it types itself in (fades in, with reduced motion). */
export function TitleText({ title, fresh, className }: { title: string; fresh?: boolean; className?: string }) {
  const reduced = useReducedMotion()
  const [n, setN] = useState<number | null>(null)
  useEffect(() => {
    if (!fresh || reduced) return
    const chars = [...title]
    let i = 0
    setN(0)
    const step = Math.max(18, Math.min(45, 900 / Math.max(1, chars.length)))
    const id = setInterval(() => {
      i++
      if (i >= chars.length) {
        clearInterval(id)
        setN(null)
      } else setN(i)
    }, step)
    return () => clearInterval(id)
  }, [fresh, title, reduced])
  if (n === null)
    return <span className={cn('truncate', fresh && 'animate-in fade-in-0 duration-700', className)}>{title || 'New chat'}</span>
  return (
    <span className={cn('truncate', className)}>
      <span className="sr-only">{title}</span>
      <span aria-hidden>
        {[...title].slice(0, n).join('')}
        <span className="ml-px inline-block h-[1em] w-[2px] translate-y-[0.15em] animate-pulse bg-answer" />
      </span>
    </span>
  )
}

// ------------------------------------------------------------------------------------- menus: dropdown or sheet
export interface MenuAction {
  key: string
  label: ReactNode
  icon?: LucideIcon
  onSelect: () => void
  danger?: boolean
  disabled?: boolean
  shortcut?: string
  /** a line above this one */
  sep?: boolean
  testId?: string
}

export const usePhone = () => useMedia('(max-width: 767px)')

/** A ⋯ menu: Radix's dropdown on a computer, a sheet from the bottom on a phone. */
export function ActionMenu({
  trigger,
  actions,
  title,
  open,
  onOpenChange,
  align = 'end',
  header,
}: {
  trigger: ReactElement
  actions: MenuAction[]
  title: string
  open?: boolean
  onOpenChange?: (o: boolean) => void
  align?: 'start' | 'end' | 'center'
  header?: ReactNode
}) {
  const phone = usePhone()
  const [own, setOwn] = useState(false)
  const isOpen = open ?? own
  const set = (o: boolean) => {
    setOwn(o)
    onOpenChange?.(o)
  }
  if (phone) {
    return (
      <Dialog open={isOpen} onOpenChange={set}>
        <D.Trigger asChild>{trigger}</D.Trigger>
        <SheetContent side="bottom" aria-describedby={undefined} className="px-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">
          <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-line-strong" aria-hidden />
          <DialogTitle className="truncate px-3 pb-2 pr-10 text-[13px] font-semibold text-muted">{title}</DialogTitle>
          {header}
          <ul className="grid">
            {actions.map((a) => {
              const Icon = a.icon
              return (
                <li key={a.key} className={cn(a.sep && 'mt-1 border-t border-line pt-1')}>
                  <button
                    type="button"
                    disabled={a.disabled}
                    data-testid={a.testId}
                    onClick={() => {
                      set(false)
                      // after the sheet has closed, so a dialog this opens gets the focus
                      setTimeout(a.onSelect, 0)
                    }}
                    className={cn(
                      'flex h-12 w-full items-center gap-3 rounded-lg px-3 text-left text-[15px] hover:bg-panel-2 disabled:opacity-50',
                      a.danger ? 'text-error' : 'text-fg',
                    )}
                  >
                    {Icon ? <Icon className={cn('size-5', a.danger ? 'text-error' : 'text-faint')} aria-hidden /> : null}
                    {a.label}
                  </button>
                </li>
              )
            })}
          </ul>
        </SheetContent>
      </Dialog>
    )
  }
  return (
    <Menu open={isOpen} onOpenChange={set} modal={false}>
      <MenuTrigger asChild>{trigger}</MenuTrigger>
      <MenuContent align={align} className="w-56">
        {header ? <MenuLabel className="normal-case tracking-normal">{header}</MenuLabel> : null}
        {actions.map((a) => {
          const Icon = a.icon
          return (
            <Fragment key={a.key}>
              {a.sep ? <MenuSeparator /> : null}
              <MenuItem onSelect={a.onSelect} danger={a.danger} disabled={a.disabled} data-testid={a.testId}>
                {Icon ? <Icon aria-hidden /> : null}
                <span className="flex-1">{a.label}</span>
                {a.shortcut ? <Kbd className="ml-2">{a.shortcut}</Kbd> : null}
              </MenuItem>
            </Fragment>
          )
        })}
      </MenuContent>
    </Menu>
  )
}

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
export const MOD = isMac ? '⌘' : 'Ctrl'
