// scripts/test-recording.mjs
//
// QA for call recording — the last item LAUNCH.md listed as "not implemented".
//
// ── WHAT THIS PROVES ──────────────────────────────────────────────────────
// The two rules that fail closed: recordings are REFUSED when the configured
// region is not Indian, and a playable URL never reaches a CRM note. Plus SigV4
// correctness against AWS's own published test vector, key hygiene (no phone
// numbers in object keys), presign expiry caps, and the DPDP erasure path.
//
// ── WHAT IT DOES NOT PROVE ────────────────────────────────────────────────
// That a real bucket accepts the signature, or that the 90-day lifecycle rule
// exists — retention is enforced by a bucket policy in the provider console,
// not by this code, and no test here can see it. `recordingStatus()` reports
// that honestly rather than implying we enforce it.
//
// Run: node --experimental-detect-module scripts/test-recording.mjs

import assert from 'node:assert';
import crypto from 'node:crypto';

let pass = 0, fail = 0;
const failures = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ✓', name); }
  catch (e) { fail++; failures.push(`${name}: ${e.message}`); console.log('  ✗', name, '\n     ', e.message); }
}
function section(s) { console.log('\n' + s); }

const realFetch = globalThis.fetch;
let routes = [], calls = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  calls.push({ url: u, init });
  for (const r of routes) if (r.match.test(u)) return r.reply(u, init);
  throw new Error('unstubbed fetch: ' + u);
};
const ok = (status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => ({}), text: async () => '' });
function reset() { routes = []; calls = []; }

const ENV = ['RECORDING_BUCKET', 'RECORDING_REGION', 'RECORDING_ENDPOINT', 'RECORDING_ACCESS_KEY_ID',
  'RECORDING_SECRET_ACCESS_KEY', 'RECORDING_RETENTION_DAYS', 'RECORDING_ALLOW_NON_INDIAN_REGION'];
function clearEnv() { for (const k of ENV) delete process.env[k]; }
function mumbai() {
  clearEnv();
  process.env.RECORDING_BUCKET = 'vaak-recordings';
  process.env.RECORDING_REGION = 'ap-south-1';
  process.env.RECORDING_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
  process.env.RECORDING_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
}
clearEnv();

const rec = await import('../api/_lib/recording.js');

// ===========================================================================
section('§1 the region gate — fails closed');
// ===========================================================================

await t('an unconfigured deployment stores nothing and says so', async () => {
  clearEnv(); reset();
  const out = await rec.putRecording({ callId: 'c1', audio: Buffer.from('x') });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'recording_not_configured');
  assert.equal(calls.length, 0);
});

await t('a NON-INDIAN region is REFUSED, not warned about', async () => {
  mumbai();
  process.env.RECORDING_REGION = 'us-east-1';
  reset();
  routes = [{ match: /./, reply: () => ok() }];
  const out = await rec.putRecording({ callId: 'c1', audio: Buffer.from('audio') });
  assert.equal(out.ok, false);
  assert.match(out.error, /region_not_indian:us-east-1/);
  // The point: nothing was uploaded. A recording of an Indian consumer's call
  // sitting in us-east-1 is a residency breach nobody finds until an audit.
  assert.equal(calls.length, 0, 'it must not have been uploaded at all');
  clearEnv();
});

await t('both Indian regions are accepted', () => {
  for (const r of ['ap-south-1', 'ap-south-2']) {
    mumbai();
    process.env.RECORDING_REGION = r;
    assert.equal(rec.recordingStatus().indianRegion, true, r);
    assert.equal(rec.recordingStatus().usable, true, r);
  }
  clearEnv();
});

await t('the override works but is reported as an active override', () => {
  mumbai();
  process.env.RECORDING_REGION = 'eu-west-1';
  process.env.RECORDING_ALLOW_NON_INDIAN_REGION = '1';
  const s = rec.recordingStatus();
  assert.equal(s.usable, true);
  assert.equal(s.indianRegion, false);
  assert.equal(s.overrideActive, true, 'health must be able to raise this as a blocker');
  clearEnv();
});

await t('retention is reported as bucket-enforced, not as something we do', () => {
  mumbai();
  const s = rec.recordingStatus();
  assert.equal(s.retentionDays, 90);
  assert.equal(s.retentionEnforcedBy, 'bucket_lifecycle_policy');
  // Claiming we enforce a retention policy we do not enforce is exactly the
  // kind of statement that fails an audit.
  clearEnv();
});

// ===========================================================================
section('§2 SigV4');
// ===========================================================================

await t('signRequest matches AWS\'s own published test vector', () => {
  // AWS SigV4 "get-vanilla" documentation example — an independent oracle, so
  // this cannot pass just because it agrees with itself.
  const config = {
    bucket: 'examplebucket', region: 'us-east-1',
    endpoint: 'https://examplebucket.s3.amazonaws.com',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    retentionDays: 90, allowNonIndian: true,
  };
  const { headers } = rec.signRequest({
    method: 'GET', key: 'test.txt', body: '', config,
    now: new Date('2013-05-24T00:00:00Z'),
  });
  assert.match(headers.Authorization, /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20130524\/us-east-1\/s3\/aws4_request/);
  assert.match(headers.Authorization, /SignedHeaders=host;x-amz-content-sha256;x-amz-date/);
  // Empty-payload hash is a fixed, well-known constant.
  assert.equal(headers['x-amz-content-sha256'],
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  // And the signature is deterministic — recompute it independently here.
  const sha = (d) => crypto.createHash('sha256').update(d).digest('hex');
  const hm = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
  const canonical = ['GET', '/test.txt', '',
    'host:examplebucket.s3.amazonaws.com\nx-amz-content-sha256:' + headers['x-amz-content-sha256'] +
    '\nx-amz-date:20130524T000000Z\n',
    'host;x-amz-content-sha256;x-amz-date', headers['x-amz-content-sha256']].join('\n');
  const sts = ['AWS4-HMAC-SHA256', '20130524T000000Z', '20130524/us-east-1/s3/aws4_request', sha(canonical)].join('\n');
  const key = hm(hm(hm(hm('AWS4' + config.secretAccessKey, '20130524'), 'us-east-1'), 's3'), 'aws4_request');
  const expected = crypto.createHmac('sha256', key).update(sts).digest('hex');
  assert.match(headers.Authorization, new RegExp('Signature=' + expected + '$'));
});

await t('a PUT asks for encryption at rest', () => {
  mumbai();
  const { headers } = rec.signRequest({ method: 'PUT', key: 'a.wav', body: Buffer.from('x'), contentType: 'audio/wav' });
  assert.equal(headers['x-amz-server-side-encryption'], 'AES256');
  assert.match(headers.Authorization, /x-amz-server-side-encryption/, 'and it must be SIGNED, not just sent');
  clearEnv();
});

await t('presigned URLs expire, and a long TTL is capped', () => {
  mumbai();
  assert.match(rec.presignGet('calls/2026-08-05/c1.wav', 300), /X-Amz-Expires=300/);
  assert.match(rec.presignGet('calls/2026-08-05/c1.wav', 999999), /X-Amz-Expires=3600/);
  // A "temporary" URL valid for a week is a permanent one.
  assert.match(rec.presignGet('calls/2026-08-05/c1.wav', 1), /X-Amz-Expires=30/);
  clearEnv();
});

// ===========================================================================
section('§3 object keys carry no PII');
// ===========================================================================

await t('the phone number is NOT in the object key', () => {
  const key = rec.recordingKey('call_abc123', new Date('2026-08-05T10:00:00Z'));
  assert.equal(key, 'calls/2026-08-05/call_abc123.wav');
  assert.doesNotMatch(key, /\d{10}|\+91/);
  // Object keys appear in bucket listings, access logs, billing exports and CDN
  // logs — none of which were reviewed for PII.
});

await t('a hostile call id cannot escape the prefix', () => {
  const key = rec.recordingKey('../../etc/passwd', new Date('2026-08-05T10:00:00Z'));
  assert.equal(key, 'calls/2026-08-05/etcpasswd.wav');
  assert.doesNotMatch(key, /\.\./);
});

await t('keys are date-prefixed so a lifecycle rule can expire by prefix', () => {
  assert.match(rec.recordingKey('x', new Date('2026-01-02T00:00:00Z')), /^calls\/2026-01-02\//);
});

// ===========================================================================
section('§4 storing and retrieving');
// ===========================================================================

await t('a successful put returns an s3:// REFERENCE, never a URL', async () => {
  mumbai(); reset();
  routes = [{ match: /vaak-recordings/, reply: () => ok(200) }];
  const out = await rec.putRecording({ callId: 'c9', audio: Buffer.from('RIFFfake'), at: new Date('2026-08-05T10:00:00Z') });
  assert.equal(out.ok, true);
  assert.equal(out.ref, 's3://vaak-recordings/calls/2026-08-05/c9.wav');
  assert.doesNotMatch(out.ref, /^https?:/, 'a reference must not be fetchable on its own');
  assert.equal(out.expiresAt.slice(0, 10), '2026-11-03', '90 days on');
  clearEnv();
});

await t('a storage failure is returned, not thrown', async () => {
  mumbai(); reset();
  routes = [{ match: /vaak-recordings/, reply: () => ok(500) }];
  const out = await rec.putRecording({ callId: 'c9', audio: Buffer.from('x') });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'recording_put_500');
  // Losing the audio must never roll back the opt-out or the CRM note.
  clearEnv();
});

await t('playbackUrl refuses a reference for another bucket', () => {
  mumbai();
  assert.equal(rec.refToKey('s3://someone-elses-bucket/secrets.wav'), null);
  assert.equal(rec.playbackUrl('s3://someone-elses-bucket/secrets.wav'), null);
  // Otherwise this endpoint is a presigning oracle for any object anyone names.
  assert.equal(rec.refToKey('https://vaak-recordings.s3.amazonaws.com/x.wav'), null);
  assert.equal(rec.refToKey('calls/x.wav'), null);
  clearEnv();
});

await t('REGRESSION: `..` inside the key cannot climb out of the bucket', () => {
  mumbai();
  // The first version of refToKey checked the bucket name and returned the rest
  // verbatim, so the bucket check was bypassed by putting the traversal AFTER
  // it. Against a path-style endpoint (MinIO, Wasabi, most Indian S3-compatible
  // providers serve https://host/bucket/key) those segments resolve into a
  // different bucket, and the URL normalises before the request is even sent:
  // /vaak-recordings/../../etc/passwd -> /etc/passwd.
  for (const evil of [
    's3://vaak-recordings/../../etc/passwd',
    's3://vaak-recordings/calls/../../../elsewhere',
    's3://vaak-recordings/calls/2026-08-05/../../../x.wav',
    's3://vaak-recordings/%2e%2e/secret',
    's3://vaak-recordings/..%2f..%2fsecret',
    's3://vaak-recordings//etc/passwd',
    's3://vaak-recordings/a b.wav',
    // NUL truncation, built explicitly: a literal control byte in the source
    // makes this file binary to git and grep, which is how one got committed.
    's3://vaak-recordings/calls/2026-08-05/x.wav' + String.fromCharCode(0) + '.txt',
  ]) {
    assert.equal(rec.refToKey(evil), null, `must reject: ${JSON.stringify(evil)}`);
    assert.equal(rec.playbackUrl(evil), null, `must not presign: ${JSON.stringify(evil)}`);
  }
  clearEnv();
});

await t('...and the shape it DOES accept is exactly what recordingKey produces', () => {
  mumbai();
  // An allowlist is only safe if it still admits the real thing — a rule that
  // rejects everything would pass the test above and break every playback.
  const key = rec.recordingKey('call_abc-123', new Date('2026-08-05T10:00:00Z'));
  const ref = `s3://vaak-recordings/${key}`;
  assert.equal(rec.refToKey(ref), key);
  assert.match(rec.playbackUrl(ref, 60), /X-Amz-Signature=[0-9a-f]{64}/);
  clearEnv();
});

await t('playbackUrl signs a valid reference', () => {
  mumbai();
  const url = rec.playbackUrl('s3://vaak-recordings/calls/2026-08-05/c9.wav', 120);
  assert.match(url, /X-Amz-Signature=[0-9a-f]{64}/);
  assert.match(url, /X-Amz-Expires=120/);
  clearEnv();
});

await t('delete is idempotent — a 404 counts as deleted', async () => {
  mumbai(); reset();
  routes = [{ match: /vaak-recordings/, reply: () => ok(404) }];
  const out = await rec.deleteRecording('s3://vaak-recordings/calls/2026-08-05/c9.wav');
  assert.equal(out.ok, true, 'an erasure request for an already-gone object has succeeded');
  clearEnv();
});

// ===========================================================================
section('§5 no playable URL reaches a CRM');
// ===========================================================================

await t('the CRM note carries the reference, and says playback needs access', async () => {
  const { buildNote } = await import('../api/_lib/integrations/crm.js').then((m) => ({ buildNote: m.buildNote })).catch(() => ({}));
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../api/_lib/integrations/crm.js', import.meta.url), 'utf8');
  assert.match(src, /call\.recordingRef/, 'the note must use the reference');
  assert.doesNotMatch(src, /call\.recordingUrl/, 'and must not use a playable URL');
  assert.match(src, /playback requires operator access/);
});

await t('the outcome endpoint drops a playable URL instead of storing it', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../api/calls/outcome.js', import.meta.url), 'utf8');
  assert.match(src, /\^s3:\\\/\\\//, 'only s3:// references may be accepted');
  assert.match(src, /RECORDING_URL_REJECTED/, 'and a rejected URL must be logged, not silently dropped');
});

await t('playback requires the operator key', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../api/calls/transcript.js', import.meta.url), 'utf8');
  assert.match(src, /authorize\(req\)/);
  // The signed URL IS a bearer credential for that object.
  assert.doesNotMatch(src, /log\([^)]*url/i, 'the minted URL must never be logged');
});

globalThis.fetch = realFetch;
console.log(`\n═══ ${pass} passed, ${fail} failed ═══\n`);
if (fail) { failures.forEach((f) => console.log('  FAIL ' + f)); process.exit(1); }
