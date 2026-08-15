import {
  AudioLines,
  CalendarCheck,
  ClipboardCheck,
  Database,
  FileText,
  Languages as LanguagesIcon,
  Mic,
  Phone,
  PhoneOff,
  ScrollText,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';

/* ===========================================================================
   MARKETING COPY — as data, kept out of the layout.

   Same reason the call script lives in caller-agent/flows/*.json rather than in
   the caller agent: the words are the thing being reviewed, and a reviewer
   should be able to read them without reading JSX around them.

   PROVENANCE. Every factual claim below is quoted from something in this repo,
   and the comment above each block says which. Nothing here is a number
   somebody hoped for:

   - No latency figure appears anywhere on this page. The old site published
     "<500 ms time-to-first-audio" as if it were measured; it was a target, the
     live stack does not hit it, and it had to be retracted — see the comment at
     web/assets/app.js:22-29. Speed is described by MECHANISM instead, because a
     mechanism can be checked and a stopwatch claim cannot be walked back.
   - No customers, logos, testimonials or volumes. There are none yet.
   - Anaga qualifies and books. She does not close, and the page says so in its
     own section rather than in a footnote.
   =========================================================================== */

export interface Feature {
  icon: LucideIcon;
  title: string;
  body: string;
  id?: string;
}

/* --- The pipeline. Source: docs/ARCHITECTURE.md, api/_lib/compliance.js,
       api/calls/outcome.js, and the `directions.outbound` block of
       caller-agent/flows/real-estate-qualify.flow.json. ------------------- */
export const PIPELINE: Feature[] = [
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
      'Five checks in a fixed order, first failure wins. Nothing about the lead, the script or the schedule can route around it, and a check that cannot be completed counts as a failure rather than a warning.',
  },
  {
    icon: Phone,
    title: 'She calls, and says what she is',
    body:
      'Her first sentence names her, names Modcon Builders, and says she is an AI voice assistant. The flow cannot advance past the open without it — the disclosure is not a step that gets skipped because the prospect sounds busy.',
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
      'A confirmed day, a callback, or an opt-out. She does not push past a no. Whatever the disposition, it caps the score: somebody who opted out is not a warm lead because they mentioned a budget first.',
  },
  {
    icon: Database,
    title: 'It lands where your team already works',
    body:
      'Call note, disposition, the score with its arithmetic, the recording reference and the next action all go to the CRM. If it was an opt-out, the suppression list is written first — that is the write that actually stops tomorrow’s dial.',
  },
];

/* --- Scoring. Source: the `qualification` block of the flow file. -------- */
export const WEIGHTS = [
  { label: 'Timeline', hint: 'when they intend to buy', weight: 40 },
  { label: 'Budget', hint: 'the range they are working with', weight: 30 },
  { label: 'Purpose', hint: 'to live in, or to invest', weight: 15 },
  { label: 'Configuration', hint: '2BHK, 3BHK, or larger', weight: 15 },
];

/* --- Her actual lines. The disclosures are quoted verbatim from
       caller-agent/flows/anaga.persona.json; the mid-call lines from the
       `globals.style.examples` block of the flow file. Both are reviewed
       wording, versioned per language, never machine-translated at runtime. */
export const LANGUAGES = [
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
    disclosureGloss: 'The same sentence, reviewed on its own rather than translated across.',
    midCall: 'Two BHK or three BHK?',
    midCallGloss: 'Configuration, asked the way it gets asked on the phone.',
  },
];

/* --- Code-mixing. Every one of these is lifted from the Telugu and Hindi
       lines in the flow file, where the borrowed word is written in the Indic
       script rather than in Latin. ---------------------------------------- */
export const BORROWED = [
  { native: 'ఎంక్వైరీ', lang: 'te' as const, from: 'enquiry' },
  { native: 'ఇన్వెస్ట్‌మెంట్', lang: 'te' as const, from: 'investment' },
  { native: 'టూ బీహెచ్‌కే', lang: 'te' as const, from: 'two BHK' },
  { native: 'పొజెషన్', lang: 'te' as const, from: 'possession' },
  { native: 'साइट विजिट', lang: 'hi' as const, from: 'site visit' },
  { native: 'बजट', lang: 'hi' as const, from: 'budget' },
  { native: 'टाइम', lang: 'hi' as const, from: 'time' },
];

/* --- The gate, in the order api/_lib/compliance.js runs it. -------------- */
export const GATE = [
  { n: 1, title: 'Shape', body: 'A number we can actually dial, normalised to E.164.' },
  {
    n: 2,
    title: 'Consent',
    body:
      'A real basis to call, with a timestamp, still inside the consent window — 90 days by default. No basis, no dial.',
  },
  {
    n: 3,
    title: 'Suppression',
    body:
      'Your own do-not-call list. If the list cannot be read, the answer is no rather than probably-fine.',
  },
  {
    n: 4,
    title: 'DND scrub',
    body:
      'The TRAI / DLT registry, through whichever provider you have wired. An unreachable scrub blocks the dial.',
  },
  {
    n: 5,
    title: 'Calling window',
    body:
      'Outbound only between 09:00 and 21:00 IST, computed in IST whatever timezone the server thinks it is in.',
  },
];

/* --- Turn-taking, as MECHANISMS. Sources: the `globals.backchannel` block of
       the flow file, docs/ARCHITECTURE.md §1 (recogniser chosen per language)
       and the SCRIPT notes in both flow files (native script, not Roman). --- */
export const SOUND: Feature[] = [
  {
    icon: AudioLines,
    title: 'Barge-in',
    body:
      'Start talking over her and she stops. An agent that finishes its sentence while you are objecting is the clearest possible tell that nothing is listening.',
  },
  {
    icon: Mic,
    title: 'A backchannel, before the answer exists',
    body:
      'The moment you stop talking she says సరే, ठीक है or right. Those carry no information and commit to nothing, which is exactly why they can be said before the model has decided anything — and they live in the flow file, not in code, because a prospect hears them.',
  },
  {
    icon: LanguagesIcon,
    title: 'The recogniser is chosen per language',
    body:
      'Telugu and Hindi go to a recogniser that can follow a sentence which switches into English halfway through. A model pinned to a single language code cannot, and code-mixing is not an edge case here — it is what the call sounds like.',
  },
  {
    icon: ScrollText,
    title: 'Native script all the way to the voice',
    body:
      'Her Telugu and Hindi lines are stored in Telugu and Devanagari, never Roman transliteration. Hand a Latin string to a voice that was asked to speak te-IN and it reads it as transliterated English — which is what "sounds synthetic" usually turns out to be.',
  },
];

/* --- The compliance moat. Sources: api/_lib/compliance.js (fail-closed gate,
       dev-mode switch), shared/optout.js (matched before the model sees the
       utterance, Indic + romanised, biased to false positives),
       api/calls/outcome.js (suppression written before the CRM),
       anaga.persona.json (disclosure is versioned, non-skippable). --------- */
export const MOAT: Feature[] = [
  {
    icon: ShieldCheck,
    title: 'Unverifiable means no dial',
    body:
      'Default-deny, not default-allow. If the DND scrub times out, or the suppression list cannot be reached, or nothing has been configured yet, the answer is no. There is exactly one development switch that relaxes this, it says so loudly, and it must never be set on a deployment that dials real numbers.',
  },
  {
    icon: PhoneOff,
    id: 'compliance-optout',
    title: 'The opt-out lands before anything else',
    body:
      'Every prospect utterance is checked for an opt-out before the model sees it, so the model is never the thing that decides whether somebody asked us to stop. It matches English, Hindi and Telugu including the romanised code-mixing people actually use, and it is deliberately biased toward false positives — ending a call we could have continued costs one lead; missing an opt-out is a breach. The suppression list is written first, and the opt-out overrides whatever disposition the agent reported.',
  },
  {
    icon: FileText,
    title: 'The disclosure is written, not translated',
    body:
      'The sentence that makes the call legal is reviewed wording, versioned per language in the repo, and it is never generated or machine-translated at runtime. It is not skippable, and the flow cannot move past the open without it.',
  },
];
