'use client';

import * as React from 'react';
import { Moon, Sun } from 'lucide-react';
import { cn } from '@/lib/utils';

/* ===========================================================================
   THEME TOGGLE

   Contract with the inline script in app/layout.tsx, and it has to match it
   exactly or the two disagree on reload:

     storage key   'anaga-theme'
     value         'light' | 'dark'
     light         document.documentElement gets data-theme="light"
     dark          the attribute is REMOVED (the :root default is dark)

   The script is the source of truth at first paint; this component only ever
   reads the attribute it set. It never re-derives the theme from
   prefers-color-scheme, because once someone has clicked this button their
   choice outranks the OS.
   =========================================================================== */

type Theme = 'light' | 'dark';

function currentTheme(): Theme {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

export function ThemeToggle({ className }: { className?: string }) {
  // null until mounted. The server cannot know which theme the browser
  // resolved, so rendering a specific icon during SSR would either flash the
  // wrong one or trip a hydration mismatch. The button keeps its 44x44 box
  // either way, so nothing moves when the icon arrives.
  const [theme, setTheme] = React.useState<Theme | null>(null);

  React.useEffect(() => {
    setTheme(currentTheme());
  }, []);

  function toggle() {
    const next: Theme = currentTheme() === 'light' ? 'dark' : 'light';
    if (next === 'light') document.documentElement.setAttribute('data-theme', 'light');
    else document.documentElement.removeAttribute('data-theme');
    // A private-mode browser can throw on write. Losing the preference is
    // survivable; throwing inside a click handler is not.
    try {
      localStorage.setItem('anaga-theme', next);
    } catch {
      /* no persistence available — the toggle still works for this page */
    }
    setTheme(next);
  }

  const label =
    theme === null
      ? 'Switch colour theme'
      : theme === 'light'
        ? 'Switch to dark theme'
        : 'Switch to light theme';

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center',
        'rounded-[var(--radius-md)] text-[var(--color-text-dim)]',
        'transition-[background-color,color] duration-200',
        'hover:bg-[var(--color-elevated)] hover:text-[var(--color-text)]',
        className,
      )}
    >
      {/* aria-hidden on both: the accessible name is on the button. */}
      {theme === 'light' ? (
        <Moon aria-hidden size={18} strokeWidth={1.75} />
      ) : theme === 'dark' ? (
        <Sun aria-hidden size={18} strokeWidth={1.75} />
      ) : (
        <span aria-hidden className="h-[18px] w-[18px]" />
      )}
    </button>
  );
}
