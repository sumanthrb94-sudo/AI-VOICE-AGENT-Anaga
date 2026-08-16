// shared/agent-token.js
//
// A short-lived ticket that says "this browser is allowed one call".
//
// ── WHY ────────────────────────────────────────────────────────────────────
// /agent is --allow-unauthenticated, because a browser has no shared secret to
// sign a request with and Cloud Run has no other way to let one connect. Every
// deploy has printed the consequence: anyone who finds the URL can open a
// socket and spend Sarvam and Deepgram credit, indefinitely, and the only
// mitigations were "do not publish the URL" and a max-instances ceiling that
// bounds the bill rather than preventing it.
//
// This closes it without giving the browser a secret. Vercel — which already
// knows who is signed in — mints a token; Cloud Run verifies it with a shared
// key that never leaves either server. The browser carries an opaque string it
// cannot forge and that expires in minutes.
//
// ── WHY NOT A JWT LIBRARY ──────────────────────────────────────────────────
// This repo has zero runtime dependencies, deliberately, and the whole format
// is a payload and an HMAC. Adding a dependency to the call service to avoid
// twenty lines would be the larger cost.
//
// ── WHAT IT IS NOT ─────────────────────────────────────────────────────────
// Not a session, not an authorisation decision about anything but "may open a
// socket", and not a substitute for the compliance gate. A token says a real
// signed-in person asked for this call. It says nothing about whether a NUMBER
// may be dialled — that is compliance.js, and it stays where it is.

import crypto from 'node:crypto';

const b64u = (buf) => Buffer.from(buf).toString('base64url');

/** Default life. Long enough to start a call, short enough that a leaked URL
 *  in a screen share or a log is worth nothing by the time anyone reads it. */
const DEFAULT_TTL_MS = 5 * 60 * 1000;

export function agentTokenConfigured(env = process.env) {
  return String(env.AGENT_TOKEN_SECRET || '').length >= 16;
}

/**
 * Mint a ticket for a signed-in user.
 * @returns {string} `payload.signature`, both base64url.
 */
export function mintAgentToken(user, { env = process.env, ttlMs = DEFAULT_TTL_MS, now = Date.now } = {}) {
  const secret = String(env.AGENT_TOKEN_SECRET || '');
  if (secret.length < 16) throw new Error('agent_token_not_configured');

  const payload = {
    // Who, so a call can be attributed and a single account can be cut off.
    e: String(user?.email || '').toLowerCase(),
    r: String(user?.role || 'demo'),
    // WHEN IT DIES. Absolute, not a duration: a duration is a promise the
    // verifier has to trust the issuer's clock for.
    x: now() + Math.max(1000, ttlMs),
    // So two tokens minted in the same millisecond are still different, and a
    // replayed one is identifiable.
    n: crypto.randomBytes(8).toString('base64url'),
  };
  const body = b64u(JSON.stringify(payload));
  return `${body}.${sign(body, secret)}`;
}

function sign(body, secret) {
  return crypto.createHmac('sha256', secret).update(body).digest('base64url');
}

/**
 * Verify a ticket.
 * @returns {{ok:true, user:{email:string, role:string}} | {ok:false, reason:string}}
 */
export function verifyAgentToken(token, { env = process.env, now = Date.now } = {}) {
  const secret = String(env.AGENT_TOKEN_SECRET || '');
  if (secret.length < 16) return { ok: false, reason: 'not_configured' };

  const raw = String(token || '');
  const dot = raw.indexOf('.');
  if (dot <= 0 || dot === raw.length - 1) return { ok: false, reason: 'malformed' };
  const body = raw.slice(0, dot);
  const mac = raw.slice(dot + 1);

  // CONSTANT TIME, and length-checked first because timingSafeEqual THROWS on
  // a length mismatch — which would turn a malformed token into a 500 and,
  // worse, into a different response time than a wrong one.
  const want = Buffer.from(sign(body, secret));
  const got = Buffer.from(mac);
  if (want.length !== got.length) return { ok: false, reason: 'bad_signature' };
  if (!crypto.timingSafeEqual(want, got)) return { ok: false, reason: 'bad_signature' };

  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); }
  catch { return { ok: false, reason: 'malformed' }; }

  // Checked AFTER the signature, never before: an expiry read from an
  // unverified payload is a number an attacker chose.
  if (!payload || typeof payload.x !== 'number' || payload.x < now()) {
    return { ok: false, reason: 'expired' };
  }
  if (!payload.e) return { ok: false, reason: 'malformed' };

  return { ok: true, user: { email: String(payload.e), role: String(payload.r || 'demo') } };
}
