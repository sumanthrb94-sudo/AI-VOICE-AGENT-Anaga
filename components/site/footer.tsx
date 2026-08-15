import Link from 'next/link';
import { cn } from '@/lib/utils';

/* A server component on purpose. Nothing here has state, so nothing here needs
   to ship JavaScript. */

const columns: { heading: string; links: { href: string; label: string }[] }[] = [
  {
    heading: 'Product',
    links: [
      { href: '/call', label: 'Hear a live call' },
      { href: '/login', label: 'Sign in' },
    ],
  },
  {
    heading: 'How it works',
    links: [
      { href: '#how', label: 'The pipeline' },
      { href: '#languages', label: 'Languages' },
      { href: '#sounds', label: 'Turn-taking' },
    ],
  },
  {
    heading: 'Compliance',
    links: [
      { href: '#compliance', label: 'The gate' },
      { href: '#compliance-optout', label: 'Opt-out' },
      { href: '#scope', label: 'What she does not do' },
    ],
  },
];

// min-h-11 is 44px. A footer link is not a primary action, but it is still
// something someone taps with a thumb at the bottom of a long page.
const linkClass = cn(
  'inline-flex min-h-11 cursor-pointer items-center rounded-[var(--radius-sm)]',
  'text-[length:var(--text-sm)] text-[var(--color-text-dim)]',
  'transition-colors duration-200 hover:text-[var(--color-text)]',
);

export function SiteFooter() {
  return (
    <footer className="border-t border-[var(--color-line-soft)] bg-[var(--color-surface)]">
      <div className="mx-auto w-full max-w-6xl px-5 py-12 sm:px-8 sm:py-16">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
          <div className="lg:pr-6">
            <p className="text-[length:var(--text-lg)] font-semibold tracking-[-0.02em]">Anaga</p>
            <p className="mt-3 max-w-xs text-pretty text-[length:var(--text-sm)] leading-relaxed text-[var(--color-text-dim)]">
              An outbound voice agent built by Modcon Builders in Hyderabad, for the leads Modcon
              Builders actually has to ring.
            </p>
          </div>

          {columns.map((col) => (
            <div key={col.heading}>
              <h2 className="text-[length:var(--text-xs)] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-faint)]">
                {col.heading}
              </h2>
              <ul className="mt-3 flex flex-col gap-0.5">
                {col.links.map((l) => (
                  <li key={l.href}>
                    {l.href.startsWith('#') ? (
                      <a href={l.href} className={linkClass}>
                        {l.label}
                      </a>
                    ) : (
                      <Link href={l.href} className={linkClass}>
                        {l.label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-12 flex flex-col gap-3 border-t border-[var(--color-line-soft)] pt-6 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[length:var(--text-xs)] text-[var(--color-text-faint)]">
            &copy; {new Date().getFullYear()} Modcon Builders, Hyderabad.
          </p>
          {/* Worth repeating at the bottom of the page as well as in her first
              sentence: this is the thing the product is legally built around. */}
          <p className="text-[length:var(--text-xs)] text-[var(--color-text-faint)]">
            Anaga says she is an AI in the first sentence of every call, in every language.
          </p>
        </div>
      </div>
    </footer>
  );
}
