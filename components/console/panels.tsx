'use client';

/* ===========================================================================
   Console furniture.

   The marketing primitives in components/ui are built for a page you scroll
   once. A console is looked at for hours, so these are tighter: 20px card
   padding instead of 24, a 12px label floor rather than 14, and section heads
   that sit inside the card instead of above it.

   Everything here is token-only. No hex, no Tailwind palette colour.
   =========================================================================== */

import * as React from 'react';
import { TriangleAlert, Info, CircleCheck } from 'lucide-react';
import { cn } from '@/lib/utils';

/* ---------------------------------------------------------------- Panel */

export function Panel({ className, ...props }: React.HTMLAttributes<HTMLElement>) {
  return (
    <section
      className={cn(
        'flex flex-col rounded-[var(--radius-lg)] border border-[var(--color-line)]',
        'bg-[var(--color-surface)] shadow-[var(--shadow-card)]',
        className,
      )}
      {...props}
    />
  );
}

/**
 * A panel heading. `id` is required so the panel can be `aria-labelledby` it —
 * a dashboard of unlabelled regions is a dashboard a screen reader cannot
 * navigate.
 */
export function PanelHead({
  id, icon: Icon, title, count, hint, action,
}: {
  id: string;
  icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  title: string;
  count?: string | null;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--color-line-soft)] px-5 py-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <Icon aria-hidden className="h-4 w-4 shrink-0 text-[var(--color-text-dim)]" />
          <h2 id={id} className="text-[length:var(--text-sm)] font-semibold tracking-[-0.01em]">
            {title}
          </h2>
          {count ? (
            <span className="tabular text-[length:var(--text-xs)] text-[var(--color-text-dim)]">{count}</span>
          ) : null}
        </div>
        {hint ? (
          <p className="mt-1 text-pretty text-[length:var(--text-xs)] leading-relaxed text-[var(--color-text-dim)]">
            {hint}
          </p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function PanelBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-5', className)} {...props} />;
}

/* ----------------------------------------------------------------- Note */

/**
 * A banner that states a fact about the system. `tone` carries emphasis, the
 * icon and the words carry the meaning — colour alone never does.
 */
export function Note({
  tone = 'neutral', title, children, className,
}: {
  tone?: 'neutral' | 'ok' | 'warn' | 'bad';
  title: string;
  children?: React.ReactNode;
  className?: string;
}) {
  const skin = {
    neutral: 'border-[var(--color-line)] bg-[var(--color-elevated)] text-[var(--color-text-dim)]',
    ok: 'border-[var(--color-ok-500)]/40 bg-[var(--color-ok-500)]/10 text-[var(--color-text-dim)]',
    warn: 'border-[var(--color-warn)]/40 bg-[var(--color-warn)]/10 text-[var(--color-text-dim)]',
    bad: 'border-[var(--color-bad-500)]/45 bg-[var(--color-bad-500)]/10 text-[var(--color-text-dim)]',
  }[tone];

  const accent = {
    neutral: 'text-[var(--color-text-dim)]',
    ok: 'text-[var(--color-ok)]',
    warn: 'text-[var(--color-warn)]',
    bad: 'text-[var(--color-bad)]',
  }[tone];

  const Icon = tone === 'ok' ? CircleCheck : tone === 'neutral' ? Info : TriangleAlert;

  return (
    <div className={cn('flex gap-3 rounded-[var(--radius-md)] border p-4', skin, className)}>
      <Icon aria-hidden className={cn('mt-0.5 h-4 w-4 shrink-0', accent)} />
      <div className="min-w-0 space-y-1">
        <p className="text-[length:var(--text-sm)] font-semibold text-[var(--color-text)]">{title}</p>
        {children ? (
          <div className="text-pretty text-[length:var(--text-xs)] leading-relaxed">{children}</div>
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ Empty state */

/**
 * Empty means empty. Every empty state names the ONE action that would fill
 * it, because "no data" without a cause reads as a broken page.
 */
export function EmptyState({
  icon: Icon, title, children,
}: {
  icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-5 py-10 text-center">
      <Icon aria-hidden className="h-5 w-5 text-[var(--color-text-dim)]" />
      <p className="text-[length:var(--text-sm)] font-medium text-[var(--color-text)]">{title}</p>
      {children ? (
        <p className="max-w-sm text-pretty text-[length:var(--text-xs)] leading-relaxed text-[var(--color-text-dim)]">
          {children}
        </p>
      ) : null}
    </div>
  );
}

/* ----------------------------------------------------------------- Code */

/** An env var or an endpoint path. Selectable, because it gets copied. */
export function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded-[var(--radius-sm)] bg-[var(--color-elevated)] px-1.5 py-0.5 font-mono text-[length:var(--text-xs)] text-[var(--color-accent)]">
      {children}
    </code>
  );
}

/* ----------------------------------------------------------------- Stat */

/**
 * One number and what it means. `value` is a string so a missing value can be
 * an em dash rather than a zero — a rate with no denominator is not 0%.
 */
export function Stat({
  label, value, foot, muted,
}: {
  label: string;
  value: string;
  foot?: string;
  muted?: boolean;
}) {
  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--color-line-soft)] bg-[var(--color-elevated)] p-4">
      <p className="text-[length:var(--text-xs)] font-medium uppercase tracking-[0.08em] text-[var(--color-text-dim)]">
        {label}
      </p>
      <p
        className={cn(
          'tabular mt-1.5 text-[length:var(--text-xl)] font-semibold leading-none',
          muted ? 'text-[var(--color-text-dim)]' : 'text-[var(--color-text)]',
        )}
      >
        {value}
      </p>
      {foot ? (
        <p className="mt-1.5 text-pretty text-[length:var(--text-xs)] leading-snug text-[var(--color-text-dim)]">
          {foot}
        </p>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------- Row list */

/** A status row: state, name, detail. Wraps rather than truncating on narrow. */
export function StatusRow({
  state, name, detail,
}: {
  state: React.ReactNode;
  name: string;
  detail?: React.ReactNode;
}) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--color-line-soft)] py-2.5 last:border-b-0">
      <span className="shrink-0">{state}</span>
      <span className="text-[length:var(--text-sm)] text-[var(--color-text)]">{name}</span>
      {detail ? (
        <span className="ml-auto text-[length:var(--text-xs)] text-[var(--color-text-dim)]">{detail}</span>
      ) : null}
    </li>
  );
}

/* --------------------------------------------------------- Scroll region */

/**
 * A table lives in here or it does not live at all. The PAGE never scrolls
 * sideways on a phone; the table does, inside its own box, and it is
 * focusable so a keyboard can reach that scroll.
 */
export function TableScroll({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      className="w-full overflow-x-auto focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
    >
      {children}
    </div>
  );
}

/* ------------------------------------------------------------- Skeletons */

/** Reserves the exact space a panel's content will occupy. */
export function LoadingRows({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('space-y-2.5', className)} aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className="h-10 animate-pulse rounded-[var(--radius-sm)] bg-[var(--color-elevated)]"
        />
      ))}
    </div>
  );
}
