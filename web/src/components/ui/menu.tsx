import { Check } from 'lucide-react'
import { DropdownMenu as M, Popover as P, Tooltip as T } from 'radix-ui'
import * as React from 'react'
import { cn } from '@/lib/utils'

// ------------------------------------------------------------------------------------------------- dropdown menu
export const Menu = M.Root
export const MenuTrigger = M.Trigger
export const MenuGroup = M.Group

const pop =
  'z-50 overflow-hidden rounded-lg border border-line-strong bg-panel p-1 text-fg shadow-xl data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.97] data-[state=closed]:animate-out data-[state=closed]:fade-out-0'

export function MenuContent({ className, sideOffset = 6, align = 'end', ...props }: React.ComponentProps<typeof M.Content>) {
  return (
    <M.Portal>
      <M.Content sideOffset={sideOffset} align={align} className={cn(pop, 'min-w-48', className)} {...props} />
    </M.Portal>
  )
}

export function MenuItem({
  className,
  danger,
  ...props
}: React.ComponentProps<typeof M.Item> & { danger?: boolean }) {
  return (
    <M.Item
      className={cn(
        'relative flex cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 text-[13px] outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-panel-2 [&_svg]:size-4 [&_svg]:text-faint',
        danger && 'text-error data-[highlighted]:bg-error-bg [&_svg]:text-error',
        className,
      )}
      {...props}
    />
  )
}

export function MenuCheckItem({ className, children, ...props }: React.ComponentProps<typeof M.CheckboxItem>) {
  return (
    <M.CheckboxItem
      className={cn(
        'relative flex cursor-pointer select-none items-center gap-2 rounded-md py-1.5 pl-7 pr-2 text-[13px] outline-none data-[highlighted]:bg-panel-2',
        className,
      )}
      {...props}
    >
      <span className="absolute left-2 flex size-3.5 items-center justify-center">
        <M.ItemIndicator>
          <Check className="size-3.5" />
        </M.ItemIndicator>
      </span>
      {children}
    </M.CheckboxItem>
  )
}

export const MenuRadioGroup = M.RadioGroup
export function MenuRadioItem({ className, children, ...props }: React.ComponentProps<typeof M.RadioItem>) {
  return (
    <M.RadioItem
      className={cn(
        'relative flex cursor-pointer select-none items-center gap-2 rounded-md py-1.5 pl-7 pr-2 text-[13px] outline-none data-[highlighted]:bg-panel-2',
        className,
      )}
      {...props}
    >
      <span className="absolute left-2 flex size-3.5 items-center justify-center">
        <M.ItemIndicator>
          <Check className="size-3.5" />
        </M.ItemIndicator>
      </span>
      {children}
    </M.RadioItem>
  )
}

export function MenuLabel({ className, ...props }: React.ComponentProps<typeof M.Label>) {
  return <M.Label className={cn('px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-faint', className)} {...props} />
}

export function MenuSeparator({ className, ...props }: React.ComponentProps<typeof M.Separator>) {
  return <M.Separator className={cn('-mx-1 my-1 h-px bg-line', className)} {...props} />
}

// ------------------------------------------------------------------------------------------------------- popover
export const Popover = P.Root
export const PopoverTrigger = P.Trigger
export const PopoverAnchor = P.Anchor
export const PopoverClose = P.Close

export function PopoverContent({ className, sideOffset = 8, align = 'center', ...props }: React.ComponentProps<typeof P.Content>) {
  return (
    <P.Portal>
      <P.Content sideOffset={sideOffset} align={align} className={cn(pop, 'w-80 p-4', className)} {...props} />
    </P.Portal>
  )
}

// ------------------------------------------------------------------------------------------------------- tooltip
export const TooltipProvider = T.Provider

/** A tooltip on any element; `side` defaults to top.  Plain words in the UI, engine terms in here. */
export function Tip({
  content,
  children,
  side = 'top',
  className,
  asChild = true,
}: {
  content: React.ReactNode
  children: React.ReactNode
  side?: 'top' | 'bottom' | 'left' | 'right'
  className?: string
  asChild?: boolean
}) {
  if (!content) return <>{children}</>
  return (
    <T.Root>
      <T.Trigger asChild={asChild}>{children}</T.Trigger>
      <T.Portal>
        <T.Content
          side={side}
          sideOffset={6}
          collisionPadding={8}
          className={cn(
            'z-[60] max-w-72 rounded-md border border-line-strong bg-panel-3 px-2.5 py-1.5 text-xs leading-relaxed text-fg shadow-lg data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
            className,
          )}
        >
          {content}
        </T.Content>
      </T.Portal>
    </T.Root>
  )
}
