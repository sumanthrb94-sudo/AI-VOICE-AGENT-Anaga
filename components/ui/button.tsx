'use client';

import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

// shadcn/ui's pattern — the source lives here and is ours to shape — but the
// variants are Anaga's, not the template's, and every one maps to a semantic
// token rather than a Tailwind palette colour.
const button = cva(
  [
    'inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium',
    'cursor-pointer select-none rounded-[var(--radius-md)]',
    // 150-300ms, and only on properties that do not force layout.
    'transition-[background-color,border-color,color,opacity,transform] duration-200',
    'disabled:pointer-events-none disabled:opacity-45',
    '[&_svg]:pointer-events-none [&_svg]:shrink-0',
    // Pressed feedback. An instant state change reads as an unresponsive
    // button; this is small enough not to be a party trick.
    'active:scale-[0.985]',
  ],
  {
    variants: {
      variant: {
        primary:
          'bg-[var(--color-accent-fill)] text-[var(--color-on-accent)] hover:bg-[var(--color-brand-400)]',
        // A secondary button is only a button because of its edge, so that
        // edge is held to the 3:1 control-boundary bar rather than the
        // decorative one.
        secondary:
          'bg-[var(--color-elevated)] text-[var(--color-text)] border border-[var(--color-line-strong)] hover:border-[var(--color-ink-300)]',
        ghost:
          'text-[var(--color-text-dim)] hover:text-[var(--color-text)] hover:bg-[var(--color-elevated)]',
        danger:
          'bg-[var(--color-bad-500)] text-white hover:bg-[var(--color-bad-400)]',
        link: 'text-[var(--color-accent)] underline-offset-4 hover:underline p-0 h-auto',
      },
      size: {
        // 44px is the documented touch floor and these are the real heights,
        // not padding that happens to land near it. `sm` is 36px and is only
        // for pointer-dense surfaces (table rows in the console), never for a
        // primary action on a phone.
        sm: 'h-9 px-3 text-[length:var(--text-sm)]',
        md: 'h-11 px-4 text-[length:var(--text-sm)]',
        lg: 'h-13 px-6 text-[length:var(--text-base)]',
        icon: 'h-11 w-11',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof button> {
  /** Renders a spinner and blocks interaction. Feedback is not optional. */
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, loading, children, disabled, ...props }, ref) => (
    <button
      ref={ref}
      className={cn(button({ variant, size }), className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading && (
        <span
          aria-hidden
          className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
      )}
      {children}
    </button>
  ),
);
Button.displayName = 'Button';
