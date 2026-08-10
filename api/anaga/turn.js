// api/anaga/turn.js
//
// POST /api/anaga/turn — generate Anaga's next spoken line from the transcript
// so far. Provider-abstracted via api/_lib/llm.js; prompts from _lib/prompts.js.
// See shared/call-api-contract.md for the request/response contract.
//
// Failure mode: any LLM error -> HTTP 503 { error: "llm_unavailable" } so the
// browser falls back to its on-device rule engine ("fail soft, never break the
// demo"). Bad input -> 400 (never a 500). Secrets/stack traces are never leaked.

//
// ── THIS ENDPOINT SPENDS MONEY AND IS PUBLIC ──────────────────────────────
// The browser demo calls it with no credential, so it cannot require one — but
// it was also unmetered, which means anyone (or a crawler) could bill the
// Gemini/Sarvam account one request at a time from a URL that is indexed.
// The account's quota being exhausted mid-session is exactly what an unmetered
// paid endpoint on a public URL looks like.
//
// The limiter in guard.js is a per-instance dampener, NOT a hard cap — Vercel
// scales out and each instance counts separately. It raises the cost of a naive
// loop; it does not stop a distributed one. For a real ceiling put Vercel WAF or
// Cloudflare in front, or require a key and drop the anonymous demo.

import { generate } from '../_lib/llm.js';
import { limited } from '../_lib/guard.js';
import { turnPrompt, TURN_DISPOSITIONS } from '../_lib/prompts.js';
import { LANGS, loadFlow, loadDirection, fillTemplate, normalizeFlowLang } from '../_lib/flow.js';

export default async function handler(req, res) {
  // GET -> the APPROVED OPENING for this direction and language.
  //
  // It is reviewed, versioned wording in caller-agent/flows — it was never a
  // thing to generate. Asking the model for it cost an LLM round trip at the
  // most latency-sensitive moment of the call, spent money on a sentence we
  // already had, and let a paraphrase of the reviewed disclosure reach a real
  // prospect. Serving it from the flow is faster, cheaper and more compliant,
  // and it lets a caller pre-synthesize the line before the call starts.
  //
  // No LLM, so no metering: this is a static read of a JSON file.
  if (req.method === 'GET') {
    const lang = normalizeFlowLang(req.query?.lang);
    const flow = loadFlow();
    const dir = loadDirection(req.query?.direction, flow);
    const greet = dir.greet?.[lang] || dir.greet?.['en-IN'] || '';
    return res.status(200).json({
      say: fillTemplate(greet, flow),
      end: false,
      disposition: 'qualifying',
      lang,
      direction: dir.id,
      source: 'flow',                 // NOT a generation — say so
      flow: { id: flow.id, version: flow.version },
    });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  // Metered before any paid provider is touched.
  if (limited(req, res, { bucket: 'anaga_turn', limit: Number(process.env.RATE_LIMIT_TURN || 30) })) return;

  // Parse body robustly: Vercel may hand us a parsed object or a raw string.
  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = body.length ? JSON.parse(body) : {};
    } catch {
      return res.status(400).json({ error: 'invalid_json' });
    }
  }
  if (body == null || typeof body !== 'object') {
    return res.status(400).json({ error: 'invalid_body' });
  }

  const history = body.history;
  // AN EMPTY HISTORY IS THE OPENING TURN, not a bad request.
  //
  // This used to 400, which meant Anaga could not speak first — on an outbound
  // call, the one thing she must do. Every caller had to invent her opening
  // line locally to get a non-empty array, which is exactly the hardcoded
  // script the flow files exist to replace, and the prompt in prompts.js has
  // always said "if the conversation has not started yet, produce the approved
  // opening". The guard contradicted the prompt it guarded.
  if (!Array.isArray(history)) {
    return res.status(400).json({ error: 'history_required' });
  }
  // Each turn must look like { role, text }.
  const valid = history.every(
    (t) => t && typeof t === 'object' && typeof t.text === 'string' &&
      (t.role === 'agent' || t.role === 'user')
  );
  if (!valid) {
    return res.status(400).json({ error: 'invalid_history' });
  }

  // Language and direction are DATA about the call, not free text: an unknown
  // value resolves to the safe default (English, outbound) rather than being
  // passed through to the prompt, because everything here ends up inside a
  // model instruction and the caller is anonymous.
  const lang = LANGS.includes(body.lang) ? body.lang : 'en-IN';
  const direction = body.direction === 'inbound' ? 'inbound' : 'outbound';

  const { system, user } = turnPrompt(history, { lang, direction });

  let out;
  try {
    out = await generate({ system, user, json: true });
  } catch (err) {
    // LOG the reason. This used to be swallowed entirely, so a brain that was
    // 503-ing on every single call looked identical to one that was merely
    // unconfigured — and the only symptom was Anaga sounding like a script.
    // The message never contains the key (llm.js strips it).
    console.error(JSON.stringify({
      at: new Date().toISOString(), svc: 'vaak-api', event: 'llm_call_failed',
      endpoint: 'turn', model: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
      reason: String((err && err.message) || 'unknown'),
    }));
    // Distinguish "out of quota" from "down". The browser falls back to the
    // rule engine either way, but a founder staring at a scripted-sounding
    // Anaga deserves to know it is a billing problem, not a broken agent.
    const quota = err && (err.code === 'quota_exceeded' || /\b429\b|quota/i.test(String(err.message)));
    return res.status(503).json({
      error: 'llm_unavailable',
      reason: quota ? 'quota_exceeded' : 'upstream_error',
    });
  }

  if (out == null || typeof out !== 'object') {
    return res.status(503).json({ error: 'llm_unavailable' });
  }

  // Coerce / validate fields against the contract.
  const say = typeof out.say === 'string' ? out.say.trim() : '';
  if (!say) {
    return res.status(503).json({ error: 'llm_unavailable' });
  }
  const end = out.end === true;
  const disposition = TURN_DISPOSITIONS.includes(out.disposition)
    ? out.disposition
    : 'qualifying';

  // Echoed so the caller can render the transcript, and synthesize the reply,
  // in the language it was actually generated in.
  return res.status(200).json({ say, end, disposition, lang, direction });
}
