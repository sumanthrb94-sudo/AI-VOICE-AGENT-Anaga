// api/_lib/google.js
//
// Shared Google Cloud access for the non-Firestore APIs (Text-to-Speech,
// Translation). Dependency-free: a service-account JWT signed with node:crypto,
// exchanged for an OAuth access token — the same technique `firestore.js` uses.
//
// ── WHY THIS IS NOT IMPORTED FROM firestore.js ────────────────────────────
// firestore.js is on the compliance path: its token is what proves a number is
// suppressed, and a bug there fails a dial decision. It mints tokens for exactly
// one scope and caches exactly one token. Making it multi-scope to save thirty
// lines would put voice code inside the gate's auth path. These stay separate on
// purpose; the duplication is the cheaper risk.
//
// ── CREDENTIALS ───────────────────────────────────────────────────────────
// Two ways in, in priority order:
//
//   1. GOOGLE_API_KEY  — a plain API key. Simplest, and all that TTS/Translate
//      need. Restrict it to those two APIs in the console.
//   2. GOOGLE_SERVICE_ACCOUNT, else FIREBASE_SERVICE_ACCOUNT — the service
//      account JSON (raw or base64). The Firebase one already exists and is the
//      same GCP project, so this works with nothing new set.
//
// Reusing FIREBASE_SERVICE_ACCOUNT is convenient but not free: that key is an
// admin credential that bypasses every Firestore rule. If you would rather the
// voice path could not touch your database, set GOOGLE_API_KEY and it is used
// instead — the service account is never loaded.
//
// Neither credential is ever logged, and no error body from the token endpoint
// is surfaced (it can echo parts of the signed assertion).

import crypto from 'node:crypto';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const CLOUD_PLATFORM = 'https://www.googleapis.com/auth/cloud-platform';

// ---------------------------------------------------------------------------
// credentials
// ---------------------------------------------------------------------------

// Keyed on the raw env value, not on "have we parsed once" — a rotated key must
// take effect, and a test that swaps credentials must not get the first ones.
let cachedCreds = null;
let cachedFrom = null;

export function apiKey() {
  const k = process.env.GOOGLE_API_KEY;
  return k && k.trim() ? k.trim() : null;
}

export function loadServiceAccount() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT || process.env.FIREBASE_SERVICE_ACCOUNT;
  if (cachedCreds !== null && cachedFrom === raw) return cachedCreds;
  cachedFrom = raw;
  tokens.clear();                       // a new identity invalidates every token

  if (!raw) { cachedCreds = false; return false; }

  let json = String(raw).trim();
  // Accept base64 too — it survives env-var UIs that mangle newlines.
  if (!json.startsWith('{')) {
    try { json = Buffer.from(json, 'base64').toString('utf8'); }
    catch { cachedCreds = false; return false; }
  }

  try {
    const c = JSON.parse(json);
    if (!c.project_id || !c.private_key || !c.client_email) { cachedCreds = false; return false; }
    cachedCreds = c;
    return c;
  } catch {
    cachedCreds = false;
    return false;
  }
}

/** True when this deployment can call a Google Cloud API at all. */
export function googleConfigured() {
  return Boolean(apiKey() || loadServiceAccount());
}

/** Which credential would be used — for the health endpoint, never for logs. */
export function googleAuthMode() {
  if (apiKey()) return 'api_key';
  if (loadServiceAccount()) return 'service_account';
  return 'none';
}

export function googleProjectId() {
  const c = loadServiceAccount();
  return c ? c.project_id : null;
}

// ---------------------------------------------------------------------------
// auth: service-account JWT -> access token, cached per scope
// ---------------------------------------------------------------------------

const tokens = new Map();               // scope -> { value, expiresAt }

function b64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function accessToken(scope = CLOUD_PLATFORM) {
  const hit = tokens.get(scope);
  if (hit && Date.now() < hit.expiresAt) return hit.value;

  const c = loadServiceAccount();
  if (!c) throw new Error('google_not_configured');

  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: c.client_email,
    scope,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  }));

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  const signature = signer.sign(c.private_key).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claim}.${signature}`,
    }).toString(),
  });

  if (!res.ok) throw new Error(`google_auth_failed_${res.status}`);
  const data = await res.json();
  if (!data.access_token) throw new Error('google_auth_no_token');

  const value = data.access_token;
  tokens.set(scope, { value, expiresAt: Date.now() + ((data.expires_in || 3600) - 60) * 1000 });
  return value;
}

// ---------------------------------------------------------------------------
// request helper
// ---------------------------------------------------------------------------

/**
 * Call a googleapis endpoint with whichever credential is configured.
 * Returns the parsed JSON, or throws an Error whose `.code` is one of:
 *   not_configured | api_disabled | auth_failed | quota_exceeded | upstream_error
 *
 * `api_disabled` is split out from the other 403s deliberately. "You have not
 * turned this API on" is one click in the console; "your billing failed" is a
 * bank. Collapsing them into one opaque failure is how we spent a day last week
 * assuming a quota problem was a missing key.
 */
export async function googleFetch(url, { method = 'GET', body, scope = CLOUD_PLATFORM, timeoutMs = 15000 } = {}) {
  const key = apiKey();
  const headers = { 'Content-Type': 'application/json' };
  let target = url;

  if (key) {
    target += (url.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(key);
  } else {
    if (!loadServiceAccount()) throw fail('not_configured', 'google_not_configured');
    let token;
    try { token = await accessToken(scope); }
    catch (err) { throw fail('auth_failed', String(err?.message || 'google_auth_failed')); }
    headers.Authorization = `Bearer ${token}`;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(target, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal });
  } catch (err) {
    throw fail('upstream_error', String(err?.name === 'AbortError' ? 'google_timeout' : err?.message));
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const e = await res.json();
      message = (e && e.error && (e.error.message || e.error.status)) || message;
    } catch { /* a non-JSON error body tells us nothing extra */ }

    if (res.status === 403 && /has not been used in project|is disabled/i.test(message)) {
      throw fail('api_disabled', message);
    }
    if (res.status === 401 || res.status === 403) throw fail('auth_failed', message);
    if (res.status === 429) throw fail('quota_exceeded', message);
    throw fail('upstream_error', message);
  }

  return res.json();
}

function fail(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}
