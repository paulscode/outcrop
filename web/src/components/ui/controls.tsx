import { Check, Minus } from 'lucide-react'
import { Checkbox as C, RadioGroup as R, Switch as S, Tabs as T, ToggleGroup as G } from 'radix-ui'
import * as React from 'react'
import { cn } from '@/lib/utils'

// ------------------------------------------------------------------------------------------------------- switch
export function Switch({ className, ...props }: React.ComponentProps<typeof S.Root>) {
  return (
    <S.Root
      className={cn(
        'peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-line-strong bg-panel-3 p-0.5 transition-colors data-[state=checked]:border-transparent data-[state=checked]:bg-fg disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <S.Thumb className="pointer-events-none block size-3.5 rounded-full bg-fg shadow-sm transition-transform data-[state=checked]:translate-x-4 data-[state=checked]:bg-bg" />
    </S.Root>
  )
}

// ----------------------------------------------------------------------------------------------------- checkbox
export function Checkbox({ className, ...props }: React.ComponentProps<typeof C.Root>) {
  return (
    <C.Root
      className={cn(
        'peer inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-line-strong bg-sunken transition-colors data-[state=checked]:border-fg data-[state=checked]:bg-fg data-[state=checked]:text-bg data-[state=indeterminate]:bg-fg data-[state=indeterminate]:text-bg disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <C.Indicator>
        {props.checked === 'indeterminate' ? <Minus className="size-3" strokeWidth={3} /> : <Check className="size-3" strokeWidth={3} />}
      </C.Indicator>
    </C.Root>
  )
}

// -------------------------------------------------------------------------------------------------------- radio
export function RadioGroup({ className, ...props }: React.ComponentProps<typeof R.Root>) {
  return <R.Root className={cn('grid gap-2', className)} {...props} />
}

export function RadioItem({ className, ...props }: React.ComponentProps<typeof R.Item>) {
  return (
    <R.Item
      className={cn(
        'peer inline-flex size-4 shrink-0 items-center justify-center rounded-full border border-line-strong bg-sunken data-[state=checked]:border-fg',
        className,
      )}
      {...props}
    >
      <R.Indicator className="block size-2 rounded-full bg-fg" />
    </R.Item>
  )
}

// --------------------------------------------------------------------------------------------------------- tabs
export const Tabs = T.Root

export function TabsList({ className, ...props }: React.ComponentProps<typeof T.List>) {
  return (
    <T.List
      className={cn('inline-flex items-center gap-1 border-b border-line text-[13px] overflow-x-auto scrollbar-thin max-w-full', className)}
      {...props}
    />
  )
}

export function TabsTrigger({ className, ...props }: React.ComponentProps<typeof T.Trigger>) {
  return (
    <T.Trigger
      className={cn(
        '-mb-px inline-flex shrink-0 items-center gap-1.5 border-b-2 border-transparent px-3 py-2 font-medium text-faint transition-colors hover:text-fg data-[state=active]:border-fg data-[state=active]:text-fg [&_svg]:size-3.5',
        className,
      )}
      {...props}
    />
  )
}

export function TabsContent({ className, ...props }: React.ComponentProps<typeof T.Content>) {
  return <T.Content className={cn('outline-none', className)} {...props} />
}

// ------------------------------------------------------------------------------------------- segmented control
export function Segmented<V extends string>({
  value,
  onValueChange,
  options,
  className,
  size = 'md',
  label,
}: {
  value: V
  onValueChange: (v: V) => void
  options: Array<{ value: V; label: React.ReactNode; disabled?: boolean; title?: string }>
  className?: string
  size?: 'sm' | 'md'
  label: string
}) {
  return (
    <G.Root
      type="single"
      value={value}
      onValueChange={(v) => v && onValueChange(v as V)}
      aria-label={label}
      className={cn('inline-flex w-fit max-w-full rounded-lg border border-line bg-sunken/70 p-0.5', className)}
    >
      {options.map((o) => (
        <G.Item
          key={o.value}
          value={o.value}
          disabled={o.disabled}
          title={o.title}
          className={cn(
            'inline-flex items-center justify-center gap-1.5 rounded-md font-medium text-faint transition-colors hover:text-fg data-[state=on]:bg-panel-3 data-[state=on]:text-fg data-[state=on]:shadow-sm disabled:opacity-40 [&_svg]:size-3.5',
            size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-[13px]',
          )}
        >
          {o.label}
        </G.Item>
      ))}
    </G.Root>
  )
}
