import { X } from 'lucide-react'
import { Dialog as D } from 'radix-ui'
import * as React from 'react'
import { cn } from '@/lib/utils'

export const Dialog = D.Root
export const DialogTrigger = D.Trigger
export const DialogClose = D.Close

const overlay =
  'fixed inset-0 z-50 bg-black/55 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0'

export function DialogContent({
  className,
  children,
  wide,
  hideClose,
  ...props
}: React.ComponentProps<typeof D.Content> & { wide?: boolean; hideClose?: boolean }) {
  return (
    <D.Portal>
      <D.Overlay className={overlay} />
      <D.Content
        className={cn(
          'fixed left-1/2 top-1/2 z-50 grid max-h-[calc(100dvh-2rem)] w-[calc(100vw-1.5rem)] -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto rounded-xl border border-line-strong bg-panel p-5 shadow-2xl outline-none scrollbar-thin sm:p-6',
          wide ? 'max-w-3xl' : 'max-w-lg',
          'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.98] data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-[0.98]',
          className,
        )}
        {...props}
      >
        {children}
        {hideClose ? null : (
          <D.Close
            className="absolute right-3 top-3 rounded-md p-1.5 text-faint transition-colors hover:bg-panel-2 hover:text-fg"
            aria-label="Close"
          >
            <X className="size-4" />
          </D.Close>
        )}
      </D.Content>
    </D.Portal>
  )
}

export function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('grid gap-1 pr-6', className)} {...props} />
}

export function DialogTitle({ className, ...props }: React.ComponentProps<typeof D.Title>) {
  return <D.Title className={cn('text-base font-semibold tracking-tight text-fg', className)} {...props} />
}

export function DialogDescription({ className, ...props }: React.ComponentProps<typeof D.Description>) {
  return <D.Description className={cn('text-[13px] leading-relaxed text-muted', className)} {...props} />
}

export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end', className)} {...props} />
}

/** A panel that slides in from the right (or the bottom on phones). */
export function SheetContent({
  className,
  children,
  side = 'right',
  ...props
}: React.ComponentProps<typeof D.Content> & { side?: 'right' | 'left' | 'bottom' }) {
  const sides = {
    right:
      'inset-y-0 right-0 h-full w-full max-w-[min(640px,100vw)] border-l data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right',
    left: 'inset-y-0 left-0 h-full w-[280px] border-r data-[state=open]:slide-in-from-left data-[state=closed]:slide-out-to-left',
    bottom:
      'inset-x-0 bottom-0 max-h-[85dvh] rounded-t-2xl border-t data-[state=open]:slide-in-from-bottom data-[state=closed]:slide-out-to-bottom',
  }
  return (
    <D.Portal>
      <D.Overlay className={overlay} />
      <D.Content
        className={cn(
          'fixed z-50 flex flex-col overflow-y-auto border-line-strong bg-panel shadow-2xl outline-none scrollbar-thin data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:duration-300 data-[state=closed]:duration-200',
          sides[side],
          className,
        )}
        {...props}
      >
        {children}
        <D.Close
          className="absolute right-3 top-3 rounded-md p-1.5 text-faint transition-colors hover:bg-panel-2 hover:text-fg"
          aria-label="Close"
        >
          <X className="size-4" />
        </D.Close>
      </D.Content>
    </D.Portal>
  )
}
