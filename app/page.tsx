import Link from 'next/link';
import {
  ArrowRight,
  Clock,
  Database,
  Languages as LanguagesIcon,
  Lock,
  Phone,
  PhoneOff,
  ScrollText,
  UserCheck,
  type LucideIcon,
} from 'lucide-react';
import { Badge, Card, CardBody, Section, SectionHead } from '@/components/ui/primitives';
import { SiteNav } from '@/components/site/nav';
import { SiteFooter } from '@/components/site/footer';
import { HeroCall, Reveal } from '@/components/site/hero-call';
import { BORROWED, GATE, LANGUAGES, MOAT, PIPELINE, SOUND, WEIGHTS } from '@/components/site/marketing-copy';
import { cn } from '@/lib/utils';

/* ===========================================================================
   THE MARKETING PAGE

   Layout only. Every sentence of copy, and the provenance of every claim in
   it, lives in components/site/marketing-copy.ts — including the note about
   the one number that is deliberately absent from this page.

   ONE TOKEN IS NOT USED ANYWHERE ON THESE PAGES: --color-text-faint.
   globals.css documents it as "4.6:1 on bg — labels only". Measured, ink-400 on
   ink-950 is 3.31:1, and on --color-surface and --color-elevated it is 3.19:1
   and 3.04:1 — below the 4.5:1 floor everywhere in the dark theme, which is the
   default theme. (Light mode is fine: 5.5–6.0:1.) So every label here uses
   --color-text-dim and earns its hierarchy from size, weight and tracking
   instead. This wants fixing in globals.css — ink-300 measures 5.35:1 at its
   worst — but that file belongs to somebody else this session.
   =========================================================================== */

/* The two calls to action. They navigate, so they are anchors rather than
   `Button`, which renders a real <button>. Written out here rather than shared
   with nav.tsx because every export of a `'use client'` module reaches a Server
   Component as a client reference, not as the string it looks like. */
const CTA_BASE =
  'inline-flex h-13 items-center justify-center gap-2 rounded-[var(--radius-md)] px-6 ' +
  'cursor-pointer whitespace-nowrap text-[length:var(--text-base)] font-medium ' +
  'transition-[background-color,border-color,transform] duration-200 active:scale-[0.985]';

const CTA_PRIMARY = cn(
  CTA_BASE,
  'bg-[var(--color-accent-fill)] text-[var(--color-on-accent)] hover:bg-[var(--color-brand-400)]',
);
const CTA_SECONDARY = cn(
  CTA_BASE,
  'border border-[var(--color-line)] bg-[var(--color-elevated)] text-[var(--color-text)] hover:border-[var(--color-ink-500)]',
);

const FACTS = [
  { icon: LanguagesIcon, text: 'Telugu, Hindi and English — code-mixed inside one sentence, not three separate scripts.' },
  { icon: UserCheck, text: 'The AI disclosure is her first sentence, in every language, and it cannot be skipped.' },
  { icon: PhoneOff, text: 'An opt-out writes to the suppression list before anything else is touched.' },
];

const GUARANTEES = [
  { icon: Clock, text: '09:00–21:00 IST calling window' },
  { icon: Database, text: '90-day recording retention on Indian infrastructure' },
  { icon: Lock, text: 'Phone numbers masked in logs and in every response' },
  { icon: ScrollText, text: 'Per-call audit record: scrub result, consent basis, disclosure, outcome' },
];

const NOSCRIPT_REVEAL =
  '<style>[data-reveal]{opacity:1 !important;transform:none !important}</style>';

/* ------------------------------------------------------------- components */

function CtaPair({ className }: { className?: string }) {
  return (
    <div className={cn('flex flex-wrap items-center gap-3', className)}>
      <Link href="/call" className={CTA_PRIMARY}>
        <Phone aria-hidden size={17} strokeWidth={2} />
        Hear a live call
      </Link>
      <Link href="/login" className={CTA_SECONDARY}>
        Sign in
        <ArrowRight aria-hidden size={16} strokeWidth={2} />
      </Link>
    </div>
  );
}

function FeatureCard({
  icon: Icon, title, body, id,
}: { icon: LucideIcon; title: string; body: string; id?: string }) {
  return (
    <Card className="h-full" id={id}>
      <CardBody className="flex h-full flex-col">
        <Icon aria-hidden size={20} strokeWidth={1.75} className="text-[var(--color-accent)]" />
        <h3 className="mt-4 text-balance text-[length:var(--text-lg)] font-semibold leading-snug tracking-[-0.01em]">
          {title}
        </h3>
        <p className="mt-2 text-pretty text-[length:var(--text-sm)] leading-relaxed text-[var(--color-text-dim)]">
          {body}
        </p>
      </CardBody>
    </Card>
  );
}

/* -------------------------------------------------------------- the page */

export default function HomePage() {
  return (
    <>
      {/* If the bundle never arrives, nothing revealed on scroll stays hidden. */}
      <noscript dangerouslySetInnerHTML={{ __html: NOSCRIPT_REVEAL }} />

      <SiteNav />

      <main id="main">
        {/* ==================================================== HERO ===== */}
        <Section className="pt-12 pb-16 sm:pt-20 sm:pb-24">
          <div className="grid items-center gap-12 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] lg:gap-16">
            <Reveal>
              <p className="mb-4 inline-flex items-center gap-2 text-[length:var(--text-xs)] font-semibold uppercase tracking-[0.12em] text-[var(--color-accent)]">
                <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--color-accent)]" />
                Modcon Builders · Hyderabad
              </p>

              <h1 className="text-balance text-[length:var(--text-3xl)] font-semibold leading-[1.1] tracking-[-0.03em] sm:text-[length:var(--text-4xl)]">
                She rings your property leads, tells them she is an AI, and books the site visit.
              </h1>

              <p className="mt-6 max-w-xl text-pretty text-[length:var(--text-base)] leading-relaxed text-[var(--color-text-dim)]">
                Anaga calls the people who left their number on your Meta or Instagram ad — in
                Telugu, Hindi or English, code-mixed the way Hyderabad actually talks. She finds out
                what they want, puts a visit in the diary, and takes a no as a no. Your closers do
                the closing.
              </p>

              <CtaPair className="mt-8" />

              <p className="mt-6 max-w-lg text-[length:var(--text-sm)] leading-relaxed text-[var(--color-text-dim)]">
                No dial happens until the compliance gate clears it, and the gate fails closed.
                &ldquo;Don&rsquo;t call me&rdquo; is one sentence, and it is permanent.
              </p>
            </Reveal>

            <Reveal delay={0.08}>
              <HeroCall />
            </Reveal>
          </div>
        </Section>

        {/* ============================================ FACT STRIP ======= */}
        <div className="border-y border-[var(--color-line-soft)] bg-[var(--color-surface)]">
          <div className="mx-auto grid w-full max-w-6xl gap-6 px-5 py-8 sm:grid-cols-3 sm:px-8">
            {FACTS.map((f) => (
              <div key={f.text} className="flex gap-3">
                <f.icon aria-hidden size={18} strokeWidth={1.75} className="mt-0.5 shrink-0 text-[var(--color-accent)]" />
                <p className="text-pretty text-[length:var(--text-sm)] leading-relaxed text-[var(--color-text-dim)]">
                  {f.text}
                </p>
              </div>
            ))}
          </div>
        </div>

        {/* ============================================ HOW IT WORKS ===== */}
        <Section id="how" className="scroll-mt-20">
          <Reveal>
            <SectionHead
              eyebrow="How it works"
              title="Lead in, site visit out — with a hard stop in the middle"
              lede="Six steps. The second one matters most, because it is the only one whose job is to say no."
            />
          </Reveal>

          <ol className="mt-12 flex flex-col">
            {PIPELINE.map((step, i) => (
              <Reveal
                key={step.title}
                as="li"
                delay={i * 0.04}
                className="relative flex gap-5 pb-10 last:pb-0 sm:gap-6"
              >
                {/* The connector rail. Absolutely positioned, so it never
                    participates in layout and never shifts the row. */}
                {i < PIPELINE.length - 1 && (
                  <span aria-hidden className="absolute left-5 top-11 bottom-0 w-px bg-[var(--color-line)] sm:left-6" />
                )}

                <span
                  aria-hidden
                  className="relative z-10 flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-[var(--color-line)] bg-[var(--color-elevated)] text-[var(--color-accent)] sm:h-12 sm:w-12"
                >
                  <step.icon size={18} strokeWidth={1.75} />
                </span>

                <div className="min-w-0 pt-1.5">
                  <h3 className="text-balance text-[length:var(--text-lg)] font-semibold leading-snug tracking-[-0.01em]">
                    <span className="tabular mr-2 text-[length:var(--text-sm)] font-medium text-[var(--color-text-dim)]">
                      {String(i + 1).padStart(2, '0')}
                    </span>
                    {step.title}
                  </h3>
                  <p className="mt-2 max-w-2xl text-pretty text-[length:var(--text-sm)] leading-relaxed text-[var(--color-text-dim)] sm:text-[length:var(--text-base)]">
                    {step.body}
                  </p>
                </div>
              </Reveal>
            ))}
          </ol>

          {/* "AI scores your leads" is not a claim anyone should accept
              without being shown the arithmetic. */}
          <Reveal>
            <Card className="mt-6">
              <CardBody>
                <h3 className="text-[length:var(--text-lg)] font-semibold tracking-[-0.01em]">
                  What the score is made of
                </h3>
                <p className="mt-2 max-w-2xl text-pretty text-[length:var(--text-sm)] leading-relaxed text-[var(--color-text-dim)]">
                  Four fields, fixed weights, versioned in the flow file right next to the script.
                  The outcome then caps the result — a call that ended in an opt-out scores zero
                  however well the middle of it went.
                </p>

                <dl className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  {WEIGHTS.map((w) => (
                    <div
                      key={w.label}
                      className="rounded-[var(--radius-md)] border border-[var(--color-line-soft)] bg-[var(--color-elevated)] p-4"
                    >
                      <dt className="text-[length:var(--text-sm)] font-medium text-[var(--color-text)]">{w.label}</dt>
                      <dd className="tabular mt-1 text-[length:var(--text-2xl)] font-semibold leading-none text-[var(--color-accent)]">
                        {w.weight}
                      </dd>
                      <dd className="mt-2 text-[length:var(--text-xs)] leading-relaxed text-[var(--color-text-dim)]">
                        {w.hint}
                      </dd>
                    </div>
                  ))}
                </dl>

                <p className="mt-5 text-pretty text-[length:var(--text-xs)] leading-relaxed text-[var(--color-text-dim)]">
                  Bands: 75 and above is hot, 50 warm, 25 cool, below that cold. Disposition
                  ceilings: booked 100, callback 85, undecided 70, busy 45, not interested 10,
                  opt-out 0.
                </p>
              </CardBody>
            </Card>
          </Reveal>
        </Section>

        {/* ============================================== LANGUAGES ====== */}
        <Section id="languages" className="scroll-mt-20 bg-[var(--color-surface)]">
          <Reveal>
            <SectionHead
              eyebrow="Three languages"
              title="She talks the way Hyderabad talks"
              lede="Property vocabulary stays English inside a Telugu or Hindi sentence, because that is what these calls actually sound like — pure literary Telugu reads as a government notice being recited. Every line below is reviewed wording, versioned in the repo. None of it is machine-translated at runtime, least of all the disclosure."
            />
          </Reveal>

          <div className="mt-12 grid gap-5 lg:grid-cols-3">
            {LANGUAGES.map((l, i) => (
              <Reveal key={l.code} delay={i * 0.06}>
                <Card className="h-full">
                  <CardBody className="flex h-full flex-col gap-5">
                    <div className="flex items-baseline gap-2">
                      <span lang={l.code} className="text-[length:var(--text-lg)] font-semibold">
                        {l.name}
                      </span>
                      <span className="text-[length:var(--text-xs)] text-[var(--color-text-dim)]">
                        {l.english}
                      </span>
                    </div>

                    <div>
                      <p className="mb-2 text-[length:var(--text-xs)] font-semibold uppercase tracking-[0.1em] text-[var(--color-accent)]">
                        Her first sentence
                      </p>
                      {/* lang= is why the Noto faces loaded in layout.tsx apply.
                          Without it these render in whatever the OS picks. */}
                      <p lang={l.code} className="text-pretty text-[length:var(--text-base)] leading-relaxed">
                        {l.disclosure}
                      </p>
                      <p className="mt-2 text-pretty text-[length:var(--text-xs)] leading-relaxed text-[var(--color-text-dim)]">
                        {l.disclosureGloss}
                      </p>
                    </div>

                    <div className="mt-auto border-t border-[var(--color-line-soft)] pt-5">
                      <p className="mb-2 text-[length:var(--text-xs)] font-semibold uppercase tracking-[0.1em] text-[var(--color-text-dim)]">
                        Mid-call
                      </p>
                      <p lang={l.code} className="text-pretty text-[length:var(--text-base)] leading-relaxed">
                        {l.midCall}
                      </p>
                      <p className="mt-2 text-pretty text-[length:var(--text-xs)] leading-relaxed text-[var(--color-text-dim)]">
                        {l.midCallGloss}
                      </p>
                    </div>
                  </CardBody>
                </Card>
              </Reveal>
            ))}
          </div>

          <Reveal>
            <div className="mt-6 rounded-[var(--radius-lg)] border border-[var(--color-line)] bg-[var(--color-bg)] p-5 sm:p-6">
              <h3 className="text-balance text-[length:var(--text-base)] font-semibold">
                The English words are written in the Indic script, on purpose
              </h3>
              <p className="mt-2 max-w-3xl text-pretty text-[length:var(--text-sm)] leading-relaxed text-[var(--color-text-dim)]">
                A borrowed word spelled in Latin inside a Telugu sentence gets read aloud as
                transliterated English by a voice that was asked to speak Telugu. So the borrowings
                are transcribed:
              </p>
              <ul className="mt-4 flex flex-wrap gap-2">
                {BORROWED.map((b) => (
                  <li key={b.native}>
                    <Badge tone="neutral" className="gap-2 py-1">
                      <span lang={b.lang} className="text-[length:var(--text-sm)] text-[var(--color-text)]">
                        {b.native}
                      </span>
                      <span className="text-[var(--color-text-dim)]">{b.from}</span>
                    </Badge>
                  </li>
                ))}
              </ul>
            </div>
          </Reveal>
        </Section>

        {/* ============================================== TURN-TAKING ==== */}
        <Section id="sounds" className="scroll-mt-20">
          <Reveal>
            <SectionHead
              eyebrow="Turn-taking"
              title="Why she does not sound like a menu tree"
              lede="Four mechanisms, described as mechanisms. There is no latency figure anywhere on this page: the one that used to be here was a target rather than a measurement, so it came down."
            />
          </Reveal>

          <div className="mt-12 grid gap-5 sm:grid-cols-2">
            {SOUND.map((s, i) => (
              <Reveal key={s.title} delay={i * 0.05}>
                <FeatureCard {...s} />
              </Reveal>
            ))}
          </div>
        </Section>

        {/* ============================================== COMPLIANCE ===== */}
        <Section id="compliance" className="scroll-mt-20 bg-[var(--color-surface)]">
          <Reveal>
            <SectionHead
              eyebrow="Compliance"
              title="The gate fails closed"
              lede="Indian outbound sits under TRAI and the TCCCPR via DLT, the 160-series mandate, the national DND register, the AI-disclosure direction and the DPDP Act. Anaga treats that as the product rather than the paperwork, because it is the part that is genuinely hard to copy."
            />
          </Reveal>

          <div className="mt-12 grid gap-5 lg:grid-cols-3">
            {MOAT.map((m, i) => (
              <Reveal key={m.title} delay={i * 0.06}>
                <FeatureCard {...m} />
              </Reveal>
            ))}
          </div>

          <Reveal>
            <div className="mt-6 rounded-[var(--radius-lg)] border border-[var(--color-line)] bg-[var(--color-bg)] p-5 sm:p-6">
              <h3 className="text-balance text-[length:var(--text-base)] font-semibold">
                Five checks, in this order, first failure wins
              </h3>

              <ol className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
                {GATE.map((g) => (
                  <li key={g.n} className="flex flex-col gap-2">
                    <span className="tabular inline-flex h-7 w-7 items-center justify-center rounded-full border border-[var(--color-line)] bg-[var(--color-elevated)] text-[length:var(--text-xs)] font-semibold text-[var(--color-accent)]">
                      {g.n}
                    </span>
                    <span className="text-[length:var(--text-sm)] font-medium text-[var(--color-text)]">
                      {g.title}
                    </span>
                    <span className="text-pretty text-[length:var(--text-xs)] leading-relaxed text-[var(--color-text-dim)]">
                      {g.body}
                    </span>
                  </li>
                ))}
              </ol>

              <ul className="mt-6 flex flex-wrap gap-x-6 gap-y-3 border-t border-[var(--color-line-soft)] pt-5">
                {GUARANTEES.map((x) => (
                  <li
                    key={x.text}
                    className="inline-flex items-center gap-2 text-[length:var(--text-xs)] text-[var(--color-text-dim)]"
                  >
                    <x.icon aria-hidden size={14} strokeWidth={1.75} className="shrink-0 text-[var(--color-text-dim)]" />
                    {x.text}
                  </li>
                ))}
              </ul>
            </div>
          </Reveal>

          <Reveal>
            <p className="mt-6 max-w-3xl text-pretty text-[length:var(--text-sm)] leading-relaxed text-[var(--color-text-dim)]">
              What Anaga does not do for you: DLT principal-entity registration, an approved header,
              telemarketer registration and a 160-series number all come from your telecom provider.
              Anaga enforces on top of them. It does not stand in for them, and it will not pretend a
              missing registration is a configuration detail.
            </p>
          </Reveal>
        </Section>

        {/* ================================================== SCOPE ====== */}
        <Section id="scope" className="scroll-mt-20">
          <Reveal>
            <div className="rounded-[var(--radius-xl)] border border-[var(--color-line)] bg-[var(--color-elevated)] p-6 sm:p-10">
              <div className="flex flex-col gap-8 lg:flex-row lg:items-center lg:justify-between lg:gap-12">
                <div className="max-w-2xl">
                  <p className="mb-3 text-[length:var(--text-xs)] font-semibold uppercase tracking-[0.12em] text-[var(--color-accent)]">
                    Where she stops
                  </p>
                  <h2 className="text-balance text-[length:var(--text-2xl)] font-semibold leading-tight tracking-[-0.02em]">
                    Anaga qualifies and books. People close.
                  </h2>
                  <p className="mt-4 text-pretty text-[length:var(--text-base)] leading-relaxed text-[var(--color-text-dim)]">
                    She does not negotiate, quote a final price, or take a booking amount. When
                    somebody is ready to buy a home, that is a conversation with a person on your
                    team. Her job is to make sure that person&rsquo;s week is full of the right
                    conversations and empty of the wrong ones.
                  </p>
                </div>

                <CtaPair className="shrink-0" />
              </div>
            </div>
          </Reveal>
        </Section>
      </main>

      <SiteFooter />
    </>
  );
}
