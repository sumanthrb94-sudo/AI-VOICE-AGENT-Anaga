// api/_lib/integrations/http.js
//
// Tiny shared HTTP + crypto helpers for the integration tubing (Meta, CRM,
// dial queue, compliance). No npm dependencies: global fetch (Node 18+) and
// node:crypto only.
//
// Every outbound call is timed out and never surfaces upstream detail to the
// browser — callers translate failures into their own status codes.

import crypto from 'node:crypto';

const DEFAULT_TIMEOUT_MS = 10000;

/**
 * Fetch JSON with a hard timeout. Never throws on a non-2xx — the caller
 * decides what a 4xx/5xx means for that integration (fail open vs fail closed).
 *
 * @returns {Promise<{ok:boolean,status:number,data:any,error:string|null}>}
 */
export async function fetchJson(url, {
  method = 'GET',
  headers = {},
  body,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body != null && !headers['Content-Type']
        ? { 'Content-Type': 'application/json', ...headers }
        : headers,
      body: body == null ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
      signal: ctrl.signal,
    });
  } catch (err) {
    // Network error or timeout. Do not leak the URL (may carry a token).
    return {
      ok: false,
      status: 0,
      data: null,
      error: err && err.name === 'AbortError' ? 'timeout' : 'network_error',
    };
  } finally {
    clearTimeout(timer);
  }

  let data = null;
  const text = await res.text().catch(() => '');
  if (text) {
    try { data = JSON.parse(text); } catch { data = { _raw: text.slice(0, 500) }; }
  }

  return {
    ok: res.ok,
    status: res.status,
    data,
    error: res.ok ? null : `http_${res.status}`,
  };
}

/** Hex HMAC-SHA256 — used for Meta webhook verification and our own signing. */
export function hmacSha256Hex(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

/** Constant-time string compare that never throws on length mismatch. */
export function safeEqual(a, b) {
  const A = Buffer.from(String(a || ''), 'utf8');
  const B = Buffer.from(String(b || ''), 'utf8');
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

/**
 * Read the RAW request body — required for HMAC signature verification, where
 * a re-serialized object is not guaranteed to be byte-identical.
 *
 * Vercel's Node runtime may have already consumed and parsed the stream. Order:
 *   1. req.rawBody if the runtime exposed it,
 *   2. the still-unread stream,
 *   3. re-serialize req.body (documented caveat: byte-exactness is best-effort;
 *      it holds for Meta's compact ASCII JSON but can drift on exotic payloads).
 */
export async function readRawBody(req) {
  if (typeof req.rawBody === 'string' && req.rawBody.length) return req.rawBody;
  if (Buffer.isBuffer(req.rawBody) && req.rawBody.length) return req.rawBody.toString('utf8');

  if (req.readable && !req.readableEnded) {
    const chunks = [];
    try {
      for await (const chunk of req) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
      }
    } catch { /* fall through to the body fallbacks */ }
    if (chunks.length) return Buffer.concat(chunks).toString('utf8');
  }

  if (typeof req.body === 'string') return req.body;
  if (req.body && typeof req.body === 'object') {
    try { return JSON.stringify(req.body); } catch { /* ignore */ }
  }
  return '';
}

/** Parse a raw body string as JSON; returns null when it is not valid JSON. */
export function parseJson(raw) {
  if (typeof raw !== 'string' || !raw.length) return null;
  try {
    const out = JSON.parse(raw);
    return out && typeof out === 'object' ? out : null;
  } catch {
    return null;
  }
}

/**
 * Shared-secret bearer auth for our own inbound endpoints (/api/leads/intake,
 * /api/calls/outcome). Fails CLOSED: if INTEGRATIONS_API_KEY is unset, nothing
 * is authorized — an unconfigured deploy must not accept lead pushes.
 *
 * @returns {{ok:boolean, error?:string, status?:number}}
 */
export function authorize(req) {
  const expected = process.env.INTEGRATIONS_API_KEY;
  if (!expected) return { ok: false, status: 503, error: 'auth_not_configured' };

  const header = String(req.headers['authorization'] || '');
  const token = header.startsWith('Bearer ')
    ? header.slice(7).trim()
    : String(req.headers['x-api-key'] || '').trim();

  if (!token || !safeEqual(token, expected)) {
    return { ok: false, status: 401, error: 'unauthorized' };
  }
  return { ok: true };
}

/**
 * READ auth for surfaces a HUMAN looks at: the console, a transcript, a
 * recording. Accepts EITHER a signed-in session OR the machine key.
 *
 * ── THE GAP THIS CLOSES ──────────────────────────────────────────────────
 * authorize() above answers "is this our software?". It is one shared secret
 * with no identity behind it. Every console endpoint used only that, which
 * meant signing in as a person got you a session that nothing honoured — the
 * dashboard still demanded that a human paste a machine credential into a
 * text box, and then kept it in sessionStorage. A key typed into a browser is
 * a key that ends up in a screenshot, and it is the same key the caller agent
 * uses to report call outcomes.
 *
 * So: a person presents a session and is known by name and role; a machine
 * presents the key and is known to be ours. Both may READ.
 *
 * ── WHY THIS IS SAFE ON GET, AND WHY IT STOPS AT GET ─────────────────────
 * The session cookie is SameSite=Lax, which sends it on top-level navigation
 * but never on a cross-site XHR — that is the CSRF protection api/_lib/auth.js
 * documents. It holds for reads. It is NOT extended to anything that mutates
 * state or spends money: /api/calls/outcome and /api/leads/intake keep
 * authorize() alone, because those are machine-to-machine and a browser
 * should never be able to reach them at all.
 *
 * Order matters: the session is checked FIRST so an operator's own identity
 * is what gets logged, rather than the anonymous fleet key they happen to
 * also possess.
 *
 * @param {object} req
 * @param {{role?: 'viewer'|'operator'|'owner'}} [opts]
 * @returns {Promise<{ok:boolean, via?:'session'|'key', user?:object, status?:number, error?:string}>}
 */
export async function authorizeRead(req, { role = 'viewer' } = {}) {
  // Imported lazily so the machine-only endpoints that never call this do not
  // pull the user store into their cold start.
  const { currentUser, hasRole, authConfigured } = await import('../auth.js');

  if (authConfigured()) {
    let user = null;
    try { user = await currentUser(req); } catch { user = null; }
    if (user) {
      if (hasRole(user, role)) return { ok: true, via: 'session', user };
      // A REAL session with an insufficient role is a 403, and it stops here.
      // Falling through to the key check would let a viewer escalate simply by
      // also sending the fleet secret.
      return { ok: false, status: 403, error: 'forbidden', need: role };
    }
  }

  const key = authorize(req);
  if (key.ok) return { ok: true, via: 'key', user: null };

  // Report "not signed in" rather than the key's 503-when-unconfigured, unless
  // neither mechanism exists at all — otherwise a deployment with sessions but
  // no INTEGRATIONS_API_KEY tells a logged-out human the server is broken.
  if (key.status === 503 && !authConfigured()) return key;
  return { ok: false, status: 401, error: 'not_signed_in' };
}

/** Method guard used by every integration endpoint. */
export function requireMethod(req, res, methods) {
  const allowed = Array.isArray(methods) ? methods : [methods];
  if (allowed.includes(req.method)) return true;
  res.setHeader('Allow', allowed.join(', '));
  res.status(405).json({ error: 'method_not_allowed' });
  return false;
}
