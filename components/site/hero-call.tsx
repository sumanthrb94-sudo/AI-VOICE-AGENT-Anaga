'use client';

import * as React from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { AudioLines, PhoneOff, ShieldCheck } from 'lucide-react';
import { cn } from '@/lib/utils';

/* ===========================================================================
   The hero visual, and the one motion primitive the marketing page uses.

   Both live here because they are the page's entire client-side motion budget
   and keeping them together makes that budget visible. `app/page.tsx` stays a
   server component and passes already-rendered children into `Reveal`.

   Rules both of these obey:
   - opacity and transform ONLY. Never width, height, top or left — those force
     layout on every frame and are the reason "animated" pages jank on a mid
     range Android.
   - nothing is added to or removed from the layout as it animates, so the
     reveal cannot shift anything below it (CLS stays zero).
   - prefers-reduced-motion collapses the duration to zero rather than changing
     what is rendered, so the server and the client emit identical markup and
     the page reads exactly the same either way.
   =========================================================================== */

const EASE = [0.22, 1, 0.36, 1] as const;

export function Reveal({
  children,
  delay = 0,
  className,
  /** `li` when the reveal is a direct child of a list — an <ol> whose children
   *  are <div>s is not a list to a screen reader, whatever it looks like. */
  as = 'div',
}: {
  children: React.ReactNode;
  delay?: number;
  className?: string;
  as?: 'div' | 'li';
}) {
  const reduced = useReducedMotion();
  const Tag = as === 'li' ? motion.li : motion.div;
  return (
    <Tag
      // The <noscript> rule in app/page.tsx keys off this attribute, so the
      // content is visible even if the bundle never arrives.
      data-reveal
      className={className}
      initial={{ opacity: 0, y: 10 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.1 }}
      transition={reduced ? { duration: 0 } : { duration: 0.28, delay, ease: EASE }}
    >
      {children}
    </Tag>
  );
}

/* ------------------------------------------------------------------ turns */

/**
 * Anaga's lines are quoted from the repo, not written for this page:
 * `caller-agent/flows/anaga.persona.json` (the disclosure) and the `style`
 * examples in `caller-agent/flows/real-estate-qualify.flow.json`. The prospect's
 * reply is a placeholder — a real call is not a script, and pretending to
 * transcribe one would be the same class of mistake as quoting a latency number
 * nobody measured.
 */
const TURNS: {
  who: 'anaga' | 'prospect';
  lang: 'te';
  text: string;
  gloss: string;
  tag?: string;
}[] = [
  {
    who: 'anaga',
    lang: 'te',
    text: 'హలో, నేను అనగా, మోడ్‌కాన్ బిల్డర్స్ నుంచి AI వాయిస్ అసిస్టెంట్‌ని. రెండు నిమిషాలు టైమ్ ఉందా?',
    gloss: 'Hi, I’m Anaga, an AI voice assistant from Modcon Builders. Do you have two minutes?',
    tag: 'Discloses she is an AI — first sentence, non-skippable',
  },
  {
    who: 'prospect',
    lang: 'te',
    text: 'చెప్పండి.',
    gloss: 'Go ahead.',
  },
  {
    who: 'anaga',
    lang: 'te',
    text: 'ఉండటానికి చూస్తున్నారా, లేక ఇన్వెస్ట్‌మెంట్ కోసమా?',
    gloss: 'Are you looking to live in it, or to invest?',
    tag: 'Qualifying: purpose',
  },
];

export function HeroCall({ className }: { className?: string }) {
  const reduced = useReducedMotion();

  return (
    <figure
      className={cn(
        'not-prose m-0 overflow-hidden rounded-[var(--radius-xl)]',
        'border border-[var(--color-line)] bg-[var(--color-surface)] shadow-[var(--shadow-card)]',
        className,
      )}
    >
      {/* --- call header ------------------------------------------------- */}
      <div className="flex items-center gap-2.5 border-b border-[var(--color-line-soft)] bg-[var(--color-elevated)] px-4 py-3">
        <span aria-hidden className="inline-block h-2 w-2 shrink-0 rounded-full bg-[var(--color-ok)]" />
        <span className="text-[length:var(--text-xs)] font-medium text-[var(--color-text)]">
          Outbound · connected
        </span>
        <span className="text-[length:var(--text-xs)] text-[var(--color-text-faint)]">
          Instagram lead
        </span>
        {/* Numbers are masked here for the same reason they are masked in the
            logs and in every API response. */}
        <span className="tabular ml-auto text-[length:var(--text-xs)] text-[var(--color-text-faint)]">
          +91 98•••••10
        </span>
      </div>

      {/* --- turns -------------------------------------------------------- */}
      <ol className="flex flex-col gap-4 px-4 py-5 sm:px-5">
        {TURNS.map((t, i) => (
          <motion.li
            key={t.text}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={reduced ? { duration: 0 } : { duration: 0.24, delay: 0.12 + i * 0.14, ease: EASE }}
            className={cn('flex flex-col gap-1.5', t.who === 'prospect' && 'items-end text-right')}
          >
            <span className="text-[length:var(--text-xs)] font-medium uppercase tracking-[0.1em] text-[var(--color-text-faint)]">
              {t.who === 'anaga' ? 'Anaga' : 'Prospect'}
            </span>

            <p
              lang={t.lang}
              className={cn(
                'max-w-[34ch] rounded-[var(--radius-lg)] px-3.5 py-2.5 text-[length:var(--text-sm)] leading-relaxed',
                t.who === 'anaga'
                  ? 'rounded-tl-[var(--radius-sm)] bg-[var(--color-accent)]/12 text-[var(--color-text)]'
                  : 'rounded-tr-[var(--radius-sm)] bg-[var(--color-elevated)] text-[var(--color-text)]',
              )}
            >
              {t.text}
            </p>

            <p className="max-w-[40ch] text-[length:var(--text-xs)] leading-relaxed text-[var(--color-text-dim)]">
              {t.gloss}
            </p>

            {t.tag && (
              <p className="inline-flex items-center gap-1.5 text-[length:var(--text-xs)] text-[var(--color-text-faint)]">
                <ShieldCheck aria-hidden size={13} strokeWidth={1.75} />
                {t.tag}
              </p>
            )}
          </motion.li>
        ))}
      </ol>

      {/* --- what is running underneath ----------------------------------- */}
      <figcaption className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-[var(--color-line-soft)] bg-[var(--color-elevated)] px-4 py-3">
        <span className="inline-flex items-center gap-1.5 text-[length:var(--text-xs)] text-[var(--color-text-dim)]">
          <AudioLines aria-hidden size={13} strokeWidth={1.75} />
          Barge-in armed
        </span>
        <span className="inline-flex items-center gap-1.5 text-[length:var(--text-xs)] text-[var(--color-text-dim)]">
          <PhoneOff aria-hidden size={13} strokeWidth={1.75} />
          Opt-out checked on every utterance
        </span>
        <span className="ml-auto text-[length:var(--text-xs)] text-[var(--color-text-faint)]">
          Illustration
        </span>
      </figcaption>
    </figure>
  );
}
