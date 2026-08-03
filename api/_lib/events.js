// api/_lib/events.js
//
// A small in-memory event log so the operator console has something true to
// show. Every stage of the pipeline records what it decided here.
//
// ⚠️ HONESTY BOUNDARY: this is a per-instance ring buffer. Serverless instances
// are ephemeral and not shared, so this is a LIVE VIEW, not history — it is
// emptied on cold start and a second concurrent instance keeps its own. The
// console labels it as such rather than implying a database exists.
//
// When DATABASE_URL lands (WP-6), `record()` is the single call site to swap:
// write through to Postgres, and `since()` reads from there instead. Nothing
// upstream changes.

import * as store from './store.js';

const MAX_EVENTS = 200;
const events = [];
const startedAt = new Date().toISOString();

/**
 * @param {string} type  lead.received | lead.blocked | call.queued | call.completed | lead.optout
 * @param {object} data  already-masked, non-PII-bearing fields only
 */
export function record(type, data = {}) {
  events.push({
    at: new Date().toISOString(),
    type,
    ...data,
  });
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);

  // Write through to the durable store. Deliberately NOT awaited: an event log
  // must never add latency to, or fail, a dial decision. Errors are swallowed
  // here because the in-memory copy above already succeeded — the console
  // reports store reachability separately so a silent write failure still shows.
  store.recordEvent(type, data).catch(() => {});
}

/** Durable history, newest first. Falls back to this instance's buffer. */
export async function history(limit = 200) {
  if (store.storeBackend() === 'firestore') {
    const r = await store.recentEvents(limit);
    if (r.ok) return { docs: r.docs, durable: true };
  }
  return { docs: list({ limit }), durable: false };
}

/** Newest first, optionally filtered by type. */
export function list({ limit = 50, type = null } = {}) {
  const out = type ? events.filter((e) => e.type === type) : events;
  return out.slice(-limit).reverse();
}

/**
 * Roll the log up into the counters the console's funnel needs.
 * Every number here is derived from the events above — nothing is invented.
 */
export function rollup() {
  const counts = {
    received: 0, blocked: 0, queued: 0, completed: 0,
    booked: 0, callback: 0, optOut: 0, notInterested: 0,
  };
  const blockReasons = {};
  const bySource = {};
  let scoreSum = 0;
  let scoreN = 0;

  for (const e of events) {
    if (e.type === 'lead.received') {
      counts.received++;
      bySource[e.source || 'unknown'] = (bySource[e.source || 'unknown'] || 0) + 1;
    } else if (e.type === 'lead.blocked') {
      counts.blocked++;
      blockReasons[e.reason || 'unknown'] = (blockReasons[e.reason || 'unknown'] || 0) + 1;
    } else if (e.type === 'call.queued') {
      counts.queued++;
    } else if (e.type === 'call.completed') {
      counts.completed++;
      if (Number.isFinite(e.score)) { scoreSum += e.score; scoreN++; }
      if (e.disposition === 'booked') counts.booked++;
      else if (e.disposition === 'callback') counts.callback++;
      else if (e.disposition === 'opt-out') counts.optOut++;
      else if (e.disposition === 'not-interested') counts.notInterested++;
    } else if (e.type === 'lead.optout') {
      counts.optOut++;
    }
  }

  return {
    counts,
    blockReasons,
    bySource,
    avgScore: scoreN ? Math.round(scoreSum / scoreN) : null,
    // Rates are only meaningful with a denominator — null, never a fake 0%.
    dialRate: counts.received ? Math.round((counts.queued / counts.received) * 100) : null,
    bookRate: counts.completed ? Math.round((counts.booked / counts.completed) * 100) : null,
  };
}

/** Provenance for the console's "this is a live view, not history" banner. */
export function meta() {
  return {
    durable: false,
    store: 'in_memory_ring_buffer',
    capacity: MAX_EVENTS,
    held: events.length,
    instanceStartedAt: startedAt,
  };
}
