import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/* ---------------------------------------------------------------- Surface */

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'rounded-[var(--radius-lg)] border border-[var(--color-line)]',
        'bg-[var(--color-surface)] shadow-[var(--shadow-card)]',
        className,
      )}
      {...props}
    />
  );
}

export function CardBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-5 sm:p-6', className)} {...props} />;
}

/* ------------------------------------------------------------------ Badge */

const badge = cva(
  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[length:var(--text-xs)] font-medium',
  {
    variants: {
      tone: {
        neutral: 'border-[var(--color-line)] bg-[var(--color-elevated)] text-[var(--color-text-dim)]',
        brand: 'border-[var(--color-brand-700)] bg-[var(--color-brand-700)]/25 text-[var(--color-accent)]',
        ok: 'border-[var(--color-ok-500)]/40 bg-[var(--color-ok-500)]/15 text-[var(--color-ok)]',
        warn: 'border-[var(--color-warn)]/40 bg-[var(--color-warn)]/15 text-[var(--color-warn)]',
        bad: 'border-[var(--color-bad-500)]/40 bg-[var(--color-bad-500)]/15 text-[var(--color-bad)]',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badge> {}

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badge({ tone }), className)} {...props} />;
}

/**
 * A status dot. NEVER used alone — colour is not an accessible carrier of
 * meaning, so every caller pairs it with the word. It exists to make a state
 * scannable at a glance, not to encode it.
 */
export function Dot({ tone = 'neutral', className }: { tone?: 'ok' | 'warn' | 'bad' | 'neutral'; className?: string }) {
  const fill = {
    ok: 'bg-[var(--color-ok)]',
    warn: 'bg-[var(--color-warn)]',
    bad: 'bg-[var(--color-bad)]',
    neutral: 'bg-[var(--color-ink-500)]',
  }[tone];
  return <span aria-hidden className={cn('inline-block h-2 w-2 shrink-0 rounded-full', fill, className)} />;
}

/* ------------------------------------------------------------------ Input */

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        // line-strong, not line: WCAG 1.4.11 wants 3:1 on a control boundary,
        // and the decorative line is 1.24:1 — you could not see where the
        // field ended.
        'h-11 w-full rounded-[var(--radius-md)] border border-[var(--color-line-strong)]',
        'bg-[var(--color-elevated)] px-3.5 text-[length:var(--text-sm)] text-[var(--color-text)]',
        'placeholder:text-[var(--color-text-faint)]',
        'transition-colors duration-200 focus:border-[var(--color-accent)]',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';

/**
 * A labelled field. The label is ALWAYS visible — a placeholder is not a
 * label, because it disappears exactly when the user needs it (mid-typing,
 * and when they come back to check what they entered).
 */
export function Field({
  label, hint, error, htmlFor, children,
}: {
  label: string;
  hint?: string;
  error?: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-[length:var(--text-sm)] font-medium text-[var(--color-text)]">
        {label}
      </label>
      {children}
      {/* The error sits WITH the field, not in a summary at the top of the
          form. aria-live so a screen reader hears it when it appears. */}
      {error ? (
        <p role="alert" className="text-[length:var(--text-xs)] text-[var(--color-bad)]">{error}</p>
      ) : hint ? (
        <p className="text-[length:var(--text-xs)] text-[var(--color-text-faint)]">{hint}</p>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------- Section */

/** Consistent page rhythm. Section padding is a decision, made once. */
export function Section({
  className, children, ...props
}: React.HTMLAttributes<HTMLElement>) {
  return (
    <section className={cn('px-5 py-16 sm:px-8 sm:py-24', className)} {...props}>
      <div className="mx-auto w-full max-w-6xl">{children}</div>
    </section>
  );
}

/** An eyebrow + heading + optional lede, so headings never drift apart. */
export function SectionHead({
  eyebrow, title, lede, className,
}: { eyebrow?: string; title: string; lede?: string; className?: string }) {
  return (
    <div className={cn('max-w-2xl', className)}>
      {eyebrow && (
        <p className="mb-3 text-[length:var(--text-xs)] font-semibold uppercase tracking-[0.12em] text-[var(--color-accent)]">
          {eyebrow}
        </p>
      )}
      <h2 className="text-balance text-[length:var(--text-2xl)] font-semibold leading-tight tracking-[-0.02em] sm:text-[length:var(--text-3xl)]">
        {title}
      </h2>
      {lede && (
        <p className="mt-4 text-pretty text-[length:var(--text-base)] leading-relaxed text-[var(--color-text-dim)]">
          {lede}
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------- Skel */

/**
 * Loading placeholder that RESERVES the space the content will take. The
 * point is not the shimmer, it is that nothing jumps when data lands.
 */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('animate-pulse rounded-[var(--radius-sm)] bg-[var(--color-ink-800)]', className)} />;
}
