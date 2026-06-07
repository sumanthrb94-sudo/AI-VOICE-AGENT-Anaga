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

import { generate } from '../_lib/llm.js';
import { summaryPrompt, SUMMARY_DISPOSITIONS } from '../_lib/prompts.js';
import { blockedByRateLimit } from '../_lib/ratelimit.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  // Paid endpoint (Gemini tokens) — throttle per IP.
  if (blockedByRateLimit(req, res, { key: 'summary', max: 20, windowMs: 60000 })) return;

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
  } catch {
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
