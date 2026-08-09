// api/_lib/store.js
//
// The durable layer. Backed by Firestore when configured, degrading to the
// previous in-memory behaviour when it is not — so nothing breaks in tests or
// on a bare deploy, and everything gets stronger the moment credentials exist.
//
// Three concerns, three collections:
//
//   suppression/{e164}   the do-not-call list. THE one that must be durable.
//   leads/{source:id}    lead records + atomic dedupe
//   events/{auto}        pipeline event log the operator console reads
//   calls/{callId}       finished calls, for history
//
// ── WHY THESE QUERY SHAPES ────────────────────────────────────────────────
// Firestore needs a composite index for `where` + `orderBy` on different
// fields, and an un-created index is a hard 400 at runtime, not a slow query.
// Every read here is therefore either a document get by id, or an orderBy on a
// single field, with any filtering done in memory over a bounded page. That
// ships today with zero index administration. If event volume outgrows it, add
// the composite index and push the filter down — the call sites do not change.
//
// ── FAIL BEHAVIOUR ────────────────────────────────────────────────────────
// `isSuppressed` returns `known:false` when Firestore cannot be reached, and
// the compliance gate turns unknown into a block. A datastore outage must never
// read as permission to call someone who opted out.

import {
  firestoreConfigured, getDoc, setDoc, addDoc, createDocIfAbsent, query, ping, projectId,
} from './firestore.js';

/**
 * Every store call goes through this. A malformed key, an expired token, a
 * suspended project or a network partition must all become a RETURN VALUE, not
 * an exception: `isSuppressed` throwing meant the compliance gate crashed
 * instead of deciding, taking the whole request with it. Blocked-by-decision
 * and blocked-by-crash are not the same thing — only the first is auditable.
 */
async function safely(fn, onFailure) {
  try {
    return await fn();
  } catch (err) {
    return { ...onFailure, error: String((err && err.message) || 'store_error') };
  }
}

const COL = {
  suppression: process.env.FIRESTORE_COL_SUPPRESSION || 'suppression',
  leads: process.env.FIRESTORE_COL_LEADS || 'leads',
  events: process.env.FIRESTORE_COL_EVENTS || 'events',
  calls: process.env.FIRESTORE_COL_CALLS || 'calls',
};

/** Firestore document ids may not contain '/'. E.164 never does, but be safe. */
function docId(s) {
  return String(s).replace(/\//g, '_');
}

export function storeBackend() {
  return firestoreConfigured() ? 'firestore' : 'memory';
}

export async function storeStatus() {
  if (!firestoreConfigured()) {
    return { backend: 'memory', durable: false, projectId: null, reachable: false };
  }
  const p = await safely(() => ping(), { ok: false });
  return {
    backend: 'firestore',
    durable: p.ok,
    projectId: projectId(),
    reachable: p.ok,
    error: p.ok ? null : p.error,
  };
}

// ---------------------------------------------------------------------------
// suppression list — the do-not-call register
// ---------------------------------------------------------------------------

/**
 * @returns {Promise<{suppressed:boolean, known:boolean, error:string|null, at:string|null}>}
 *   `known:false` means we could not establish the answer. Callers MUST treat
 *   that as a block in strict mode.
 */
export async function isSuppressed(e164) {
  if (!firestoreConfigured()) return { suppressed: false, known: false, error: 'store_not_configured', at: null };

  return safely(async () => {
    const res = await getDoc(COL.suppression, docId(e164));
    if (!res.ok) return { suppressed: false, known: false, error: res.error, at: null };
    if (!res.found) return { suppressed: false, known: true, error: null, at: null };
    return { suppressed: true, known: true, error: null, at: res.data?.at || null };
  }, { suppressed: false, known: false, at: null });
}

/**
 * Add a number to the do-not-call list. The document id IS the phone number, so
 * this is idempotent: re-suppressing the same number overwrites rather than
 * duplicating, and a lookup is a single point read with no query or index.
 */
export async function suppress(e164, { reason = 'opt_out', source = 'anaga', callId = null } = {}) {
  if (!firestoreConfigured()) return { ok: false, durable: false, error: 'store_not_configured' };

  return safely(async () => {
    const res = await setDoc(COL.suppression, docId(e164), {
      phone: e164, reason, source, callId, at: new Date().toISOString(),
    });
    return { ok: res.ok, durable: res.ok, error: res.error || null };
  }, { ok: false, durable: false });
}

/** Recent suppressions for the console. orderBy on one field — no index needed. */
export async function recentSuppressions(limit = 25) {
  if (!firestoreConfigured()) return { ok: true, docs: [] };
  return safely(() => query(COL.suppression, { orderBy: 'at', desc: true, limit }), { ok: false, docs: [] });
}

// ---------------------------------------------------------------------------
// leads — record + ATOMIC dedupe
// ---------------------------------------------------------------------------

/**
 * Claim a lead id. Returns `created:false` when someone already claimed it.
 *
 * This is a genuine improvement over the previous per-instance Map: Firestore
 * rejects a duplicate create with 409, so two serverless instances racing on
 * the same Meta retry cannot both win. That was a real double-dial risk.
 */
export async function claimLead(lead) {
  const id = docId(lead.id || `${lead.source}:${lead.phone}`);
  if (!firestoreConfigured()) return { ok: true, created: true, id, durable: false };

  return safely(async () => {
  const res = await createDocIfAbsent(COL.leads, id, {
    source: lead.source,
    sourceId: lead.sourceId,
    name: lead.name || null,
    phone: lead.phone,
    city: lead.city || null,
    known: lead.known || {},
    campaign: lead.campaign || {},
    consentBasis: lead.consent?.basis || 'none',
    consentAt: lead.consent?.at || null,
    receivedAt: lead.receivedAt || new Date().toISOString(),
  });
  return { ok: res.ok, created: res.created, id, durable: true, error: res.error || null };
  }, { ok: false, created: true, id, durable: false });   // on failure, let the local guard decide
}

export async function getLead(id) {
  if (!firestoreConfigured()) return { ok: true, found: false, data: null };
  return safely(() => getDoc(COL.leads, docId(id)), { ok: false, found: false, data: null });
}

// ---------------------------------------------------------------------------
// events — what the operator console reads
// ---------------------------------------------------------------------------

/** Append one pipeline event. Fire-and-forget: never block a dial on logging. */
export async function recordEvent(type, data = {}) {
  if (!firestoreConfigured()) return { ok: false, durable: false };
  return safely(async () => {
    const res = await addDoc(COL.events, { type, at: new Date().toISOString(), ...data });
    return { ok: res.ok, durable: res.ok, id: res.id };
  }, { ok: false, durable: false });
}

/** Newest-first page of events. Single-field orderBy — no composite index. */
export async function recentEvents(limit = 200) {
  if (!firestoreConfigured()) return { ok: true, docs: [] };
  return safely(() => query(COL.events, { orderBy: 'at', desc: true, limit }), { ok: false, docs: [] });
}

// ---------------------------------------------------------------------------
// calls — finished call records
// ---------------------------------------------------------------------------

export async function recordCall(callId, data) {
  if (!firestoreConfigured()) return { ok: false, durable: false, error: 'firestore_not_configured' };
  return safely(async () => {
    const res = await setDoc(COL.calls, docId(callId || `call_${Date.now()}`), {
      ...data, at: new Date().toISOString(),
    });
    return { ok: res.ok, durable: res.ok, error: res.error || null };
  }, { ok: false, durable: false });
}

/** One finished call, transcript and all. */
export async function getCall(callId) {
  if (!firestoreConfigured()) return { ok: true, found: false, data: null };
  if (!callId) return { ok: true, found: false, data: null };
  return safely(() => getDoc(COL.calls, docId(callId)), { ok: false, found: false, data: null });
}

export async function recentCalls(limit = 50) {
  if (!firestoreConfigured()) return { ok: true, docs: [] };
  return safely(() => query(COL.calls, { orderBy: 'at', desc: true, limit }), { ok: false, docs: [] });
}
