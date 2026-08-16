// api/_lib/routes/calls-demo.js
//
// A browser demo call, recorded.
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────
// Every browser call was written down NOWHERE. The bridge emitted transcripts,
// timings and usage to the page, and the page dropped them when the tab
// closed. So the console read zero calls, zero transcripts and zero events on
// a deployment where calls had actually been held, and a signed-in user had no
// history because no record of them existed.
//
// ── WHY NOT /api/calls/outcome ────────────────────────────────────────────
// Because a demo is not a lead. That endpoint validates a phone number, adds
// opt-outs to the suppression register, writes back to a CRM and feeds the
// compliance funnel. Pushing a browser demo through it would put a fabricated
// number in the pipeline stats and a test conversation in the compliance
// record — the one record that has to stay true.
//
// These are the same `calls` collection with `demo: true` and an owner, so the
// console can show them and a demo user can be shown only their own.
//
// ── WHY THE BROWSER POSTS IT, NOT THE AGENT ───────────────────────────────
// The browser already holds every event AND the session cookie. The agent runs
// on Cloud Run, has no session, and would need a shared secret and a second
// trust path to say the same thing. A client can therefore post a record that
// flatters itself — accepted deliberately: the blast radius is one demo user's
// own history, and it buys the removal of a whole cross-service credential.
// Anything that must be trustworthy — the compliance record, the suppression
// list, usage billing — does not come from here.

import { requireMethod } from '../integrations/http.js';
import { limited, log, requestId } from '../guard.js';
import { currentUser, hasRole } from '../auth.js';
import { recordCall, recentCalls, storeBackend } from '../store.js';

/** The turn shape the bridge emits, kept only in the forms we display. */
function cleanHistory(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((t) => t && (t.role === 'agent' || t.role === 'user') && typeof t.text === 'string')
    // A transcript is not a place for an unbounded client-supplied string.
    .map((t) => ({ role: t.role, text: t.text.slice(0, 2000) }))
    .slice(0, 200);
}

/** Turn timings, numbers only — never text, never audio. */
function cleanTimings(raw) {
  if (!Array.isArray(raw)) return [];
  const n = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : null);
  return raw.slice(0, 200).map((t) => ({
    ttfa: n(t?.ttfa),
    ttfaFromSpeech: n(t?.ttfaFromSpeech),
    llm: n(t?.llm),
    tts: n(t?.tts),
  })).filter((t) => t.ttfa !== null);
}

const LANGS = ['te-IN', 'hi-IN', 'en-IN'];

export default async function handler(req, res) {
  if (req.method === 'POST') return save(req, res);
  if (req.method === 'GET') return list(req, res);
  return requireMethod(req, res, ['GET', 'POST']);
}

/** Who is asking. `demo` is enough — this route is the reason it exists. */
async function requireSignedIn(req, res) {
  let user = null;
  try { user = await currentUser(req); } catch { user = null; }
  if (!user) {
    res.status(401).json({ error: 'not_signed_in' });
    return null;
  }
  if (!hasRole(user, 'demo')) {
    res.status(403).json({ error: 'forbidden', need: 'demo' });
    return null;
  }
  return user;
}

async function save(req, res) {
  const user = await requireSignedIn(req, res);
  if (!user) return;

  // A call costs real vendor credit, so the write that follows one is rate
  // limited too — a loop posting records is cheap, but it is also the shape of
  // someone filling the store.
  if (limited(req, res, { bucket: 'demo_call', limit: Number(process.env.RATE_LIMIT_DEMO_CALL || 60) })) return;

  const rid = requestId(req);
  const body = req.body && typeof req.body === 'object' ? req.body : {};

  const history = cleanHistory(body.history);
  if (!history.length) return res.status(400).json({ error: 'empty_call' });

  const lang = LANGS.includes(String(body.lang)) ? String(body.lang) : 'en-IN';
  const timings = cleanTimings(body.timings);

  // THE ID IS OURS, NOT THE CLIENT'S. A client-chosen id can collide with — or
  // deliberately overwrite — another user's record.
  const id = `demo_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

  const call = {
    id,
    demo: true,
    // The owner is taken from the SESSION, never from the body. It is what
    // scopes the read below, so a client that could set it could read
    // everyone's calls by claiming to be them.
    owner: { email: user.email, name: user.name || '', role: user.role },
    lang,
    direction: 'outbound',
    disposition: 'demo',
    startedAt: Number(body.startedAt) || null,
    endedAt: Date.now(),
    turns: history.filter((t) => t.role === 'user').length,
    history,
    timings,
    // Median time-to-first-audio for this call, so the console can show what a
    // caller experienced without recomputing it on every render.
    ttfaP50: median(timings.map((t) => t.ttfa)),
    transport: 'browser',
  };

  const out = await recordCall(id, call);
  log('demo_call_recorded', {
    rid, callId: id, turns: call.turns, lang, durable: out?.ok !== false,
  });
  if (out?.ok === false) return res.status(503).json({ error: 'store_unavailable' });
  return res.status(201).json({ ok: true, id });
}

function median(xs) {
  const v = xs.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!v.length) return null;
  // Nearest-rank, to agree with shared/latency.js rather than quietly using a
  // different definition of the same word.
  return v[Math.max(0, Math.ceil(v.length * 0.5) - 1)];
}

async function list(req, res) {
  const user = await requireSignedIn(req, res);
  if (!user) return;

  if (storeBackend() !== 'firestore') {
    return res.status(200).json({ calls: [], durable: false });
  }

  const out = await recentCalls(Number(req.query?.limit) || 25);
  const all = (out?.ok && Array.isArray(out.data) ? out.data : []).filter((c) => c?.demo === true);

  // SCOPED BY DEFAULT. An operator or owner sees every demo call; a `demo`
  // user sees only their own, and the filter is on the stored owner rather
  // than on anything the request said about itself.
  const mine = hasRole(user, 'viewer')
    ? all
    : all.filter((c) => String(c?.owner?.email || '').toLowerCase() === String(user.email).toLowerCase());

  return res.status(200).json({
    calls: mine.map((c) => ({
      id: c.id,
      lang: c.lang,
      turns: c.turns,
      startedAt: c.startedAt,
      endedAt: c.endedAt,
      ttfaP50: c.ttfaP50 ?? null,
      // The transcript is deliberately NOT in the list. It is fetched one call
      // at a time through /api/calls/transcript, where the read is logged.
      by: hasRole(user, 'viewer') ? (c.owner?.email || null) : undefined,
    })),
    durable: true,
    scope: hasRole(user, 'viewer') ? 'all' : 'mine',
  });
}
