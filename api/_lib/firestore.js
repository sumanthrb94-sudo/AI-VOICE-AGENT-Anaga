// api/_lib/firestore.js
//
// Firestore client — the durable datastore. This closes the blocker that
// mattered most in LAUNCH.md: without it, an opt-out lives only in one warm
// serverless instance and the number can be dialled again tomorrow.
//
// DEPENDENCY-FREE ON PURPOSE. `firebase-admin` is a large tree and this repo
// deploys with no install step (vercel.json: "no install step"). Everything
// here is the Firestore REST API plus a service-account JWT signed with
// node:crypto — about 150 lines, no build change, no cold-start penalty from a
// heavy SDK.
//
// ── CREDENTIALS ───────────────────────────────────────────────────────────
// The service account JSON is read from the FIREBASE_SERVICE_ACCOUNT env var
// (the whole JSON, or base64 of it). It is NEVER read from a file in the repo
// and never logged. A Firebase Admin key grants full project access and
// BYPASSES ALL FIRESTORE SECURITY RULES — treat it like a root password.
//
// ── FAIL BEHAVIOUR ────────────────────────────────────────────────────────
// Reads that inform a dial decision fail CLOSED: if Firestore is unreachable,
// `isSuppressed` reports "unknown", and the compliance gate turns unknown into
// a block. That is deliberate. A datastore outage must never become permission
// to call someone who opted out.

import crypto from 'node:crypto';

const SCOPE = 'https://www.googleapis.com/auth/datastore';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

// ---------------------------------------------------------------------------
// credentials
// ---------------------------------------------------------------------------
let token = { value: null, expiresAt: 0 };
// Cached against the raw env value, not just "have we parsed once". Caching on
// a bare flag meant a process that changed credentials (or a test that swapped
// them) kept using the first ones it ever saw.
let cachedCreds = null;
let cachedFrom = null;

export function loadCredentials() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (cachedCreds !== null && cachedFrom === raw) return cachedCreds;
  cachedFrom = raw;
  token = { value: null, expiresAt: 0 };      // a new identity invalidates the token

  if (!raw) { cachedCreds = false; return false; }

  let json = raw.trim();
  // Accept base64 too — it survives env-var UIs that mangle newlines.
  if (!json.startsWith('{')) {
    try { json = Buffer.from(json, 'base64').toString('utf8'); } catch { cachedCreds = false; return false; }
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

export function firestoreConfigured() {
  return Boolean(loadCredentials());
}

export function projectId() {
  const c = loadCredentials();
  return c ? c.project_id : null;
}

// ---------------------------------------------------------------------------
// auth: service-account JWT -> access token
// ---------------------------------------------------------------------------

function b64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function accessToken() {
  if (token.value && Date.now() < token.expiresAt) return token.value;

  const c = loadCredentials();
  if (!c) throw new Error('firestore_not_configured');

  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: c.client_email,
    scope: SCOPE,
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

  if (!res.ok) {
    // Never surface the body: it can echo parts of the assertion.
    throw new Error(`firestore_auth_failed_${res.status}`);
  }
  const data = await res.json();
  if (!data.access_token) throw new Error('firestore_auth_no_token');

  token = { value: data.access_token, expiresAt: Date.now() + ((data.expires_in || 3600) - 60) * 1000 };
  return token.value;
}

// ---------------------------------------------------------------------------
// value encoding — Firestore's typed-value format
// ---------------------------------------------------------------------------
export function toValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
  if (typeof v === 'object') return { mapValue: { fields: toFields(v) } };
  return { stringValue: String(v) };
}

export function toFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined) continue;
    fields[k] = toValue(v);
  }
  return fields;
}

export function fromValue(v) {
  if (!v || typeof v !== 'object') return null;
  if ('nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('stringValue' in v) return v.stringValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromValue);
  if ('mapValue' in v) return fromFields(v.mapValue.fields);
  return null;
}

export function fromFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) out[k] = fromValue(v);
  return out;
}

// ---------------------------------------------------------------------------
// REST operations
// ---------------------------------------------------------------------------
const TIMEOUT_MS = Number(process.env.FIRESTORE_TIMEOUT_MS || 6000);

function baseUrl() {
  const db = process.env.FIRESTORE_DATABASE_ID || '(default)';
  return `https://firestore.googleapis.com/v1/projects/${projectId()}/databases/${db}/documents`;
}

async function call(path, { method = 'GET', body, query = '' } = {}) {
  const tok = await accessToken();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${baseUrl()}${path}${query}`, {
      method,
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text().catch(() => '');
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* leave null */ }
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

/** Read one document. `{ found:false }` when it does not exist (404 is normal). */
export async function getDoc(collection, id) {
  const res = await call(`/${collection}/${encodeURIComponent(id)}`);
  if (res.status === 404) return { ok: true, found: false, data: null };
  if (!res.ok) return { ok: false, found: false, data: null, error: `firestore_${res.status}` };
  return { ok: true, found: true, data: fromFields(res.data?.fields) };
}

/** Create or overwrite a document at a known id. */
export async function setDoc(collection, id, data) {
  const res = await call(`/${collection}/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: { fields: toFields(data) },
  });
  return res.ok ? { ok: true } : { ok: false, error: `firestore_${res.status}` };
}

/**
 * Delete a document. Firestore answers 200 for a document that was not there,
 * so this is idempotent and `ok` does NOT mean "something was removed".
 *
 * encodeURIComponent matters more than it looks: suppression document ids ARE
 * phone numbers, so they begin with "+". Left unencoded, the delete lands on a
 * different path, returns 200, and the row stays — a silent no-op that reads as
 * success. That is not hypothetical; it is how a cleanup pass appeared to work
 * while removing nothing.
 */
export async function deleteDoc(collection, id) {
  const res = await call(`/${collection}/${encodeURIComponent(id)}`, { method: 'DELETE' });
  return res.ok ? { ok: true } : { ok: false, error: `firestore_${res.status}` };
}

/** Append a document with a server-generated id. */
export async function addDoc(collection, data) {
  const res = await call(`/${collection}`, { method: 'POST', body: { fields: toFields(data) } });
  if (!res.ok) return { ok: false, error: `firestore_${res.status}`, id: null };
  const name = res.data?.name || '';
  return { ok: true, id: name.split('/').pop() || null };
}

/**
 * Create a document only if it does not already exist. Used for lead dedupe:
 * Firestore rejects a duplicate create with 409, which is the atomic
 * "somebody else already claimed this id" signal a ring buffer could not give.
 */
export async function createDocIfAbsent(collection, id, data) {
  const res = await call(`/${collection}`, {
    method: 'POST',
    query: `?documentId=${encodeURIComponent(id)}`,
    body: { fields: toFields(data) },
  });
  if (res.ok) return { ok: true, created: true };
  if (res.status === 409) return { ok: true, created: false };   // already exists
  return { ok: false, created: false, error: `firestore_${res.status}` };
}

/** Run a structured query. Returns an array of { id, ...fields }. */
export async function query(collection, { where = [], orderBy = null, limit = 50, desc = true } = {}) {
  const structuredQuery = {
    from: [{ collectionId: collection }],
    limit,
  };

  if (where.length === 1) {
    structuredQuery.where = { fieldFilter: fieldFilter(where[0]) };
  } else if (where.length > 1) {
    structuredQuery.where = {
      compositeFilter: {
        op: 'AND',
        filters: where.map((w) => ({ fieldFilter: fieldFilter(w) })),
      },
    };
  }
  if (orderBy) {
    structuredQuery.orderBy = [{ field: { fieldPath: orderBy }, direction: desc ? 'DESCENDING' : 'ASCENDING' }];
  }

  const tok = await accessToken();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl()}:runQuery`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ structuredQuery }),
      signal: ctrl.signal,
    });
    if (!res.ok) return { ok: false, error: `firestore_${res.status}`, docs: [] };
    const rows = await res.json();
    const docs = (Array.isArray(rows) ? rows : [])
      .filter((r) => r.document)
      .map((r) => ({ id: r.document.name.split('/').pop(), ...fromFields(r.document.fields) }));
    return { ok: true, docs };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'timeout' : 'network_error', docs: [] };
  } finally {
    clearTimeout(timer);
  }
}

function fieldFilter([field, op, value]) {
  const OPS = {
    '==': 'EQUAL', '!=': 'NOT_EQUAL', '<': 'LESS_THAN', '<=': 'LESS_THAN_OR_EQUAL',
    '>': 'GREATER_THAN', '>=': 'GREATER_THAN_OR_EQUAL',
  };
  return { field: { fieldPath: field }, op: OPS[op] || 'EQUAL', value: toValue(value) };
}

/**
 * Connectivity probe for the health endpoint. Never returns credential data.
 *
 * Uses :listCollectionIds rather than a plain GET on /documents — the latter is
 * a "list documents in a collection" call, so with no collection it 404s on a
 * perfectly healthy database and reads as an outage.
 */
export async function ping() {
  if (!firestoreConfigured()) return { ok: false, error: 'not_configured' };
  try {
    const tok = await accessToken();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${baseUrl()}:listCollectionIds`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ pageSize: 20 }),
        signal: ctrl.signal,
      });
      if (!res.ok) return { ok: false, error: `firestore_${res.status}` };
      const data = await res.json();
      return { ok: true, projectId: projectId(), collections: data.collectionIds || [] };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return { ok: false, error: String(err && err.message) };
  }
}
