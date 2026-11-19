import { cva, type VariantProps } from 'class-variance-authority'
import { Loader2 } from 'lucide-react'
import { Slot } from 'radix-ui'
import * as React from 'react'
import { cn } from '@/lib/utils'

export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-[13px] font-medium transition-[background-color,border-color,color,box-shadow,opacity] select-none disabled:opacity-50 disabled:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
  {
    variants: {
      variant: {
        primary: 'bg-primary text-primary-fg hover:opacity-90 shadow-sm',
        secondary: 'bg-panel-2 text-fg border border-line-strong hover:bg-panel-3',
        outline: 'border border-line-strong text-fg hover:bg-panel-2',
        ghost: 'text-muted hover:text-fg hover:bg-panel-2',
        danger: 'bg-error text-[#14060a] hover:opacity-90 dark:text-[#1a070c]',
        'danger-outline': 'border border-error/50 text-error hover:bg-error-bg',
        warn: 'bg-warn text-[#1a1203] hover:opacity-90',
        'warn-outline': 'border border-warn/50 text-warn hover:bg-warn-bg',
        link: 'text-fg underline underline-offset-4 decoration-line-strong hover:decoration-muted px-0 h-auto',
      },
      size: {
        xs: 'h-7 px-2 text-xs rounded-[5px]',
        sm: 'h-8 px-3',
        md: 'h-9 px-3.5',
        lg: 'h-11 px-5 text-sm',
        icon: 'size-9',
        'icon-sm': 'size-8',
        'icon-xs': 'size-7 [&_svg]:size-3.5',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
)

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean
  loading?: boolean
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild, loading, children, disabled, ...props }, ref) => {
    const Comp = asChild ? Slot.Root : 'button'
    return (
      <Comp
        ref={ref}
        className={cn(buttonVariants({ variant, size }), className)}
        disabled={asChild ? undefined : disabled || loading}
        aria-busy={loading || undefined}
        {...props}
      >
        {asChild ? (
          children
        ) : (
          <>
            {loading ? <Loader2 className="animate-spin" aria-hidden /> : null}
            {children}
          </>
        )}
      </Comp>
    )
  },
)
Button.displayName = 'Button'
