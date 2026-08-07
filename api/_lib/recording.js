// api/_lib/recording.js
//
// Call recording storage. `docs/COMPLIANCE.md` requires recordings held on
// Indian infrastructure with 90-day retention, and an immutable per-call audit
// trail referencing them. This is the last item LAUNCH.md listed as "not
// implemented".
//
// DEPENDENCY-FREE, like the rest of this repo: S3 REST with a hand-rolled
// SigV4 signature over node:crypto. No aws-sdk (a large tree and a cold-start
// cost on a serverless function that uploads a few hundred KB).
//
// S3-compatible on purpose. AWS `ap-south-1` (Mumbai) and `ap-south-2`
// (Hyderabad) work; so does any Indian S3-compatible provider via
// RECORDING_ENDPOINT.
//
// ── TWO RULES THAT FAIL CLOSED ────────────────────────────────────────────
//
// 1. REGION. If the configured region is not Indian, storage is REFUSED. Not
//    warned about — refused. A recording of an Indian consumer's phone call
//    sitting in us-east-1 is a data-residency breach that nobody discovers
//    until an audit, and "the bucket name looked right" is not a defence.
//    RECORDING_ALLOW_NON_INDIAN_REGION=1 exists as a deliberate, loud override
//    for a non-India deployment; it is reported as a blocker by /health.
//
// 2. NO PUBLIC URLS. We store an opaque REFERENCE, never a public link. A
//    recording URL that reaches a CRM note is a recording that reaches every
//    sales rep, every CRM integration, and every future export of that CRM.
//    Playback goes through GET /api/calls/recording, which requires the
//    operator key and mints a short-lived signed URL.

import crypto from 'node:crypto';

const INDIAN_REGIONS = new Set(['ap-south-1', 'ap-south-2']);
const DEFAULT_RETENTION_DAYS = 90;

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

export function recordingConfig() {
  const bucket = process.env.RECORDING_BUCKET || '';
  const region = (process.env.RECORDING_REGION || 'ap-south-1').toLowerCase();
  return {
    bucket,
    region,
    endpoint: process.env.RECORDING_ENDPOINT || `https://${bucket}.s3.${region}.amazonaws.com`,
    accessKeyId: process.env.RECORDING_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.RECORDING_SECRET_ACCESS_KEY || '',
    retentionDays: Number(process.env.RECORDING_RETENTION_DAYS || DEFAULT_RETENTION_DAYS),
    allowNonIndian: process.env.RECORDING_ALLOW_NON_INDIAN_REGION === '1',
  };
}

export function recordingConfigured() {
  const c = recordingConfig();
  return Boolean(c.bucket && c.accessKeyId && c.secretAccessKey);
}

/** Booleans only — safe to expose on /api/integrations/health. */
export function recordingStatus() {
  const c = recordingConfig();
  const configured = recordingConfigured();
  const indianRegion = INDIAN_REGIONS.has(c.region);
  return {
    configured,
    region: c.region,
    indianRegion,
    // Retention is enforced by the BUCKET's lifecycle rule, which lives in the
    // provider console, not here. Reporting our intent as if it were the
    // enforced policy is exactly the kind of claim that fails an audit.
    retentionDays: c.retentionDays,
    retentionEnforcedBy: 'bucket_lifecycle_policy',
    usable: configured && (indianRegion || c.allowNonIndian),
    overrideActive: !indianRegion && c.allowNonIndian,
  };
}

// ---------------------------------------------------------------------------
// SigV4
// ---------------------------------------------------------------------------

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

function amzDate(d = new Date()) {
  const iso = d.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { full: iso, short: iso.slice(0, 8) };
}

function signingKey(secret, short, region, service) {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, short), region), service), 'aws4_request');
}

/** RFC 3986 — S3 keys need encoding that leaves / alone but escapes ! * ' ( ). */
function encodeKey(key) {
  return String(key).split('/').map((seg) =>
    encodeURIComponent(seg).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()),
  ).join('/');
}

function hostOf(endpoint) {
  return new URL(endpoint).host;
}

/**
 * Sign a request with SigV4 using the Authorization header.
 * Returns { url, headers }.
 */
export function signRequest({ method, key, body, contentType, config, now = new Date() }) {
  const c = config || recordingConfig();
  const { full, short } = amzDate(now);
  const host = hostOf(c.endpoint);
  const path = '/' + encodeKey(key);
  const payloadHash = sha256(body === undefined || body === null ? '' : body);

  const headers = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': full,
  };
  if (contentType) headers['content-type'] = contentType;
  // Server-side encryption at rest. Not optional for a phone call.
  if (method === 'PUT') headers['x-amz-server-side-encryption'] = 'AES256';

  const signedHeaders = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaders.map((h) => `${h}:${String(headers[h]).trim()}\n`).join('');
  const signedHeaderList = signedHeaders.join(';');

  const canonicalRequest = [method, path, '', canonicalHeaders, signedHeaderList, payloadHash].join('\n');
  const scope = `${short}/${c.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', full, scope, sha256(canonicalRequest)].join('\n');
  const signature = crypto.createHmac('sha256', signingKey(c.secretAccessKey, short, c.region, 's3'))
    .update(stringToSign).digest('hex');

  headers.Authorization = `AWS4-HMAC-SHA256 Credential=${c.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaderList}, Signature=${signature}`;

  return { url: `${c.endpoint.replace(/\/+$/, '')}${path}`, headers };
}

/**
 * A presigned GET URL, valid for `ttlSec`. This is how a recording is played
 * back — short-lived, single-object, and minted only behind the operator key.
 */
export function presignGet(key, ttlSec = 300, config, now = new Date()) {
  const c = config || recordingConfig();
  const { full, short } = amzDate(now);
  const host = hostOf(c.endpoint);
  const path = '/' + encodeKey(key);
  const scope = `${short}/${c.region}/s3/aws4_request`;

  // Cap the lifetime. A "temporary" URL good for a week is a permanent one.
  const expires = Math.max(30, Math.min(Number(ttlSec) || 300, 3600));

  const params = new URLSearchParams({
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${c.accessKeyId}/${scope}`,
    'X-Amz-Date': full,
    'X-Amz-Expires': String(expires),
    'X-Amz-SignedHeaders': 'host',
  });
  // S3 requires the query string sorted by key for the canonical request.
  const canonicalQuery = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

  const canonicalRequest = ['GET', path, canonicalQuery, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', full, scope, sha256(canonicalRequest)].join('\n');
  const signature = crypto.createHmac('sha256', signingKey(c.secretAccessKey, short, c.region, 's3'))
    .update(stringToSign).digest('hex');

  return `${c.endpoint.replace(/\/+$/, '')}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

// ---------------------------------------------------------------------------
// object key
// ---------------------------------------------------------------------------

/**
 * Deterministic, non-identifying object key.
 *
 * The phone number is NOT in the key. An object key appears in bucket
 * listings, access logs, billing exports and CDN logs — putting the number
 * there would leak it into half a dozen systems that were never reviewed for
 * PII. Date-prefixed so a lifecycle rule can expire by prefix and so a human
 * can find a day's calls.
 */
export function recordingKey(callId, at = new Date()) {
  const id = String(callId || '').replace(/[^\w-]/g, '').slice(0, 64) || 'unknown';
  const day = at.toISOString().slice(0, 10);
  return `calls/${day}/${id}.wav`;
}

// ---------------------------------------------------------------------------
// operations
// ---------------------------------------------------------------------------

/**
 * Store a recording. Never throws — returns { ok, ref, error }.
 *
 * Failure here must not lose the call outcome: the opt-out, the suppression
 * write and the CRM note all matter more than the audio, and a storage outage
 * cannot be allowed to roll any of them back.
 */
export async function putRecording({ callId, audio, contentType = 'audio/wav', at = new Date() } = {}) {
  const status = recordingStatus();
  if (!status.configured) return { ok: false, ref: null, error: 'recording_not_configured' };
  if (!status.usable) {
    // The region gate. Refusing to store is the correct outcome — a recording
    // in the wrong jurisdiction is worse than no recording.
    return { ok: false, ref: null, error: `recording_region_not_indian:${recordingConfig().region}` };
  }
  if (!audio || !audio.length) return { ok: false, ref: null, error: 'recording_empty' };

  const key = recordingKey(callId, at);
  const config = recordingConfig();
  const body = Buffer.isBuffer(audio) ? audio : Buffer.from(audio);

  try {
    const { url, headers } = signRequest({ method: 'PUT', key, body, contentType, config, now: at });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Number(process.env.RECORDING_TIMEOUT_MS || 20000));
    let res;
    try {
      res = await fetch(url, { method: 'PUT', headers, body, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return { ok: false, ref: null, error: `recording_put_${res.status}` };

    return {
      ok: true,
      // An opaque reference, never a URL. See the header.
      ref: `s3://${config.bucket}/${key}`,
      bytes: body.length,
      expiresAt: new Date(at.getTime() + config.retentionDays * 86400_000).toISOString(),
    };
  } catch (err) {
    return { ok: false, ref: null, error: String(err?.name === 'AbortError' ? 'recording_timeout' : 'recording_error') };
  }
}

/** Parse `s3://bucket/key` back to its key, rejecting anything else. */
export function refToKey(ref) {
  const m = /^s3:\/\/([^/]+)\/(.+)$/.exec(String(ref || ''));
  if (!m) return null;
  const { bucket } = recordingConfig();
  // Refuse a reference for a different bucket — otherwise this endpoint would
  // presign arbitrary objects for anyone who can guess a bucket name.
  if (bucket && m[1] !== bucket) return null;
  return m[2];
}

/** Short-lived playback URL for a stored reference. */
export function playbackUrl(ref, ttlSec = 300) {
  const key = refToKey(ref);
  if (!key) return null;
  if (!recordingConfigured()) return null;
  return presignGet(key, ttlSec);
}

/**
 * Delete a recording — the DPDP Act erasure path.
 *
 * Note the tension, deliberately left visible: the recording of a call where
 * someone opted out is also the evidence that we honoured the opt-out. Deleting
 * it on request is the data subject's right; keeping the AUDIT EVENT (which
 * carries no audio) is how we can still prove compliance afterwards. So this
 * removes the audio and nothing else.
 */
export async function deleteRecording(ref) {
  const key = refToKey(ref);
  if (!key) return { ok: false, error: 'recording_bad_ref' };
  if (!recordingConfigured()) return { ok: false, error: 'recording_not_configured' };

  try {
    const { url, headers } = signRequest({ method: 'DELETE', key, body: '', config: recordingConfig() });
    const res = await fetch(url, { method: 'DELETE', headers });
    // S3 returns 204 for a delete, and also for an object that was never there.
    if (!res.ok && res.status !== 204 && res.status !== 404) {
      return { ok: false, error: `recording_delete_${res.status}` };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: 'recording_error' };
  }
}
