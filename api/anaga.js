// api/anaga.js
//
// Consolidated Anaga brain endpoint — handles both turn and summary in one function.
//
// POST /api/anaga?action=turn    — next spoken line (was /api/anaga/turn)
// POST /api/anaga?action=summary — call summary / CRM review (was /api/anaga/summary)
//
// Legacy paths are rewritten here via vercel.json rewrites so existing callers
// (/api/anaga/turn, /api/anaga/summary) continue to work unchanged.

import { generate } from './_lib/llm.js';
import { turnPrompt, summaryPrompt, TURN_DISPOSITIONS, SUMMARY_DISPOSITIONS } from './_lib/prompts.js';
import { blockedByRateLimit } from './_lib/ratelimit.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const action = String(req.query && req.query.action || 'turn');

  let body = req.body;
  if (typeof body === 'string') {
    try { body = body.length ? JSON.parse(body) : {}; }
    catch { return res.status(400).json({ error: 'invalid_json' }); }
  }
  if (body == null || typeof body !== 'object') return res.status(400).json({ error: 'invalid_body' });

  if (action === 'summary') return handleSummary(req, res, body);
  return handleTurn(req, res, body);
}

async function handleTurn(req, res, body) {
  if (blockedByRateLimit(req, res, { key: 'turn', max: 40, windowMs: 60000 })) return;

  const history = body.history;
  if (!Array.isArray(history) || history.length === 0) return res.status(400).json({ error: 'history_required' });
  const valid = history.every((t) => t && typeof t === 'object' && typeof t.text === 'string' && (t.role === 'agent' || t.role === 'user'));
  if (!valid) return res.status(400).json({ error: 'invalid_history' });

  const direction = (body.direction === 'inbound' || body.direction === 'commercial') ? body.direction : 'outbound';
  const { system, user } = turnPrompt(history, direction);

  let out;
  try { out = await generate({ system, user, json: true }); }
  catch { return res.status(503).json({ error: 'llm_unavailable' }); }

  if (out == null || typeof out !== 'object') return res.status(503).json({ error: 'llm_unavailable' });

  const say = typeof out.say === 'string' ? out.say.trim() : '';
  if (!say) return res.status(503).json({ error: 'llm_unavailable' });
  const end = out.end === true;
  const disposition = TURN_DISPOSITIONS.includes(out.disposition) ? out.disposition : 'qualifying';

  return res.status(200).json({ say, end, disposition });
}

async function handleSummary(req, res, body) {
  if (blockedByRateLimit(req, res, { key: 'summary', max: 20, windowMs: 60000 })) return;

  const history = body.history;
  if (!Array.isArray(history) || history.length === 0) return res.status(400).json({ error: 'history_required' });
  const valid = history.every((t) => t && typeof t === 'object' && typeof t.text === 'string' && (t.role === 'agent' || t.role === 'user'));
  if (!valid) return res.status(400).json({ error: 'invalid_history' });

  const direction = (body.direction === 'inbound' || body.direction === 'commercial') ? body.direction : 'outbound';
  const { system, user } = summaryPrompt(history, direction);

  let out;
  try { out = await generate({ system, user, json: true }); }
  catch { return res.status(503).json({ error: 'llm_unavailable' }); }

  if (out == null || typeof out !== 'object') return res.status(503).json({ error: 'llm_unavailable' });

  const interested = out.interested === true;
  let score = Number(out.score);
  if (!Number.isFinite(score)) score = 0;
  score = Math.max(0, Math.min(100, Math.round(score)));
  const disposition = SUMMARY_DISPOSITIONS.includes(out.disposition) ? out.disposition : 'undecided';
  const summary = typeof out.summary === 'string' ? out.summary.trim() : '';
  const nextAction = typeof out.nextAction === 'string' ? out.nextAction.trim() : '';
  const comment = typeof out.comment === 'string' ? out.comment.trim() : '';

  return res.status(200).json({ interested, score, disposition, summary, nextAction, comment });
}
