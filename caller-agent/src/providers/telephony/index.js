// caller-agent/src/providers/telephony/index.js
//
// Telephony provider abstraction (WP-4). Every adapter implements:
//
//   dial({ to, from, callId })  -> { answered, reason }
//   say(text)                   -> boolean (false when the call is gone)
//   listen()                    -> { text, hangup, silent }
//   hangup(reason)              -> { ended }
//
// Business logic (src/session.js) is written against that interface and never
// imports a vendor. Swapping Plivo for Exotel is a config change.
//
// TELEPHONY_PROVIDER: mock | plivo | exotel
//   `mock` is the default so the pipeline is runnable and testable with no
//   credentials. It must NEVER be the provider on a deployment that dials real
//   numbers — assertRealProvider() below is what production startup calls.

import { createMockTelephony } from './mock.js';
import { createPlivoTelephony } from './plivo.js';
import { createExotelTelephony } from './exotel.js';

export function telephonyProvider() {
  return String(process.env.TELEPHONY_PROVIDER || 'mock').toLowerCase();
}

export function createTelephony(opts = {}) {
  switch (telephonyProvider()) {
    case 'plivo': return createPlivoTelephony(opts);
    case 'exotel': return createExotelTelephony(opts);
    case 'mock': return createMockTelephony(opts);
    default:
      throw new Error(`unsupported TELEPHONY_PROVIDER: ${telephonyProvider()}`);
  }
}

/**
 * Startup guard. A deployment that can dial real numbers must not be running
 * the mock, and a real provider must have a 160-series caller ID configured.
 * @returns {{ok:boolean, errors:string[]}}
 */
export function assertRealProvider() {
  const errors = [];
  const p = telephonyProvider();

  if (p === 'mock') {
    errors.push('TELEPHONY_PROVIDER=mock — no real call can be placed');
  }
  if (p === 'plivo' && !(process.env.PLIVO_AUTH_ID && process.env.PLIVO_AUTH_TOKEN)) {
    errors.push('PLIVO_AUTH_ID / PLIVO_AUTH_TOKEN missing');
  }
  if (p === 'exotel' && !(process.env.EXOTEL_SID && process.env.EXOTEL_TOKEN)) {
    errors.push('EXOTEL_SID / EXOTEL_TOKEN missing');
  }
  if (!process.env.OUTBOUND_CALLER_ID) {
    errors.push('OUTBOUND_CALLER_ID missing (must be a 160-series number)');
  }
  return { ok: errors.length === 0, errors };
}
