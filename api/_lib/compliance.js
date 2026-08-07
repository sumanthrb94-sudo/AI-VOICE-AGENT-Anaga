// api/_lib/compliance.js
//
// The gate every dial must pass. MULTI_AGENT_SPEC §1 principle 3 and WP-5:
// **fails CLOSED** — no verified-clean number, no dial. This module is the code
// form of docs/COMPLIANCE.md, and it is deliberately boring and refusable.
//
// Five checks, in order (first failure wins):
//   1. shape        — E.164 phone we can actually dial
//   2. consent      — a real, in-window basis to call (Meta form submit / CRM)
//   3. suppression  — our own do-not-call list (opt-outs propagate here)
//   4. DND scrub    — TRAI/DLT registry scrub via the configured provider
//   5. quiet hours  — outbound telemarketing only 09:00–21:00 IST
//
// Unconfigured == blocked. `COMPLIANCE_MODE=dev` is the ONLY way to dial
// without a scrub provider, it is loud about it, and it must never be set on a
// deployment that dials real numbers.

import { fetchJson } from './integrations/http.js';
import { normalizePhone } from './integrations/lead.js';
import * as store from './store.js';

const CONSENT_WINDOW_DAYS = Number(process.env.LEAD_CONSENT_WINDOW_DAYS || 90);

// Read at CALL time, not at import. These were module-level consts, which meant
// the legal calling window was frozen at process start: a test that set it got
// silently ignored, and the suite went green in isolation while asserting
// something untrue under other env. A value that decides whether dialling a
// stranger at 23:30 is lawful should not be the one value in this file that
// cannot be checked. isDevMode() already reads at call time; these now match.
const quietStartHour = () => Number(process.env.CALLING_WINDOW_START_IST || 9);   // 09:00 IST
const quietEndHour = () => Number(process.env.CALLING_WINDOW_END_IST || 21);      // 21:00 IST

/** dev mode = allowed to run without a scrub provider. Strict by default. */
export function isDevMode() {
  return String(process.env.COMPLIANCE_MODE || 'strict').toLowerCase() === 'dev';
}

export function complianceStatus() {
  return {
    mode: isDevMode() ? 'dev' : 'strict',
    dndScrub: Boolean(process.env.DND_SCRUB_URL && process.env.DND_SCRUB_API_KEY),
    // Either backend counts as a durable list: Firestore (preferred) or an
    // external HTTP register.
    suppressionList: store.storeBackend() === 'firestore' || Boolean(process.env.SUPPRESSION_LIST_URL),
    suppressionBackend: store.storeBackend() === 'firestore' ? 'firestore' : (process.env.SUPPRESSION_LIST_URL ? 'http' : 'none'),
    consentWindowDays: CONSENT_WINDOW_DAYS,
    callingWindowIST: `${quietStartHour()}:00-${quietEndHour()}:00`,
  };
}

// ---------------------------------------------------------------------------
// Suppression list (our own DNC). Durable when SUPPRESSION_LIST_URL is set.
// ---------------------------------------------------------------------------

// Best-effort per-instance cache. Serverless instances are ephemeral and NOT
// shared — this is a latency optimization, never the source of truth.
const memorySuppression = new Set();

/**
 * @returns {Promise<{suppressed:boolean, known:boolean, error:string|null}>}
 *   `known:false` means we could not establish the answer — callers must treat
 *   that as a block in strict mode.
 */
export async function isSuppressed(phone) {
  const e164 = normalizePhone(phone);
  if (!e164) return { suppressed: true, known: true, error: 'invalid_phone' };
  if (memorySuppression.has(e164)) return { suppressed: true, known: true, error: null };

  // Firestore is the primary register when configured. A point read by document
  // id — no query, no index, one round trip.
  if (store.storeBackend() === 'firestore') {
    const r = await store.isSuppressed(e164);
    if (r.suppressed) memorySuppression.add(e164);
    // A Firestore outage yields known:false, which the gate turns into a block.
    if (r.known) return { suppressed: r.suppressed, known: true, error: null };
    return { suppressed: false, known: false, error: r.error };
  }

  const url = process.env.SUPPRESSION_LIST_URL;
  if (!url) {
    // No durable list configured: we know nothing beyond this instance.
    return { suppressed: false, known: isDevMode(), error: 'suppression_list_not_configured' };
  }

  const res = await fetchJson(`${url}${url.includes('?') ? '&' : '?'}phone=${encodeURIComponent(e164)}`, {
    headers: authHeaders(process.env.SUPPRESSION_LIST_TOKEN),
    timeoutMs: 5000,
  });
  if (!res.ok) return { suppressed: false, known: false, error: res.error };

  const d = res.data || {};
  const suppressed = d.suppressed === true || d.optedOut === true || d.dnd === true;
  if (suppressed) memorySuppression.add(e164);
  return { suppressed, known: true, error: null };
}

/**
 * Add a number to the do-not-call list. Called the moment an opt-out is heard
 * mid-call (WP-5: opt-out propagates and blocks future dials).
 */
export async function addToSuppression(phone, reason = 'opt_out') {
  const e164 = normalizePhone(phone);
  if (!e164) return { ok: false, error: 'invalid_phone', durable: false };

  memorySuppression.add(e164);

  // Firestore first: the document id is the phone number, so this is idempotent
  // and a later lookup needs no query.
  if (store.storeBackend() === 'firestore') {
    const r = await store.suppress(e164, { reason });
    if (r.ok) return { ok: true, error: null, durable: true };
    // Fall through to the HTTP register rather than losing the opt-out.
  }

  const url = process.env.SUPPRESSION_LIST_URL;
  if (!url) {
    // Honest failure: the block only holds for this warm instance.
    return { ok: false, error: 'suppression_list_not_configured', durable: false };
  }

  const res = await fetchJson(url, {
    method: 'POST',
    headers: authHeaders(process.env.SUPPRESSION_LIST_TOKEN),
    body: { phone: e164, reason, at: new Date().toISOString(), source: 'anaga' },
    timeoutMs: 6000,
  });
  return { ok: res.ok, error: res.error, durable: res.ok };
}

// ---------------------------------------------------------------------------
// DND / DLT registry scrub
// ---------------------------------------------------------------------------

/**
 * Scrub against the TRAI/DLT DND registry through whatever provider is wired
 * (operator API, DLT aggregator, or your own service). Contract we expect:
 *   GET  {DND_SCRUB_URL}?phone=+91…   ->  200 { "dnd": true|false }
 *
 * Any error => `known:false` => blocked in strict mode. Never fail open.
 */
export async function scrubDnd(phone) {
  const url = process.env.DND_SCRUB_URL;
  const key = process.env.DND_SCRUB_API_KEY;
  if (!url || !key) {
    return { dnd: false, known: false, error: 'dnd_scrub_not_configured' };
  }

  const res = await fetchJson(`${url}${url.includes('?') ? '&' : '?'}phone=${encodeURIComponent(phone)}`, {
    headers: authHeaders(key),
    timeoutMs: 6000,
  });
  if (!res.ok) return { dnd: false, known: false, error: res.error };

  const d = res.data || {};
  const dnd = d.dnd === true || d.registered === true || d.blocked === true;
  return { dnd, known: true, error: null };
}

// ---------------------------------------------------------------------------
// Consent + calling window
// ---------------------------------------------------------------------------

function consentOk(consent) {
  if (!consent || consent.granted !== true) return { ok: false, reason: 'no_consent' };
  if (consent.basis === 'none') return { ok: false, reason: 'no_consent_basis' };
  if (!consent.at) return { ok: false, reason: 'consent_timestamp_missing' };

  const at = Date.parse(consent.at);
  if (!Number.isFinite(at)) return { ok: false, reason: 'consent_timestamp_invalid' };

  const ageDays = (Date.now() - at) / 86400000;
  if (ageDays > CONSENT_WINDOW_DAYS) return { ok: false, reason: 'consent_expired' };
  if (ageDays < -1) return { ok: false, reason: 'consent_in_future' };

  return { ok: true };
}

/** Current hour in IST (UTC+5:30), independent of the server's timezone. */
export function istHour(now = new Date()) {
  const ist = new Date(now.getTime() + (5 * 60 + 30) * 60000);
  return ist.getUTCHours();
}

export function withinCallingWindow(now = new Date()) {
  const h = istHour(now);
  return h >= quietStartHour() && h < quietEndHour();
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * Decide whether this lead may be dialed right now.
 *
 * @param {object} lead  normalized Lead (see integrations/lead.js)
 * @param {object} [opts] { ignoreWindow: boolean }  — for queueing ahead of the
 *        window; the caller must still re-check at dial time.
 * @returns {Promise<{allowed:boolean, reason:string|null, checks:object, warnings:string[]}>}
 */
export async function checkDialable(lead, opts = {}) {
  const warnings = [];
  const checks = {
    shape: false, consent: false, suppression: false, dnd: false, window: false,
  };

  // 1. shape
  const phone = normalizePhone(lead?.phone);
  if (!phone) return deny('invalid_phone', checks, warnings);
  checks.shape = true;

  // 2. consent
  const c = consentOk(lead?.consent);
  if (!c.ok) return deny(c.reason, checks, warnings);
  checks.consent = true;

  // 3. our suppression list
  const sup = await isSuppressed(phone);
  if (sup.suppressed) return deny('suppressed', checks, warnings);
  if (!sup.known) {
    if (!isDevMode()) return deny('suppression_unverified', checks, warnings);
    warnings.push(`suppression_unverified:${sup.error || 'unknown'}`);
  }
  checks.suppression = true;

  // 4. DND scrub — the fail-closed one
  const dnd = await scrubDnd(phone);
  if (dnd.dnd) return deny('dnd_registered', checks, warnings);
  if (!dnd.known) {
    if (!isDevMode()) return deny('dnd_unverified', checks, warnings);
    warnings.push(`dnd_unverified:${dnd.error || 'unknown'}`);
  }
  checks.dnd = true;

  // 5. calling window
  if (!withinCallingWindow()) {
    if (!opts.ignoreWindow) return deny('outside_calling_window', checks, warnings);
    warnings.push('queued_outside_calling_window');
  }
  checks.window = true;

  if (isDevMode() && warnings.length) {
    warnings.push('COMPLIANCE_MODE=dev — this dial would be BLOCKED in strict mode');
  }

  return { allowed: true, reason: null, checks, warnings };
}

function deny(reason, checks, warnings) {
  return { allowed: false, reason, checks, warnings };
}

function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}
