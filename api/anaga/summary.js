// api/anaga/summary.js
//
// POST /api/anaga/summary — summarize a finished call into a CRM-style internal
// review (is the lead interested? score, disposition, recap, next action, and an
// internal comment written from our sales team's side).
// Provider-abstracted via api/_lib/llm.js; prompt from _lib/prompts.js.
// See shared/call-api-contract.md for the request/response contract.
//
// Failure mode: any LLM error -> HTTP 503 { error: "llm_unavailable" } so the
// browser renders a local heuristic review. Bad input -> 400 (never a 500).
// Secrets/stack traces are never leaked.

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
import { summaryPrompt, SUMMARY_DISPOSITIONS } from '../_lib/prompts.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  // Metered before any paid provider is touched.
  if (limited(req, res, { bucket: 'anaga_summary', limit: Number(process.env.RATE_LIMIT_SUMMARY || 10) })) return;

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
  if (!Array.isArray(history) || history.length === 0) {
    return res.status(400).json({ error: 'history_required' });
  }
  const valid = history.every(
    (t) => t && typeof t === 'object' && typeof t.text === 'string' &&
      (t.role === 'agent' || t.role === 'user')
  );
  if (!valid) {
    return res.status(400).json({ error: 'invalid_history' });
  }

  const { system, user } = summaryPrompt(history);

  let out;
  try {
    out = await generate({ system, user, json: true });
  } catch (err) {
    console.error(JSON.stringify({
      at: new Date().toISOString(), svc: 'vaak-api', event: 'llm_call_failed',
      endpoint: 'summary', model: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
      reason: String((err && err.message) || 'unknown'),
    }));
    return res.status(503).json({ error: 'llm_unavailable' });
  }

  if (out == null || typeof out !== 'object') {
    return res.status(503).json({ error: 'llm_unavailable' });
  }

  // Coerce / validate fields against the contract.
  const interested = out.interested === true;

  let score = Number(out.score);
  if (!Number.isFinite(score)) score = 0;
  score = Math.max(0, Math.min(100, Math.round(score))); // clamp 0-100

  const disposition = SUMMARY_DISPOSITIONS.includes(out.disposition)
    ? out.disposition
    : 'undecided';

  const summary = typeof out.summary === 'string' ? out.summary.trim() : '';
  const nextAction = typeof out.nextAction === 'string' ? out.nextAction.trim() : '';
  const comment = typeof out.comment === 'string' ? out.comment.trim() : '';

  return res.status(200).json({
    interested,
    score,
    disposition,
    summary,
    nextAction,
    comment,
  });
}
