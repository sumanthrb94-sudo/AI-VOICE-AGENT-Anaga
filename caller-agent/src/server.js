// caller-agent/src/server.js
//
// The dial queue consumer (WP-2's hand-off point). This is the service the
// `DIAL_QUEUE_URL` in the Vaak API points at — the piece that closes the gap
// between "a lead passed the compliance gate" and "a phone rings".
//
//   POST /jobs     signed dial job  -> accepted, call runs, outcome reported
//   GET  /health   readiness, including whether this instance can dial for real
//
// Two things it does before every dial, which the API cannot do for it:
//
//   1. VERIFIES THE JOB SIGNATURE. This endpoint causes phone calls. An
//      unsigned job is rejected, full stop.
//   2. RE-CHECKS THE CALLING WINDOW. Jobs may be queued ahead of the 9pm-9am
//      cutoff (`ignoreWindow`), so the queue's authorization is necessary but
//      not sufficient — the legal question is what time it is when the phone
//      actually rings. shared/integrations-contract.md requires this of any
//      consumer.
//
// Concurrency is bounded: a queue burst must not open 500 simultaneous calls.

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runCall } from './session.js';
import { createBrain } from './brain.js';
import { createTelephony, telephonyProvider, assertRealProvider } from './providers/telephony/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PERSONA_PATH = process.env.AGENT_PERSONA_PATH
  || path.join(HERE, '..', 'flows', 'anaga.persona.json');

const PORT = Number(process.env.PORT || 8080);
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_CALLS || 25);
const MAX_BODY_BYTES = 256 * 1024;

// ---------------------------------------------------------------------------
// structured logging — one JSON object per line, never a secret or raw phone
// ---------------------------------------------------------------------------
export function log(event, fields = {}) {
  const safe = { ...fields };
  if (typeof safe.phone === 'string') safe.phone = maskPhone(safe.phone);
  process.stdout.write(JSON.stringify({
    at: new Date().toISOString(), svc: 'caller-agent', event, ...safe,
  }) + '\n');
}

export function maskPhone(p) {
  const s = String(p || '');
  if (s.length < 7) return '***';
  return `${s.slice(0, 5)}${'X'.repeat(Math.max(0, s.length - 7))}${s.slice(-2)}`;
}

// ---------------------------------------------------------------------------
// calling window — the same 09:00-21:00 IST rule the API enforces
// ---------------------------------------------------------------------------
export function withinCallingWindow(now = new Date()) {
  const ist = new Date(now.getTime() + (5 * 60 + 30) * 60000);
  const h = ist.getUTCHours();
  return h >= Number(process.env.CALLING_WINDOW_START_IST || 9)
      && h < Number(process.env.CALLING_WINDOW_END_IST || 21);
}

// ---------------------------------------------------------------------------
// job signature — HMAC-SHA256 over the raw body with DIAL_QUEUE_SECRET
// ---------------------------------------------------------------------------
export function verifyJobSignature(rawBody, header) {
  const secret = process.env.DIAL_QUEUE_SECRET;
  if (!secret) return { ok: false, error: 'dial_queue_secret_not_configured' };

  const got = String(header || '');
  if (!got.startsWith('sha256=')) return { ok: false, error: 'missing_signature' };

  const expected = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  const a = Buffer.from(got.slice(7), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, error: 'bad_signature' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// job validation
// ---------------------------------------------------------------------------
export function validateJob(job) {
  if (!job || typeof job !== 'object') return { ok: false, error: 'invalid_job' };
  if (job.type !== 'outbound_call') return { ok: false, error: 'unsupported_job_type' };
  if (!job.lead || !/^\+\d{8,15}$/.test(String(job.lead.phone || ''))) {
    return { ok: false, error: 'invalid_phone' };
  }
  // The API must have authorized this dial. A job without a gate verdict is a
  // job that skipped the gate — refuse it rather than trust the caller.
  if (job.compliance?.allowed !== true) return { ok: false, error: 'no_compliance_authorization' };
  return { ok: true };
}

export function loadPersona(p = PERSONA_PATH) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    log('persona_load_failed', { path: p });
    return null;
  }
}

// ---------------------------------------------------------------------------
// the worker
// ---------------------------------------------------------------------------
let inFlight = 0;

/**
 * Execute one validated, authorized job. Exported so tests drive the real path
 * instead of a parallel copy of it.
 */
export async function handleJob(job, { telephonyFactory = createTelephony, brainFactory = createBrain } = {}) {
  const persona = loadPersona();
  const telephony = telephonyFactory(job._mock || {});
  const brain = brainFactory({ log });

  inFlight++;
  try {
    log('call_started', {
      callId: job.callId || null,
      phone: job.lead.phone,
      source: job.lead.source,
      provider: telephonyProvider(),
    });
    return await runCall({ job, telephony, brain, persona, log });
  } finally {
    inFlight--;
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(new Error('body_too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    if (req.method === 'GET' && req.url.startsWith('/health')) {
      const real = assertRealProvider();
      return send(200, {
        ok: true,
        provider: telephonyProvider(),
        canDialForReal: real.ok,
        blockers: real.errors,
        inFlight,
        maxConcurrent: MAX_CONCURRENT,
        withinCallingWindow: withinCallingWindow(),
        personaLoaded: Boolean(loadPersona()),
      });
    }

    if (req.method !== 'POST' || !req.url.startsWith('/jobs')) {
      return send(404, { error: 'not_found' });
    }

    if (inFlight >= MAX_CONCURRENT) {
      res.setHeader('Retry-After', '5');
      return send(429, { error: 'at_capacity', inFlight, maxConcurrent: MAX_CONCURRENT });
    }

    let raw;
    try {
      raw = await readBody(req);
    } catch {
      return send(413, { error: 'body_too_large' });
    }

    // 1. signature — this endpoint causes phone calls
    const sig = verifyJobSignature(raw, req.headers['x-vaak-signature-256']);
    if (!sig.ok) {
      log('job_rejected', { reason: sig.error });
      return send(403, { error: sig.error });
    }

    let job;
    try { job = JSON.parse(raw); } catch { return send(400, { error: 'invalid_json' }); }

    // 2. shape + gate authorization
    const valid = validateJob(job);
    if (!valid.ok) {
      log('job_rejected', { reason: valid.error });
      return send(400, { error: valid.error });
    }

    // 3. calling window, re-checked AT DIAL TIME
    if (!withinCallingWindow()) {
      log('job_deferred', { reason: 'outside_calling_window', phone: job.lead.phone });
      res.setHeader('Retry-After', '3600');
      return send(425, { error: 'outside_calling_window', retryAfterSec: 3600 });
    }

    // Accept, then run. The queue gets a fast ack; the call outcome goes to
    // /api/calls/outcome, not to this response.
    const callId = job.callId || `call_${Date.now().toString(36)}`;
    send(202, { accepted: true, callId });

    handleJob({ ...job, callId }).catch((err) => {
      log('job_failed', { callId, error: String(err && err.message) });
    });
  });
}

// Start only when run directly, so tests can import without binding a port.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const real = assertRealProvider();
  log('starting', {
    port: PORT,
    provider: telephonyProvider(),
    canDialForReal: real.ok,
    blockers: real.errors,
  });
  if (!real.ok && process.env.NODE_ENV === 'production') {
    // Refuse to masquerade as a production dialer.
    log('refusing_to_start', { reason: 'not_dial_capable_in_production', blockers: real.errors });
    process.exit(1);
  }
  createServer().listen(PORT, () => log('listening', { port: PORT }));
}
