// scripts/test-firestore-verify.mjs
//
// Exercises the deployment-time Firestore verification probe against a stateful
// REST double. The probe must prove write + read + cleanup, and its endpoint
// must remain authenticated because it writes a Firestore row.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const ROOT = new URL('../', import.meta.url).pathname.replace(/\/$/, '');
const originalFetch = globalThis.fetch;
const originalCredential = process.env.FIREBASE_SERVICE_ACCOUNT;
const originalIntegrationKey = process.env.INTEGRATIONS_API_KEY;

let pass = 0;
async function test(name, fn) {
  await fn();
  pass++;
  console.log('  ✓', name);
}

console.log('\n═══ FIRESTORE PERSISTENCE VERIFIER QA ═══\n');

const { privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({
  type: 'service_account',
  project_id: 'vaak-persistence-verify-test',
  client_email: 'verify@vaak-persistence-verify-test.iam.gserviceaccount.com',
  private_key: privateKey,
});
process.env.INTEGRATIONS_API_KEY = 'firestore-verify-test-key-00000000';

const documents = new Map();
const response = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('oauth2.googleapis.com/token')) return response(200, { access_token: 'verify-token', expires_in: 3600 });
  const marker = '/documents/';
  const at = u.indexOf(marker);
  if (at < 0) return response(404, { error: 'unknown_url' });
  const path = decodeURIComponent(u.slice(at + marker.length).split('?')[0]);
  const method = opts.method || 'GET';
  if (method === 'PATCH') {
    documents.set(path, JSON.parse(opts.body).fields);
    return response(200, { name: `projects/verify/databases/(default)/documents/${path}` });
  }
  if (method === 'GET') {
    const fields = documents.get(path);
    return fields ? response(200, { name: `projects/verify/databases/(default)/documents/${path}`, fields }) : response(404, {});
  }
  if (method === 'DELETE') {
    documents.delete(path);
    return response(200, {});
  }
  return response(405, { error: 'unsupported_method' });
};

const store = await import(`${ROOT}/api/_lib/store.js?verify=${Date.now()}`);
const endpoint = (await import(`${ROOT}/api/integrations/firestore-verify.js?verify=${Date.now()}`)).default;

function mkRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  res.setHeader = () => {};
  return res;
}

await test('the store probe writes, reads, and removes its ephemeral document', async () => {
  const result = await store.verifyStorePersistence();
  assert.equal(result.backend, 'firestore');
  assert.equal(result.verified, true);
  assert.equal(result.cleaned, true);
  assert.equal(documents.size, 0, 'the verifier must leave no event document behind');
});

await test('the authenticated endpoint reports a verified durable store', async () => {
  const res = mkRes();
  await endpoint({
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.INTEGRATIONS_API_KEY}` },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.store.verified, true);
  assert.equal(res.body.store.cleaned, true);
  assert.equal(documents.size, 0);
});

await test('the endpoint rejects a caller without the integration key', async () => {
  const res = mkRes();
  await endpoint({ method: 'POST', headers: {} }, res);
  assert.ok(res.statusCode === 401 || res.statusCode === 403, `expected auth rejection, got ${res.statusCode}`);
  assert.equal(res.body.ok, undefined);
  assert.equal(documents.size, 0, 'an unauthorized request must not write a probe');
});

globalThis.fetch = originalFetch;
if (originalCredential === undefined) delete process.env.FIREBASE_SERVICE_ACCOUNT;
else process.env.FIREBASE_SERVICE_ACCOUNT = originalCredential;
if (originalIntegrationKey === undefined) delete process.env.INTEGRATIONS_API_KEY;
else process.env.INTEGRATIONS_API_KEY = originalIntegrationKey;

console.log(`\n═══ ${pass} passed, 0 failed ═══\n`);
