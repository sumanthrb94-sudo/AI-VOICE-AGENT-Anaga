// api/_lib/google-identity.js
//
// Verify a Google ID token. Nothing else.
//
// ── WHY NOT THE FIREBASE ADMIN SDK, WHICH IS ALREADY IN THIS PROJECT ──────
// It would work, and it is one more vendor SDK inside business logic for a job
// that is 80 lines of node:crypto. More importantly it is the WRONG credential:
// the Firebase service-account key can read and write every document in
// Firestore, bypassing every security rule. Checking "is this Google ID token
// real?" needs no privilege at all — the answer comes from Google's PUBLIC
// signing keys. Using an omnipotent key for an unprivileged question is how a
// key ends up somewhere it should not be.
//
// So the admin key stays where it is (Firestore, server-side) and sign-in
// verifies against https://www.googleapis.com/oauth2/v3/certs, which anyone
// may fetch.
//
// ── WHAT AN ID TOKEN IS ───────────────────────────────────────────────────
// A JWS: base64url(header).base64url(payload).base64url(signature), RS256.
// Google publishes the public keys as a JWKS; `kid` in the header says which.
// Node can build a verifier straight from a JWK, so there is no dependency and
// no hand-rolled RSA.
//
// ── WHAT MUST BE CHECKED, AND WHY EACH ONE MATTERS ────────────────────────
// Skipping any of these turns "sign in with Google" into "sign in as anyone":
//
//   signature   or the token is just a base64 string the attacker wrote
//   iss         must be Google, not an issuer the attacker controls
//   aud         MUST equal OUR client id. This is the one people skip. A valid
//               Google token issued to a DIFFERENT app is still perfectly
//               signed; without this check, any developer with a Google client
//               id can mint tokens that log them in here.
//   exp / iat   an old token must stop working
//   email_verified  Google asserts the address is really theirs. Without it an
//               unverified address could match our admin allowlist.
//
// Everything fails closed: any problem returns null, never a partial identity.

import crypto from 'node:crypto';

const CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);

// Small clock tolerance. Serverless clocks are good but not perfect, and a
// token rejected because we are 400ms ahead of Google is a login that fails
// for no reason the user can act on.
const SKEW_MS = 60_000;

/** Cached JWKS. Google rotates these; the cache respects their Cache-Control. */
let cache = { keys: null, until: 0 };

/** Test seam: forget the cached keys. */
export function _resetKeyCache() {
  cache = { keys: null, until: 0 };
}

async function googleKeys(now = Date.now()) {
  if (cache.keys && now < cache.until) return cache.keys;

  const res = await fetch(CERTS_URL, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`google_certs_${res.status}`);
  const body = await res.json();
  if (!body || !Array.isArray(body.keys)) throw new Error('google_certs_malformed');

  // Honour Google's own expiry rather than inventing one. They rotate on their
  // schedule; caching past it means rejecting valid tokens signed with a new
  // key, which looks like "Google sign-in randomly stopped working".
  const cc = String(res.headers.get('cache-control') || '');
  const maxAge = Number(/max-age=(\d+)/.exec(cc)?.[1]);
  const ttl = Number.isFinite(maxAge) && maxAge > 0 ? maxAge * 1000 : 3600_000;

  cache = { keys: body.keys, until: now + ttl };
  return body.keys;
}

function decodeSegment(seg) {
  try { return JSON.parse(Buffer.from(seg, 'base64url').toString('utf8')); }
  catch { return null; }
}

/**
 * @param {string} idToken   the `credential` from Google Identity Services
 * @param {object} [o]
 * @param {string} [o.clientId]  defaults to GOOGLE_CLIENT_ID
 * @returns {Promise<null|{email,name,picture,sub,emailVerified,hd}>}
 */
export async function verifyGoogleIdToken(idToken, { clientId = process.env.GOOGLE_CLIENT_ID, now = Date.now() } = {}) {
  // No client id configured is a REFUSAL, not a skipped check. An `aud`
  // comparison against undefined would pass for every token on earth.
  if (!clientId) return null;
  if (typeof idToken !== 'string') return null;

  const parts = idToken.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;

  const header = decodeSegment(headerB64);
  const payload = decodeSegment(payloadB64);
  if (!header || !payload) return null;

  // RS256 only. Accepting the algorithm the TOKEN names is the classic JWT
  // vulnerability: "alg":"none" or an HMAC alg verified against a public key
  // both let an attacker sign their own token.
  if (header.alg !== 'RS256') return null;

  let keys;
  try { keys = await googleKeys(now); }
  catch { return null; }

  const jwk = keys.find((k) => k.kid === header.kid && k.kty === 'RSA');
  if (!jwk) return null;

  let ok = false;
  try {
    const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    ok = crypto.verify(
      'RSA-SHA256',
      Buffer.from(`${headerB64}.${payloadB64}`),
      key,
      Buffer.from(sigB64, 'base64url'),
    );
  } catch { return null; }
  if (!ok) return null;

  if (!ISSUERS.has(payload.iss)) return null;

  // `aud` may be a string or an array; both forms are legal and both must match.
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(clientId)) return null;

  const exp = Number(payload.exp) * 1000;
  const iat = Number(payload.iat) * 1000;
  if (!Number.isFinite(exp) || now > exp + SKEW_MS) return null;
  if (Number.isFinite(iat) && iat > now + SKEW_MS) return null;

  const email = String(payload.email || '').trim().toLowerCase();
  if (!email) return null;
  // Google sends this as a boolean or the string "true" depending on the flow.
  const emailVerified = payload.email_verified === true || payload.email_verified === 'true';
  if (!emailVerified) return null;

  return {
    email,
    emailVerified,
    sub: String(payload.sub || ''),
    name: String(payload.name || ''),
    picture: String(payload.picture || ''),
    hd: payload.hd ? String(payload.hd) : null,
  };
}

/**
 * The admin allowlist: who may sign in with Google, and as what.
 *
 * ADMIN_EMAILS="a@x.com:owner,b@x.com:operator" — the role is optional and
 * defaults to `operator`.
 *
 * This is an ALLOWLIST, not a filter applied after the fact. Sign-in creates an
 * account only for an address named here, because the alternative — anyone with
 * a Google account gets in and is then downgraded to viewer — means the whole
 * internet has a record in the user store and a page they can load.
 *
 * ── AND THEN THERE IS `demo` ─────────────────────────────────────────────
 * DEMO_SIGNIN=open lets ANY verified Google account sign in as `demo`, which
 * ranks BELOW viewer: it unlocks the live demo call and that account's own
 * call history, and nothing else. No console, no other people's calls, no
 * settings. See hasRole() in auth.js for the ranking that enforces it.
 *
 * It is OFF by default and must be turned on deliberately, because turning it
 * on has a cost that is easy to miss: every demo call spends real Sarvam and
 * Deepgram credit, and "anyone with a Google account" is not a small set. The
 * paragraph above is still true of the ADMIN list — opening demo sign-up does
 * not make the admin allowlist a filter, it adds a second, lower door.
 */
export function allowedRole(email) {
  const raw = String(process.env.ADMIN_EMAILS || '');
  const want = String(email || '').trim().toLowerCase();
  if (!want) return null;
  for (const entry of raw.split(',')) {
    const [addr, role] = entry.split(':').map((s) => String(s || '').trim().toLowerCase());
    if (addr && addr === want) {
      return ['owner', 'operator', 'viewer'].includes(role) ? role : 'operator';
    }
  }
  return demoSignInOpen() ? 'demo' : null;
}

/** Whether a Google account that is NOT an admin may sign in at all. */
export function demoSignInOpen() {
  return String(process.env.DEMO_SIGNIN || '').trim().toLowerCase() === 'open';
}

/** True when Google sign-in is wired at all. Health and the UI both ask. */
export function googleSignInConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID);
}
