import Link from 'next/link';
import {
  ArrowRight,
  AudioLines,
  CalendarCheck,
  ClipboardCheck,
  Clock,
  Database,
  FileText,
  Languages as LanguagesIcon,
  Lock,
  Mic,
  Phone,
  PhoneOff,
  ScrollText,
  ShieldCheck,
  UserCheck,
} from 'lucide-react';
import { Badge, Card, CardBody, Section, SectionHead } from '@/components/ui/primitives';
import { SiteNav } from '@/components/site/nav';
import { SiteFooter } from '@/components/site/footer';
import { HeroCall, Reveal } from '@/components/site/hero-call';
import { cn } from '@/lib/utils';

/* ===========================================================================
   THE MARKETING PAGE

   Everything factual on this page is quoted from something in the repo:
   caller-agent/flows/*.json for her actual lines and the scoring weights,
   api/_lib/compliance.js for the gate, docs/COMPLIANCE.md for the frameworks.

   There is one number NOT on this page, deliberately: time-to-first-audio. The
   old site published "<500 ms", it was a target rather than a measurement, and
   it had to be retracted (see the comment at web/assets/app.js:22-29). Speed is
   described here by mechanism — barge-in, first-clause synthesis, the
   backchannel — because a mechanism is checkable and a number a prospect can
   time with a stopwatch had better be true.
   =========================================================================== */

/* ------------------------------------------------------------ CTA styling */

/* The two call-to-action links, styled to match `Button` without being one:
   these navigate, so they are anchors. Written out here rather than imported
   from nav.tsx because every export of a `'use client'` module arrives in a
   Server Component as a client reference, not as the string it looks like. */
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

/* --------------------------------------------------------------- the data */

const PIPELINE = [
  {
    icon: Mic,
    title: 'A lead leaves their number',
    body:
      'Someone taps your Meta or Instagram ad for a project and submits the form. That enquiry is the lawful basis for the call, which is why Anaga names it in her opening — a stranger who cannot place you hangs up.',
  },
  {
    icon: ShieldCheck,
    title: 'The compliance gate runs, before any dial',
    body:
      'Five checks in a fixed order, first failure wins. Nothing about the lead, the script or the schedule can route around it, and a check that cannot be completed counts as a failure.',
  },
  {
    icon: Phone,
    title: 'She calls, and says what she is',
    body:
      'Her first sentence names her, names Modcon Builders, and says she is an AI voice assistant. The flow cannot advance past the open without it — the disclosure is not a step that can be skipped when the prospect sounds busy.',
  },
  {
    icon: ClipboardCheck,
    title: 'She qualifies: purpose, budget, configuration, timeline',
    body:
      'The reviewing model only sorts each answer into a bucket. The score itself is computed in code from fixed weights, so two identical calls always score identically and a closer can be shown exactly how the number was reached.',
  },
  {
    icon: CalendarCheck,
    title: 'She books a site visit — or she stops',
    body:
      'A confirmed day, a callback, or an opt-out. She does not push past a no. Whatever the disposition, it caps the score: someone who opted out is not a warm lead because they mentioned a budget first.',
  },
  {
    icon: Database,
    title: 'It lands where your team already works',
    body:
      'Call note, disposition, the score with its arithmetic, the recording reference and the next action go to the CRM. If it was an opt-out, the suppression list is written first — that is the write that actually stops tomorrow’s dial.',
  },
];

const WEIGHTS = [
  { label: 'Timeline', hint: 'when they intend to buy', weight: 40 },
  { label: 'Budget', hint: 'range they are working with', weight: 30 },
  { label: 'Purpose', hint: 'to live in, or to invest', weight: 15 },
  { label: 'Configuration', hint: '2BHK, 3BHK, larger', weight: 15 },
];

const LANGUAGES = [
  {
    code: 'te' as const,
    name: 'తెలుగు',
    english: 'Telugu',
    disclosure:
      'హలో, నేను అనగా, మోడ్‌కాన్ బిల్డర్స్ నుంచి AI వాయిస్ అసిస్టెంట్‌ని. రెండు నిమిషాలు టైమ్ ఉందా?',
    disclosureGloss:
      'Hi, I’m Anaga, an AI voice assistant from Modcon Builders. Do you have two minutes?',
    midCall: 'బడ్జెట్ ఎంత దాకా ఆలోచిస్తున్నారు?',
    midCallGloss: 'What budget are you working with?',
  },
  {
    code: 'hi' as const,
    name: 'हिंदी',
    english: 'Hindi',
    disclosure:
      'नमस्ते, मैं अनगा हूँ, मॉडकॉन बिल्डर्स की AI वॉइस असिस्टेंट। दो मिनट बात कर सकती हूँ?',
    disclosureGloss:
      'Hello, I’m Anaga, Modcon Builders’ AI voice assistant. May I talk for two minutes?',
    midCall: 'इस वीकेंड साइट विजिट रख लें?',
    midCallGloss: 'Shall we set up a site visit this weekend?',
  },
  {
    code: 'en' as const,
    name: 'English',
    english: 'Indian English',
    disclosure:
      'Hi, I’m Anaga, an AI voice assistant from Modcon Builders. Is now a good time to talk for a couple of minutes?',
    disclosureGloss: 'The same sentence, reviewed separately rather than translated across.',
    midCall: 'Two BHK or three BHK?',
    midCallGloss: 'Configuration, asked the way it is asked on the phone.',
  },
];

const BORROWED = [
  { native: 'ఎంక్వైరీ', lang: 'te' as const, from: 'enquiry' },
  { native: 'ఇన్వెస్ట్‌మెంట్', lang: 'te' as const, from: 'investment' },
  { native: 'టూ బీహెచ్‌కే', lang: 'te' as const, from: 'two BHK' },
  { native: 'పొజెషన్', lang: 'te' as const, from: 'possession' },
  { native: 'साइट विजिट', lang: 'hi' as const, from: 'site visit' },
  { native: 'बजट', lang: 'hi' as const, from: 'budget' },
  { native: 'टाइम', lang: 'hi' as const, from: 'time' },
];

const GATE = [
  { n: 1, title: 'Shape', body: 'A number we can actually dial, normalised to E.164.' },
  {
    n: 2,
    title: 'Consent',
    body: 'A real basis to call, with a timestamp, inside the consent window — 90 days by default. No basis, no dial.',
  },
  {
    n: 3,
    title: 'Suppression',
    body: 'Your own do-not-call list. If the list cannot be read, the answer is no rather than probably-fine.',
  },
  {
    n: 4,
    title: 'DND scrub',
    body: 'The TRAI / DLT registry, through whichever provider you have wired. An unreachable scrub blocks the dial.',
  },
  {
    n: 5,
    title: 'Calling window',
    body: 'Outbound only between 09:00 and 21:00 IST, computed in IST regardless of where the server is.',
  },
];

const SOUND = [
  {
    icon: AudioLines,
    title: 'Barge-in',
    body:
      'Start talking over her and she stops. An agent that finishes its sentence while you are objecting is the single clearest tell that nobody is listening.',
  },
  {
    icon: Mic,
    title: 'A backchannel, before the answer exists',
    body:
      'The moment you stop talking she says సరే, ठीक है or right — carrying no information and committing to nothing, which is exactly why it can be said before the model has decided anything. Those words live in the flow file, not in code, because a prospect hears them.',
  },
  {
    icon: LanguagesIcon,
    title: 'The recogniser is chosen per language',
    body:
      'Telugu and Hindi go to a recogniser that can follow a sentence which switches to English halfway through. A model pinned to one language code cannot, and code-mixing is not an edge case here — it is how the call sounds.',
  },
  {
    icon: ScrollText,
    title: 'Native script all the way to the voice',
    body:
      'Her Telugu and Hindi lines are stored in Telugu and Devanagari, never Roman transliteration. Hand a Latin string to a voice asked to speak te-IN and it reads it as transliterated English — which is what "sounding synthetic" usually turns out to be.',
  },
];

/* -------------------------------------------------------------- the page */

const noscriptReveal =
  '<style>[data-reveal]{opacity:1 !important;transform:none !important}</style>';

export default function HomePage() {
  return (
    <>
      {/* If the bundle never arrives, nothing on this page stays invisible. */}
      <noscript dangerouslySetInnerHTML={{ __html: noscriptReveal }} />

      <SiteNav />

      <main id="main">
        {/* ================================================== HERO ======= */}
        <Section className="pt-12 pb-16 sm:pt-20 sm:pb-24">
          <div className="grid items-center gap-12 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] lg:gap-16">
            <Reveal>
              <p className="mb-4 inline-flex items-center gap-2 text-[length:var(--text-xs)] font-semibold uppercase tracking-[0.12em] text-[var(--color-accent)]">
                <Building2Dot />
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

              <div className="mt-8 flex flex-wrap items-center gap-3">
                <Link href="/call" className={CTA_PRIMARY}>
                  <Phone aria-hidden size={17} strokeWidth={2} />
                  Hear a live call
                </Link>
                <Link href="/login" className={CTA_SECONDARY}>
                  Sign in
                  <ArrowRight aria-hidden size={16} strokeWidth={2} />
                </Link>
              </div>

              <p className="mt-6 max-w-lg text-[length:var(--text-sm)] leading-relaxed text-[var(--color-text-faint)]">
                No dial happens until the compliance gate clears it, and the gate fails closed.
                &ldquo;Don&rsquo;t call me&rdquo; is one sentence, and it is permanent.
              </p>
            </Reveal>

            <Reveal delay={0.08}>
              <HeroCall />
            </Reveal>
          </div>
        </Section>

        {/* ========================================== CAPABILITY STRIP === */}
        <div className="border-y border-[var(--color-line-soft)] bg-[var(--color-surface)]">
          <div className="mx-auto grid w-full max-w-6xl gap-6 px-5 py-8 sm:grid-cols-3 sm:px-8">
            {[
              { icon: LanguagesIcon, text: 'Telugu, Hindi and English — code-mixed inside one sentence, not three separate scripts.' },
              { icon: UserCheck, text: 'The AI disclosure is her first sentence, in every language, and cannot be skipped.' },
              { icon: PhoneOff, text: 'An opt-out writes to the suppression list before anything else is touched.' },
            ].map((f) => (
              <div key={f.text} className="flex gap-3">
                <f.icon aria-hidden size={18} strokeWidth={1.75} className="mt-0.5 shrink-0 text-[var(--color-accent)]" />
                <p className="text-pretty text-[length:var(--text-sm)] leading-relaxed text-[var(--color-text-dim)]">
                  {f.text}
                </p>
              </div>
            ))}
          </div>
        </div>

        {/* ============================================== HOW IT WORKS === */}
        <Section id="how" className="scroll-mt-20">
          <Reveal>
            <SectionHead
              eyebrow="How it works"
              title="Lead in, site visit out — and a hard stop in the middle"
              lede="Six steps. The second one is the one that matters, because it is the one that is allowed to say no."
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
                {/* The rail. A pseudo-element would need CSS this project does
                    not have a home for, so it is an explicit span. */}
                {i < PIPELINE.length - 1 && (
                  <span
                    aria-hidden
                    className="absolute left-5 top-11 bottom-0 w-px bg-[var(--color-line)] sm:left-6"
                  />
                )}

                <span
                  aria-hidden
                  className="relative z-10 flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-[var(--color-line)] bg-[var(--color-elevated)] text-[var(--color-accent)] sm:h-12 sm:w-12"
                >
                  <step.icon size={18} strokeWidth={1.75} />
                </span>

                <div className="min-w-0 pt-1.5">
                  <h3 className="text-balance text-[length:var(--text-lg)] font-semibold leading-snug tracking-[-0.01em]">
                    <span className="tabular mr-2 text-[length:var(--text-sm)] font-medium text-[var(--color-text-faint)]">
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

          {/* --- the scoring detail, because "AI scores your leads" is not a
                  claim anybody should accept without the arithmetic --- */}
          <Reveal>
            <Card className="mt-6">
              <CardBody>
                <h3 className="text-[length:var(--text-lg)] font-semibold tracking-[-0.01em]">
                  What the score is made of
                </h3>
                <p className="mt-2 max-w-2xl text-pretty text-[length:var(--text-sm)] leading-relaxed text-[var(--color-text-dim)]">
                  Four fields, fixed weights, versioned in the flow file next to the script. The
                  outcome then caps the result — a call that ended in an opt-out scores zero however
                  well the middle of it went.
                </p>

                <dl className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  {WEIGHTS.map((w) => (
                    <div
                      key={w.label}
                      className="rounded-[var(--radius-md)] border border-[var(--color-line-soft)] bg-[var(--color-elevated)] p-4"
                    >
                      <dt className="text-[length:var(--text-sm)] font-medium text-[var(--color-text)]">
                        {w.label}
                      </dt>
                      <dd className="tabular mt-1 text-[length:var(--text-2xl)] font-semibold leading-none text-[var(--color-accent)]">
                        {w.weight}
                      </dd>
                      <dd className="mt-2 text-[length:var(--text-xs)] leading-relaxed text-[var(--color-text-faint)]">
                        {w.hint}
                      </dd>
                    </div>
                  ))}
                </dl>

                <p className="mt-5 text-[length:var(--text-xs)] leading-relaxed text-[var(--color-text-faint)]">
                  Bands: 75 and above is hot, 50 warm, 25 cool, below that cold. Disposition
                  ceilings: booked 100, callback 85, undecided 70, busy 45, not interested 10,
                  opt-out 0.
                </p>
              </CardBody>
            </Card>
          </Reveal>
        </Section>

        {/* ================================================ LANGUAGES ==== */}
        <Section id="languages" className="scroll-mt-20 bg-[var(--color-surface)]">
          <Reveal>
            <SectionHead
              eyebrow="Three languages"
              title="She talks the way Hyderabad talks"
              lede="Property vocabulary stays English inside a Telugu or Hindi sentence, because that is what these calls actually sound like. Pure literary Telugu reads as a government notice being recited. Every line below is reviewed wording, versioned in the repo — none of it is machine-translated at runtime, least of all the disclosure."
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
                      <span className="text-[length:var(--text-xs)] text-[var(--color-text-faint)]">
                        {l.english}
                      </span>
                    </div>

                    <div>
                      <p className="mb-2 text-[length:var(--text-xs)] font-semibold uppercase tracking-[0.1em] text-[var(--color-accent)]">
                        Her first sentence
                      </p>
                      <p
                        lang={l.code}
                        className="text-pretty text-[length:var(--text-base)] leading-relaxed text-[var(--color-text)]"
                      >
                        {l.disclosure}
                      </p>
                      <p className="mt-2 text-pretty text-[length:var(--text-xs)] leading-relaxed text-[var(--color-text-dim)]">
                        {l.disclosureGloss}
                      </p>
                    </div>

                    <div className="mt-auto border-t border-[var(--color-line-soft)] pt-5">
                      <p className="mb-2 text-[length:var(--text-xs)] font-semibold uppercase tracking-[0.1em] text-[var(--color-text-faint)]">
                        Mid-call
                      </p>
                      <p
                        lang={l.code}
                        className="text-pretty text-[length:var(--text-base)] leading-relaxed text-[var(--color-text)]"
                      >
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
              <h3 className="text-[length:var(--text-base)] font-semibold">
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
                      <span className="text-[var(--color-text-faint)]">{b.from}</span>
                    </Badge>
                  </li>
                ))}
              </ul>
            </div>
          </Reveal>
        </Section>

        {/* ================================================== SOUNDS ===== */}
        <Section id="sounds" className="scroll-mt-20">
          <Reveal>
            <SectionHead
              eyebrow="Turn-taking"
              title="Why she does not sound like a menu tree"
              lede="Four mechanisms, described as mechanisms. There is no latency figure on this page — the one that used to be here was a target rather than a measurement, so it came down."
            />
          </Reveal>

          <div className="mt-12 grid gap-5 sm:grid-cols-2">
            {SOUND.map((s, i) => (
              <Reveal key={s.title} delay={i * 0.05}>
                <Card className="h-full">
                  <CardBody className="flex h-full flex-col">
                    <s.icon aria-hidden size={20} strokeWidth={1.75} className="text-[var(--color-accent)]" />
                    <h3 className="mt-4 text-balance text-[length:var(--text-lg)] font-semibold leading-snug tracking-[-0.01em]">
                      {s.title}
                    </h3>
                    <p className="mt-2 text-pretty text-[length:var(--text-sm)] leading-relaxed text-[var(--color-text-dim)]">
                      {s.body}
                    </p>
                  </CardBody>
                </Card>
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
              lede="Indian outbound sits under TRAI and the TCCCPR via DLT, the 160-series mandate, the national DND register, the AI-disclosure direction and the DPDP Act. Anaga treats that as the product rather than the paperwork, because it is the part that is hard to copy."
            />
          </Reveal>

          <div className="mt-12 grid gap-5 lg:grid-cols-3">
            <Reveal>
              <Card className="h-full">
                <CardBody className="flex h-full flex-col">
                  <ShieldCheck aria-hidden size={20} strokeWidth={1.75} className="text-[var(--color-accent)]" />
                  <h3 className="mt-4 text-[length:var(--text-lg)] font-semibold leading-snug">
                    Unverifiable means no dial
                  </h3>
                  <p className="mt-2 text-pretty text-[length:var(--text-sm)] leading-relaxed text-[var(--color-text-dim)]">
                    Default-deny, not default-allow. If the DND scrub times out, or the suppression
                    list cannot be reached, or nothing has been configured yet, the answer is no.
                    There is exactly one development switch that relaxes this, it is loud about it,
                    and it must never be set on a deployment that dials real numbers.
                  </p>
                </CardBody>
              </Card>
            </Reveal>

            <Reveal delay={0.06}>
              <Card className="h-full" id="compliance-optout">
                <CardBody className="flex h-full flex-col">
                  <PhoneOff aria-hidden size={20} strokeWidth={1.75} className="text-[var(--color-accent)]" />
                  <h3 className="mt-4 text-[length:var(--text-lg)] font-semibold leading-snug">
                    The opt-out lands before anything else
                  </h3>
                  <p className="mt-2 text-pretty text-[length:var(--text-sm)] leading-relaxed text-[var(--color-text-dim)]">
                    Every prospect utterance is checked for an opt-out before the model sees it, so
                    the model is never the thing that decides whether someone asked us to stop. It
                    matches English, Hindi and Telugu, including the romanised code-mixing people
                    actually use, and it is deliberately biased toward false positives. The
                    suppression list is written first; the opt-out then overrides whatever
                    disposition the agent reported.
                  </p>
                </CardBody>
              </Card>
            </Reveal>

            <Reveal delay={0.12}>
              <Card className="h-full">
                <CardBody className="flex h-full flex-col">
                  <FileText aria-hidden size={20} strokeWidth={1.75} className="text-[var(--color-accent)]" />
                  <h3 className="mt-4 text-[length:var(--text-lg)] font-semibold leading-snug">
                    The disclosure is written, not translated
                  </h3>
                  <p className="mt-2 text-pretty text-[length:var(--text-sm)] leading-relaxed text-[var(--color-text-dim)]">
                    The sentence that makes the call legal is reviewed wording, versioned per
                    language, and it is never generated or machine-translated at runtime. It is not
                    skippable and the flow cannot move past the open without it. Changing it is a
                    reviewed change to a data file, with a version number attached.
                  </p>
                </CardBody>
              </Card>
            </Reveal>
          </div>

          {/* --- the five checks, in order --- */}
          <Reveal>
            <div className="mt-6 rounded-[var(--radius-lg)] border border-[var(--color-line)] bg-[var(--color-bg)] p-5 sm:p-6">
              <h3 className="text-[length:var(--text-base)] font-semibold">
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

              <div className="mt-6 flex flex-wrap gap-x-6 gap-y-3 border-t border-[var(--color-line-soft)] pt-5">
                {[
                  { icon: Clock, text: '09:00–21:00 IST calling window' },
                  { icon: Database, text: '90-day recording retention on Indian infrastructure' },
                  { icon: Lock, text: 'Phone numbers masked in logs and responses' },
                  { icon: ScrollText, text: 'Per-call audit record: scrub result, consent basis, disclosure, outcome' },
                ].map((x) => (
                  <span
                    key={x.text}
                    className="inline-flex items-center gap-2 text-[length:var(--text-xs)] text-[var(--color-text-dim)]"
                  >
                    <x.icon aria-hidden size={14} strokeWidth={1.75} className="shrink-0 text-[var(--color-text-faint)]" />
                    {x.text}
                  </span>
                ))}
              </div>
            </div>
          </Reveal>

          {/* --- what Anaga is NOT --- */}
          <Reveal>
            <p className="mt-6 max-w-3xl text-pretty text-[length:var(--text-sm)] leading-relaxed text-[var(--color-text-faint)]">
              What Anaga does not do for you: DLT principal-entity registration, an approved header,
              telemarketer registration and a 160-series number all come from your telecom provider.
              Anaga enforces on top of them. It does not stand in for them, and it will not pretend
              a missing registration is a configuration detail.
            </p>
          </Reveal>
        </Section>

        {/* =================================================== SCOPE ===== */}
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

                <div className="flex shrink-0 flex-col gap-3 sm:flex-row lg:flex-col">
                  <Link href="/call" className={CTA_PRIMARY}>
                    <Phone aria-hidden size={17} strokeWidth={2} />
                    Hear a live call
                  </Link>
                  <Link href="/login" className={CTA_SECONDARY}>
                    Sign in
                    <ArrowRight aria-hidden size={16} strokeWidth={2} />
                  </Link>
                </div>
              </div>
            </div>
          </Reveal>
        </Section>
      </main>

      <SiteFooter />
    </>
  );
}

/** A small decorative mark for the hero eyebrow. Decorative, so it is hidden. */
function Building2Dot() {
  return <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--color-accent)]" />;
}
