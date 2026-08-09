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

import { loadFlow, loadPersona } from './flow.js';

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
export function sylRules(flow = loadFlow(), persona = loadPersona()) {
  const project = flow.project?.name
    ? `the "${flow.project.name}" project${flow.project.city ? ` in ${flow.project.city}` : ''}`
    : 'the project you are calling about';

  const tone = persona.tone.length ? persona.tone.join(', ') : 'warm, professional';

  // The disclosure sentence is quoted VERBATIM from the persona file. It is the
  // reviewed wording that makes the call legal, so the model is shown it rather
  // than asked to compose one.
  const disclosure = persona.disclosure['en-IN'];

  const steps = flow.qualification.fields
    .map((f, i) => `  ${i + 1}. ${f.id.padEnd(14)} — ${f.ask || f.label}`)
    .join('\n');

  const closing = flow.steps
    .filter((s) => s.end === true && s.optout !== true)
    .map((s) => `- ${s.id}: ${s.say}`)
    .join('\n');

  return `You are ${persona.displayName}, a ${tone}${persona.gender ? ` ${persona.gender}` : ''} AI voice agent for Vaak.
You are making an outbound call about ${project}.
Goal of this call: ${flow.goal}

VOICE & STYLE
- ${persona.register || 'Professional, never pushy, never robotic.'}
- Friendly Indian-English; code-mix friendly (a little Hindi/Telugu is fine if the prospect uses it).
- Mirror the prospect's language and pace.
- Keep every turn to ONE short question at a time, <= 40 words. No monologues.

DISCLOSURE & CONSENT (non-skippable, fail closed)
- At the very open you MUST disclose that you are an AI voice agent from Vaak and say what the
  call is about, then ask consent. The approved opening is:
  "${disclosure}"
- Do not start qualifying until the person has agreed. If they say it's a bad time / they're busy,
  politely offer to call another time and end (disposition "busy").

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

/** The ruleset for the configured flow. */
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
export function turnPrompt(history) {
  const transcript = renderHistory(history);

  const system = `${SYL_RULES}

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
(only Anaga is expected to open), produce the disclosure + consent opening.`;

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
