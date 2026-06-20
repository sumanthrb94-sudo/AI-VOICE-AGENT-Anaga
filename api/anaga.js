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
import { turnPrompt, summaryPrompt, carePrompt, TURN_DISPOSITIONS, SUMMARY_DISPOSITIONS } from './_lib/prompts.js';
import { blockedByRateLimit } from './_lib/ratelimit.js';
import { addKnowledge, searchKnowledge } from './_lib/embeddings.js';

// Knowledge management accepts the ADMIN_API_KEY (primary) or CALL_TRIGGER_SECRET.
function secretOk(req) {
  const bearer = String((req.headers && req.headers['authorization']) || '').replace(/^Bearer\s+/i, '').trim();
  if (!bearer) return false;
  return (process.env.ADMIN_API_KEY && bearer === process.env.ADMIN_API_KEY) ||
         (process.env.CALL_TRIGGER_SECRET && bearer === process.env.CALL_TRIGGER_SECRET);
}

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

  if (action === 'summary')   return handleSummary(req, res, body);
  if (action === 'care')      return handleCare(req, res, body);
  if (action === 'kb-add')    return handleKbAdd(req, res, body);
  if (action === 'kb-search') return handleKbSearch(req, res, body);
  return handleTurn(req, res, body);
}

// Customer Care RAG agent — public, rate-limited. Answers grounded in the KB.
async function handleCare(req, res, body) {
  if (blockedByRateLimit(req, res, { key: 'care', max: 20, windowMs: 60000 })) return;
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message) return res.status(400).json({ error: 'message_required' });
  const clientId = String(body.clientId || process.env.TENANT_ID || 'modcon');
  const history = Array.isArray(body.history) ? body.history.slice(-8) : [];

  const context = await searchKnowledge({ clientId, query: message, count: 5 });
  const { system, user } = carePrompt(message, history, context);

  let out;
  try { out = await generate({ system, user, json: true }); }
  catch { return res.status(503).json({ error: 'llm_unavailable' }); }
  if (!out || typeof out !== 'object') return res.status(503).json({ error: 'llm_unavailable' });

  const answer = typeof out.answer === 'string' ? out.answer.trim() : '';
  if (!answer) return res.status(503).json({ error: 'llm_unavailable' });
  return res.status(200).json({
    answer,
    grounded: out.grounded === true,
    intent: ['info', 'buying', 'booking', 'complaint', 'other'].includes(out.intent) ? out.intent : 'info',
    handoff: out.handoff === true,
    sources: context.map((c) => c.title || c.source || 'kb').filter(Boolean).slice(0, 5),
  });
}

// Ingest a document into the knowledge base — secret-gated (server/admin only).
async function handleKbAdd(req, res, body) {
  if (!secretOk(req)) return res.status(401).json({ error: 'unauthorized' });
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (!content) return res.status(400).json({ error: 'content_required' });
  try {
    const r = await addKnowledge({
      clientId: String(body.clientId || process.env.TENANT_ID || 'modcon'),
      title: String(body.title || ''),
      content,
      source: String(body.source || ''),
      metadata: body.metadata || null,
    });
    return res.status(201).json({ ok: true, chunks: r.chunks });
  } catch (e) {
    console.error('kb_add_failed', String(e).slice(0, 160));
    if (String(e).includes('not_configured')) return res.status(503).json({ error: 'knowledge_base_not_configured' });
    return res.status(503).json({ error: 'kb_add_failed' });
  }
}

// Search the knowledge base — secret-gated (debug / internal tool).
async function handleKbSearch(req, res, body) {
  if (!secretOk(req)) return res.status(401).json({ error: 'unauthorized' });
  const query = typeof body.query === 'string' ? body.query.trim() : '';
  if (!query) return res.status(400).json({ error: 'query_required' });
  const results = await searchKnowledge({
    clientId: String(body.clientId || process.env.TENANT_ID || 'modcon'),
    query,
    count: body.count || 5,
  });
  return res.status(200).json({ ok: true, results });
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
