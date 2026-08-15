'use client';

import * as React from 'react';
import Link from 'next/link';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Menu, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ThemeToggle } from '@/components/site/theme-toggle';

/**
 * An anchor that looks like a Button. `Button` renders a real `<button>` and
 * has no `asChild`, and a link that is genuinely a link is worth more than a
 * shared component: it opens in a new tab on middle-click, it is announced as a
 * link, and it works before hydration.
 *
 * NOT exported. Every export of a `'use client'` module becomes a client
 * reference, so a Server Component importing this string would receive a proxy
 * rather than the string. app/page.tsx therefore keeps its own copy — the
 * duplication is the cheaper half of that trade.
 */
const linkButtonSecondary = [
  'inline-flex h-11 items-center justify-center gap-2 rounded-[var(--radius-md)] px-4',
  'cursor-pointer whitespace-nowrap text-[length:var(--text-sm)] font-medium',
  'border border-[var(--color-line)] bg-[var(--color-elevated)] text-[var(--color-text)]',
  'transition-[border-color,transform] duration-200 hover:border-[var(--color-ink-500)]',
  'active:scale-[0.985]',
].join(' ');

const SECTIONS = [
  { href: '#how', label: 'How it works' },
  { href: '#languages', label: 'Languages' },
  { href: '#compliance', label: 'Compliance' },
];

export function SiteNav() {
  const [open, setOpen] = React.useState(false);
  const reduced = useReducedMotion();
  const panelId = React.useId();

  // Escape closes the menu. A panel that can only be dismissed by finding the
  // button again is a trap for anyone on a keyboard.
  React.useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <header
      className={cn(
        'sticky top-0 z-40 w-full',
        'border-b border-[var(--color-line-soft)]',
        // Slightly translucent so long-form content reads as passing under the
        // bar rather than being clipped by it. 90% is opaque enough that the
        // text stays legible where backdrop-filter is unsupported.
        'bg-[var(--color-bg)]/90 backdrop-blur-md',
      )}
    >
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center gap-3 px-5 sm:px-8">
        <Link
          href="/"
          className="group -ml-1 flex shrink-0 items-baseline gap-2 rounded-[var(--radius-sm)] px-1 py-1"
        >
          <span className="text-[length:var(--text-lg)] font-semibold tracking-[-0.02em] text-[var(--color-text)]">
            Anaga
          </span>
          <span className="hidden text-[length:var(--text-xs)] text-[var(--color-text-dim)] sm:inline">
            by Modcon Builders
          </span>
        </Link>

        <nav aria-label="Sections" className="ml-4 hidden items-center gap-1 md:flex">
          {SECTIONS.map((s) => (
            <a
              key={s.href}
              href={s.href}
              className={cn(
                'inline-flex h-9 cursor-pointer items-center rounded-[var(--radius-sm)] px-3',
                'text-[length:var(--text-sm)] text-[var(--color-text-dim)]',
                'transition-colors duration-200 hover:text-[var(--color-text)]',
              )}
            >
              {s.label}
            </a>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-1 sm:gap-2">
          <ThemeToggle />
          <Link href="/login" className={cn(linkButtonSecondary, 'hidden md:inline-flex')}>
            Sign in
          </Link>

          {/* Mobile: a real disclosure button. Not a hover target — a hover
              dropdown on a touchscreen is a menu that cannot be opened. */}
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls={panelId}
            aria-label={open ? 'Close menu' : 'Open menu'}
            className={cn(
              'inline-flex h-11 w-11 cursor-pointer items-center justify-center md:hidden',
              'rounded-[var(--radius-md)] text-[var(--color-text-dim)]',
              'transition-[background-color,color] duration-200',
              'hover:bg-[var(--color-elevated)] hover:text-[var(--color-text)]',
            )}
          >
            {open ? <X aria-hidden size={20} strokeWidth={1.75} /> : <Menu aria-hidden size={20} strokeWidth={1.75} />}
          </button>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={panelId}
            key="menu"
            // Opacity and transform only. Animating height would reflow the
            // whole page on every frame.
            initial={reduced ? false : { opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, y: -6 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            className="border-t border-[var(--color-line-soft)] bg-[var(--color-bg)] md:hidden"
          >
            <nav aria-label="Sections" className="mx-auto w-full max-w-6xl px-5 py-3 sm:px-8">
              <ul className="flex flex-col">
                {SECTIONS.map((s) => (
                  <li key={s.href}>
                    <a
                      href={s.href}
                      onClick={() => setOpen(false)}
                      className={cn(
                        'flex h-12 cursor-pointer items-center rounded-[var(--radius-sm)] px-2',
                        'text-[length:var(--text-base)] text-[var(--color-text-dim)]',
                        'transition-colors duration-200 hover:text-[var(--color-text)]',
                      )}
                    >
                      {s.label}
                    </a>
                  </li>
                ))}
              </ul>
              <Link
                href="/login"
                onClick={() => setOpen(false)}
                className={cn(linkButtonSecondary, 'mt-2 mb-1 w-full')}
              >
                Sign in
              </Link>
            </nav>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  );
}
