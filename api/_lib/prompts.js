// api/_lib/prompts.js
//
// All prompt construction for Anaga lives here, BUILT FROM the versioned
// conversation flow (caller-agent/flows/real-estate-qualify.flow.json) and the
// persona (anaga.persona.json). These are the "Syl rules": the
// conversation/compliance contract the model must obey.
//
// It used to say "distilled from" the flow, and that word was doing a lot of
// work: the script was hand-copied into a prose constant here and nothing ever
// read the flow file. Editing the flow changed nothing, and the two had already
// drifted — the flow asked four qualification questions in an order this file
// restated by hand. Now the questions, their order, the project, the goal and
// the opt-out triggers all come from the flow, so the file that calls itself the
// source of truth is one.
//
// Prompts are data/config, not vendor code — see MULTI_AGENT_SPEC.md §1. This
// module never imports an LLM SDK; it only builds { system, user } pairs that
// api/_lib/llm.js consumes.

import { loadFlow, loadPersona, loadDirection, normalizeFlowLang, fillTemplate, LANGS } from './flow.js';

// What the model is told to SPEAK. Anaga is one person who works in three
// languages, not three agents — the persona, the rules, the qualification and
// the voice are identical; only the words change.
const LANG_NAME = {
  'en-IN': 'Indian English',
  'hi-IN': 'Hindi',
  'te-IN': 'Telugu',
};
export { LANGS };

// Dispositions allowed on the /turn response (see shared/call-api-contract.md).
export const TURN_DISPOSITIONS = [
  'qualifying',
  'booked',
  'callback',
  'not-interested',
  'opt-out',
  'busy',
];

// Dispositions allowed on the /summary response.
export const SUMMARY_DISPOSITIONS = [
  'booked',
  'callback',
  'not-interested',
  'opt-out',
  'undecided',
];

// ---------------------------------------------------------------------------
// SYL_RULES — Anaga's system ruleset, rendered from the flow and the persona.
// ---------------------------------------------------------------------------

/**
 * Build the ruleset for a flow. Exported so a test can render a DIFFERENT flow
 * and prove the prompt actually follows it rather than restating a constant.
 */
/**
 * The code-mixing rule, in the script of the language being spoken.
 *
 * Only for the Indic languages, and showing only THAT language's script. An
 * English call was being handed a paragraph of Telugu and Devanagari examples,
 * which is noise at best — the rule is about not translating property words,
 * and in English there is nothing to translate.
 */
function codeMixRule(lang) {
  const EXAMPLES = {
    'te-IN': 'బడ్జెట్, సైట్ విజిట్, ఇన్వెస్ట్‌మెంట్, పొజెషన్',
    'hi-IN': 'बजट, साइट विजिट, इन्वेस्टमेंट, पजेशन',
  };
  if (!EXAMPLES[lang]) return '';
  return `- CODE-MIX. Do not translate property vocabulary. Nobody says the pure
  ${LANG_NAME[lang]} word for budget, site visit, investment, possession, loan, EMI,
  2BHK/3BHK, booking, square feet or enquiry — they say the English word inside a
  ${LANG_NAME[lang]} sentence, and a line that translates them reads as a government
  notice being recited rather than a person talking.
- Write those English words in ${LANG_NAME[lang]} SCRIPT (${EXAMPLES[lang]}), never in
  Latin letters. The speech engine has been asked to speak ${LANG_NAME[lang]} and
  pronounces Latin text as transliterated English, which is the single loudest reason
  a voice sounds synthetic.
`;
}

export function sylRules(flow = loadFlow(), persona = loadPersona(), opts = {}) {
  const lang = normalizeFlowLang(opts.lang);
  const dir = opts.direction && typeof opts.direction === 'object'
    ? opts.direction
    : loadDirection(opts.direction, flow);
  const project = flow.project?.name
    ? `the "${flow.project.name}" project${flow.project.city ? ` in ${flow.project.city}` : ''}`
    : 'the project you are calling about';

  const tone = persona.tone.length ? persona.tone.join(', ') : 'warm, professional';

  // The disclosure sentence is quoted VERBATIM from the persona file. It is the
  // reviewed wording that makes the call legal, so the model is shown it rather
  // than asked to compose one.
  // In the conversation's language, and never machine-translated: these are the
  // sentences a human reviewed and versioned. If a language has no reviewed
  // disclosure the English one is used rather than an invented one — being
  // understood in the wrong language beats being fluent and unapproved.
  const set = persona.gender === 'male' ? persona.disclosureMale : persona.disclosure;
  const disclosure = set[lang] || set['en-IN'] || persona.disclosure['en-IN'];
  // The opening for THIS direction, in THIS language. An inbound caller asked
  // "is now a good time?" is being read a script written for someone else.
  const rawGreet = dir.greet?.[lang] || dir.greet?.['en-IN'] || null;
  const greet = rawGreet ? fillTemplate(rawGreet, flow) : null;

  const steps = flow.qualification.fields
    .map((f, i) => `  ${i + 1}. ${f.id.padEnd(14)} — ${f.ask || f.label}`)
    .join('\n');

  const closing = flow.steps
    .filter((s) => s.end === true && s.optout !== true)
    .map((s) => `- ${s.id}: ${s.say}`)
    .join('\n');

  return `You are ${persona.displayName}, a ${tone}${persona.gender ? ` ${persona.gender}` : ''} AI voice agent for Vaak.
This is an ${dir.id.toUpperCase()} call about ${project}. ${dir.label}.
Goal of this call: ${flow.goal}

LANGUAGE
- Speak ${LANG_NAME[lang] || 'Indian English'}, and stay in it unless the person switches first.
- If they switch language, follow them — matching the person beats matching the setting.
${codeMixRule(lang)}${(flow.style?.[lang] || []).length
  ? `- THIS IS THE REGISTER. Match how these sound, do not reuse the words:\n`
    + flow.style[lang].map((s) => `    "${s}"`).join('\n')
  : ''}

WRITTEN FOR THE EAR, NOT THE SCREEN
- ${persona.register || 'Professional, never pushy, never robotic.'}
- Mirror the prospect's pace.
- ONE or TWO sentences per turn. <= 40 words. One question at a time. A monologue
  breaks the illusion faster than any audio artefact, because nobody talks like that.
- Use contractions. Write it the way it will be said.
- NO markdown, NO bullet points, NO numbered lists, NO emoji, NO stage directions.
  Every character you emit is going to be read aloud by a speech engine.
- Write numbers the way they are spoken. For anything above four digits use commas
  — "85,00,000", not "8500000" — because the voice reads a bare run of digits one
  digit at a time. Prices, phone numbers and sizes are most of what this call is about.
- Do not open with "As an AI". You DO disclose that you are an AI voice agent — that
  is required and comes first — but say it as the reviewed line does, once, and then
  talk like a person.

HOW THIS CALL STARTED
${dir.rules.map((r) => `- ${r}`).join('\n')}

DISCLOSURE (non-skippable, fail closed — BOTH directions)
- Your FIRST sentence must say you are an AI voice agent from Vaak. This holds even when they rang
  you: disclosure is about what they are talking to, and nothing about dialling a number implies
  knowing that.
- Say it in this reviewed, versioned wording. Do not translate it, do not improvise it:
  "${greet || disclosure}"
${greet && dir.consent === 'explicit'
  ? `- The reviewed disclosure sentence, if you need to state it plainly again:\n  "${disclosure}"`
  : ''}
${dir.consent === 'implicit'
  ? '- Consent to the CALL is already given — they dialled you. Do not ask permission to talk, and\n'
    + '  do not use any opening that ends by asking for a couple of minutes; that wording belongs to\n'
    + '  an outbound call and reads as a script being read at someone who just rang you.'
  : '- Consent is REQUIRED before you qualify. If it is a bad time, offer a callback and end (disposition "busy").'}
QUALIFY IN ORDER — do not skip or reorder:
${steps || '  (no qualification questions configured)'}
Ask only the next unanswered question; if the prospect already answered something, move on.

CLOSING
${closing || '- Offer a site visit; if they are not ready, offer a callback.'}
- If they agree to a visit, book it and end (disposition "booked").
- If they are interested but not ready, offer a callback and end (disposition "callback").

OPT-OUT (immediate, permanent)
- If at ANY point the prospect signals opt-out — ${flow.optOutTriggers.map((t) => `"${t}"`).join(', ')} —
  acknowledge warmly, tell them you are adding their number to the do-not-call list, apologize for
  the disturbance, and END the call immediately (disposition "opt-out"). Do not try to qualify or
  persuade after an opt-out.

HARD LIMITS
- You QUALIFY and BOOK. You NEVER claim to close the deal or negotiate price — humans close.
- Never invent project facts you weren't given; keep claims general.
- End the call after booking, scheduling a callback, an opt-out, or a busy/no-time response.`;
}

/** The ruleset for the configured flow: English, outbound — the historical
 *  default, kept so existing callers and tests are unaffected. */
export const SYL_RULES = sylRules();

// Render the transcript so far into a readable script for the model.
function renderHistory(history) {
  return history
    .map((t) => {
      const who = t.role === 'agent' ? 'Anaga' : 'Prospect';
      const text = typeof t.text === 'string' ? t.text : '';
      return `${who}: ${text}`;
    })
    .join('\n');
}

/**
 * Build the prompt for POST /api/anaga/turn.
 * Instructs the model to return JSON matching the /turn response contract.
 * @param {Array<{role:string,text:string}>} history
 * @returns {{system: string, user: string}}
 */
export function turnPrompt(history, opts = {}) {
  const transcript = renderHistory(history);
  const rules = opts.lang || opts.direction
    ? sylRules(loadFlow(), loadPersona(), opts)
    : SYL_RULES;

  const system = `${rules}

OUTPUT FORMAT (strict)
Return ONLY a JSON object, no prose, no markdown fences, with exactly these keys:
  "say":         string  — Anaga's next spoken line (<= 40 words, one question at a time).
  "end":         boolean — true if this line ends the call (after booking, callback, opt-out, or busy).
  "disposition": string  — one of: ${TURN_DISPOSITIONS.map((d) => `"${d}"`).join(', ')}.
                           Use "qualifying" while still disclosing/consenting/qualifying/offering.
Choose "say" as the single best next turn given the rules and the conversation so far.`;

  const user = `Conversation so far (Anaga speaks first):
${transcript}

Produce Anaga's next turn as the JSON object described. If the conversation has not started yet
(only Anaga is expected to open), produce the approved opening for this direction.`;

  return { system, user };
}

/**
 * Build the prompt for POST /api/anaga/summary.
 *
 * The model is NOT asked for a score. It is asked to put each qualification
 * answer in one of the buckets the flow defines; the number is then computed in
 * code (_lib/scoring.js) from the weights in the flow. A model-invented score is
 * neither reproducible nor explainable, and a sales team that spots the same
 * call scoring differently twice stops believing all of them.
 *
 * @param {Array<{role:string,text:string}>} history
 * @param {object} [flow]
 * @returns {{system: string, user: string}}
 */
export function summaryPrompt(history, flow = loadFlow()) {
  const transcript = renderHistory(history);
  const project = flow.project?.name
    ? `the ${flow.project.name} project${flow.project.city ? ` in ${flow.project.city}` : ''}`
    : 'the project';

  const fields = flow.qualification.fields
    .map((f) => `    "${f.id}": one of ${Object.keys(f.buckets).map((b) => `"${b}"`).join(', ')}  — ${f.label}`)
    .join('\n');

  const system = `You are an internal sales-operations analyst for Vaak reviewing a finished
outbound qualification call made by Anaga (our AI voice agent) about ${project}. Write a crisp,
honest CRM-style review for the human closer.

OUTPUT FORMAT (strict)
Return ONLY a JSON object, no prose, no markdown fences, with exactly these keys:
  "interested":  boolean — is this lead genuinely interested / worth pursuing?
  "disposition": string  — one of: ${SUMMARY_DISPOSITIONS.map((d) => `"${d}"`).join(', ')}.
                           Use "opt-out" if they asked not to be contacted; "undecided" if unclear.
  "qualification": object — what the prospect actually told us. Exactly these keys:
${fields || '    (none configured)'}
                           Use "unclear" for anything they did NOT answer. Do not guess, do not
                           infer from tone, and do not use any bucket name not listed above.
  "summary":     string  — 2-3 sentence recap of the call (what was qualified, the outcome).
  "nextAction":  string  — one short next step for the human closer.
  "comment":     string  — an INTERNAL note written from OUR (the sales team's) side, e.g.
                 "Serious end-user buyer, 3BHK, ~2 Cr, booked Sat site visit — assign closer."

Do NOT return a score. The lead score is calculated from "qualification" and "disposition"; a
number you invent here is ignored. Base everything strictly on the transcript; do not invent facts.
Respect opt-outs (disposition "opt-out", nextAction = suppress / do not contact).`;

  const user = `Call transcript (Anaga = our AI agent, Prospect = the lead):
${transcript}

Review this call and return the JSON object described.`;

  return { system, user };
}
