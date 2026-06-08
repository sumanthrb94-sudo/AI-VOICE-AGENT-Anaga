// api/anaga/turn.js
//
// POST /api/anaga/turn — generate Anaga's next spoken line from the transcript
// so far. Provider-abstracted via api/_lib/llm.js; prompts from _lib/prompts.js.
// See shared/call-api-contract.md for the request/response contract.
//
// Failure mode: any LLM error -> HTTP 503 { error: "llm_unavailable" } so the
// browser falls back to its on-device rule engine ("fail soft, never break the
// demo"). Bad input -> 400 (never a 500). Secrets/stack traces are never leaked.

import { generate } from '../_lib/llm.js';
import { turnPrompt, TURN_DISPOSITIONS } from '../_lib/prompts.js';
import { blockedByRateLimit } from '../_lib/ratelimit.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  // Paid endpoint (Gemini tokens) — throttle per IP.
  if (blockedByRateLimit(req, res, { key: 'turn', max: 40, windowMs: 60000 })) return;

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
  // Each turn must look like { role, text }.
  const valid = history.every(
    (t) => t && typeof t === 'object' && typeof t.text === 'string' &&
      (t.role === 'agent' || t.role === 'user')
  );
  if (!valid) {
    return res.status(400).json({ error: 'invalid_history' });
  }

  // Which agent: outbound (we called them) or inbound (they called us). Default outbound.
  const direction = body.direction === 'inbound' ? 'inbound' : 'outbound';

  const { system, user } = turnPrompt(history, direction);

  let out;
  try {
    out = await generate({ system, user, json: true });
  } catch {
    // Do not surface provider details; the client switches to its rule engine.
    return res.status(503).json({ error: 'llm_unavailable' });
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

  return res.status(200).json({ say, end, disposition });
}
