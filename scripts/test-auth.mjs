// scripts/test-auth.mjs
//
// QA for human authentication.
//
// This is the one subsystem where a bug is a breach rather than a defect, so
// the tests are written as attacks: forge a session, tamper with one, reuse one
// after a password change, bootstrap twice, enumerate accounts by timing.
//
// The real store and the real crypto run against a Firestore double, because
// the thing most likely to be wrong is the boundary between them.
//
// Run: node --experimental-detect-module scripts/test-auth.mjs

import assert from 'node:assert';
import crypto from 'node:crypto';

const ROOT = new URL('../', import.meta.url).pathname.replace(/\/$/, '');

process.env.SESSION_SECRET = 'test-session-secret-that-is-long-enough-0123456789';
process.env.BOOTSTRAP_TOKEN = 'bootstrap-token-for-tests-0123456789';
process.env.RATE_LIMIT_LOGIN = '1000';
process.env.RATE_LIMIT_BOOTSTRAP = '1000';

// --- Firestore double -------------------------------------------------------
const db = new Map();
const realFetch = globalThis.fetch;
{
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({
    type: 'service_account', project_id: 'vaak-test',
    client_email: 't@vaak-test.iam.gserviceaccount.com', private_key: privateKey,
  });
}
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const json = (s, d) => new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
  if (u.includes('oauth2') || u.includes('/token')) return json(200, { access_token: 't', expires_in: 3600 });
  if (u.includes('firestore.googleapis.com')) {
    const after = u.split('/documents/')[1] || '';
    const path = decodeURIComponent(after.split('?')[0]);
    // runQuery is itself a POST, so it MUST be matched before the create
    // branch below — otherwise a listing silently becomes a write and every
    // "does any user exist?" check answers no. (Cost me the one test that
    // actually guards the bootstrap window.)
    if (u.includes(':runQuery')) {
      const col = JSON.parse(opts.body || '{}')?.structuredQuery?.from?.[0]?.collectionId || '';
      const docs = [...db.entries()].filter(([k]) => k.startsWith(col + '/'));
      return json(200, docs.map(([k, fields]) => ({ document: { name: k, fields } })));
    }
    if (opts.method === 'PATCH') { db.set(path, JSON.parse(opts.body).fields); return json(200, {}); }
    if (opts.method === 'POST') {
      const m = /documentId=([^&]+)/.exec(u);
      const id = m ? decodeURIComponent(m[1]) : `auto_${db.size}`;
      const key = `${path}/${id}`;
      if (db.has(key)) return json(409, { error: 'exists' });
      db.set(key, JSON.parse(opts.body).fields);
      return json(200, { name: key });
    }
    const fields = db.get(path);
    return fields ? json(200, { name: path, fields }) : json(404, {});
  }
  return realFetch(url, opts);
};

const auth = await import(`${ROOT}/api/_lib/auth.js`);
const bootstrapH = (await import(`${ROOT}/api/auth/bootstrap.js`)).default;
const loginH = (await import(`${ROOT}/api/auth/login.js`)).default;
const meH = (await import(`${ROOT}/api/auth/me.js`)).default;
const logoutH = (await import(`${ROOT}/api/auth/logout.js`)).default;

let pass = 0, fail = 0;
const failures = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ✓', name); }
  catch (e) { fail++; failures.push(`${name}: ${e.message}`); console.log('  ✗', name, '\n     ', e.message); }
}
function section(s) { console.log(`\n${s}`); }

function mkRes() {
  const r = { statusCode: 200, body: null, headers: {} };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.send = r.json;
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  return r;
}
const call = async (h, req) => { const res = mkRes(); await h(req, res); return res; };
const cookieOf = (res) => String(res.headers['set-cookie'] || '').split(';')[0].split('=').slice(1).join('=');

const EMAIL = 'founder@vaak.ai';
const PASSWORD = 'a-long-enough-passphrase-9';

console.log('\n═══ AUTH QA ═══');

section('bootstrap — the one-request window');

await t('the wrong token is refused', async () => {
  const res = await call(bootstrapH, { method: 'POST', headers: {}, query: {}, body: JSON.stringify({ email: EMAIL, password: PASSWORD, token: 'nope' }) });
  assert.equal(res.statusCode, 401);
  assert.equal(db.size, 0, 'nothing may be written on a bad token');
});

await t('a weak password is refused before an account exists', async () => {
  const res = await call(bootstrapH, { method: 'POST', headers: {}, query: {}, body: JSON.stringify({ email: EMAIL, password: 'short', token: process.env.BOOTSTRAP_TOKEN }) });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'weak_password');
});

await t('the first owner is created and signed in', async () => {
  const res = await call(bootstrapH, { method: 'POST', headers: {}, query: {}, body: JSON.stringify({ email: EMAIL, password: PASSWORD, name: 'Founder', token: process.env.BOOTSTRAP_TOKEN }) });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.user.role, 'owner');
  assert.ok(cookieOf(res), 'a session cookie should be set');
});

await t('THE WINDOW CLOSES: bootstrap refuses once any account exists', async () => {
  const res = await call(bootstrapH, { method: 'POST', headers: {}, query: {}, body: JSON.stringify({ email: 'attacker@evil.com', password: 'another-long-passphrase-1', token: process.env.BOOTSTRAP_TOKEN }) });
  assert.equal(res.statusCode, 409, 'a second owner must never be mintable');
});

await t('the password is never stored in the clear', () => {
  const dump = JSON.stringify([...db.entries()]);
  assert.ok(!dump.includes(PASSWORD), 'the password reached the datastore');
  assert.ok(/pbkdf2\$sha256\$21\d{4}\$/.test(dump), 'expected a PBKDF2 record');
});

section('sign in');

await t('the right password signs in', async () => {
  const res = await call(loginH, { method: 'POST', headers: {}, query: {}, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.user.role, 'owner');
});

await t('the wrong password does not', async () => {
  const res = await call(loginH, { method: 'POST', headers: {}, query: {}, body: JSON.stringify({ email: EMAIL, password: PASSWORD + 'x' }) });
  assert.equal(res.statusCode, 401);
  assert.equal(res.headers['set-cookie'], undefined, 'no cookie on a failed login');
});

await t('an unknown account is indistinguishable from a wrong password', async () => {
  const a = await call(loginH, { method: 'POST', headers: {}, query: {}, body: JSON.stringify({ email: 'nobody@vaak.ai', password: PASSWORD }) });
  const b = await call(loginH, { method: 'POST', headers: {}, query: {}, body: JSON.stringify({ email: EMAIL, password: 'wrong-but-long-enough' }) });
  assert.equal(a.statusCode, b.statusCode);
  assert.deepEqual(a.body, b.body, 'the two must not be tellable apart');
});

await t('the email is case- and space-insensitive', async () => {
  const res = await call(loginH, { method: 'POST', headers: {}, query: {}, body: JSON.stringify({ email: '  FOUNDER@Vaak.AI ', password: PASSWORD }) });
  assert.equal(res.statusCode, 200);
});

section('sessions — treated as hostile input');

let goodCookie;
await t('a valid session identifies the user', async () => {
  const res = await call(loginH, { method: 'POST', headers: {}, query: {}, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
  goodCookie = cookieOf(res);
  const me = await call(meH, { method: 'GET', headers: { cookie: `vaak_session=${goodCookie}` }, query: {} });
  assert.equal(me.body.user.email, EMAIL);
  assert.equal(me.body.user.role, 'owner');
});

await t('the cookie is httpOnly, Secure and SameSite', async () => {
  const res = await call(loginH, { method: 'POST', headers: {}, query: {}, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
  const c = String(res.headers['set-cookie']);
  assert.ok(/HttpOnly/i.test(c), 'an XSS must not be able to read the session');
  assert.ok(/Secure/i.test(c));
  assert.ok(/SameSite=Lax/i.test(c), 'CSRF protection for every mutating route');
});

await t('A FORGED session is rejected', async () => {
  const payload = Buffer.from(JSON.stringify({ uid: EMAIL, org: 'default', role: 'owner', pw: 0, exp: Date.now() + 9e6 })).toString('base64url');
  const forged = `${payload}.${Buffer.from('whatever').toString('base64url')}`;
  const me = await call(meH, { method: 'GET', headers: { cookie: `vaak_session=${forged}` }, query: {} });
  assert.equal(me.body.user, null, 'an unsigned token must never authenticate');
});

await t('a TAMPERED session is rejected (role escalation)', async () => {
  const [body, mac] = goodCookie.split('.');
  const decoded = JSON.parse(Buffer.from(body, 'base64url').toString());
  decoded.role = 'owner';
  decoded.uid = 'attacker@evil.com';
  const tampered = `${Buffer.from(JSON.stringify(decoded)).toString('base64url')}.${mac}`;
  const me = await call(meH, { method: 'GET', headers: { cookie: `vaak_session=${tampered}` }, query: {} });
  assert.equal(me.body.user, null, 'editing the payload must invalidate the signature');
});

await t('an EXPIRED session is rejected', () => {
  const expired = auth.readToken(auth.issueToken({ id: EMAIL, role: 'owner', orgId: 'default' }));
  assert.ok(expired, 'sanity: a fresh token reads back');
  // Mint one that is already past its expiry by signing the same way.
  const secret = process.env.SESSION_SECRET;
  const body = Buffer.from(JSON.stringify({ uid: EMAIL, role: 'owner', exp: Date.now() - 1000 })).toString('base64url');
  const mac = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  assert.equal(auth.readToken(`${body}.${mac}`), null, 'a correctly-signed but expired token must still fail');
});

await t('a session issued before a password change stops working', async () => {
  const { updateUser } = await import(`${ROOT}/api/_lib/store.js`);
  await updateUser(EMAIL, { pwChangedAt: Date.now() + 1000 });
  const me = await call(meH, { method: 'GET', headers: { cookie: `vaak_session=${goodCookie}` }, query: {} });
  assert.equal(me.body.user, null, 'changing a password must retire existing sessions');
  await updateUser(EMAIL, { pwChangedAt: 0 });
});

await t('a disabled account is locked out immediately, not at expiry', async () => {
  const { updateUser } = await import(`${ROOT}/api/_lib/store.js`);
  const res = await call(loginH, { method: 'POST', headers: {}, query: {}, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
  const c = cookieOf(res);
  await updateUser(EMAIL, { disabled: true });
  const me = await call(meH, { method: 'GET', headers: { cookie: `vaak_session=${c}` }, query: {} });
  assert.equal(me.body.user, null);
  const relogin = await call(loginH, { method: 'POST', headers: {}, query: {}, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
  assert.equal(relogin.statusCode, 401, 'a disabled account must not be able to sign back in');
  await updateUser(EMAIL, { disabled: false });
});

await t('no session reads as anonymous, not as an error', async () => {
  const me = await call(meH, { method: 'GET', headers: {}, query: {} });
  assert.equal(me.statusCode, 200, 'a first-time visitor is not an error');
  assert.equal(me.body.user, null);
});

await t('logout clears the cookie', async () => {
  const res = await call(logoutH, { method: 'POST', headers: {}, query: {} });
  assert.ok(/Max-Age=0/.test(String(res.headers['set-cookie'])));
});

section('roles');

await t('roles are ranked, not equal', () => {
  const owner = { role: 'owner' }, op = { role: 'operator' }, viewer = { role: 'viewer' };
  assert.equal(auth.hasRole(owner, 'operator'), true, 'an owner can do operator work');
  assert.equal(auth.hasRole(op, 'owner'), false, 'an operator is not an owner');
  assert.equal(auth.hasRole(viewer, 'operator'), false);
  assert.equal(auth.hasRole(null, 'viewer'), false, 'nobody is not a viewer');
});

section('failing closed');

await t('a short SESSION_SECRET disables auth rather than signing weakly', async () => {
  const real = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'tooshort';
  assert.equal(auth.authConfigured(), false);
  assert.equal(auth.issueToken({ id: 'x' }), null, 'a guessable secret must not mint sessions');
  const res = await call(loginH, { method: 'POST', headers: {}, query: {}, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
  assert.equal(res.statusCode, 503);
  process.env.SESSION_SECRET = real;
});

await t('a password record from another algorithm is refused, not accepted', () => {
  assert.equal(auth.verifyPassword('x', 'plaintext'), false);
  assert.equal(auth.verifyPassword('x', 'md5$abc$def'), false);
  assert.equal(auth.verifyPassword('x', ''), false);
  assert.equal(auth.verifyPassword('x', null), false);
  // Iteration count must not be talked down to something brute-forceable.
  assert.equal(auth.verifyPassword('x', 'pbkdf2$sha256$1$aa$bb'), false);
});

await t('the same password hashes differently every time (salted)', () => {
  assert.notEqual(auth.hashPassword('same-passphrase-here'), auth.hashPassword('same-passphrase-here'));
});

globalThis.fetch = realFetch;
console.log(`\n═══ ${pass} passed, ${fail} failed ═══\n`);
if (fail) { failures.forEach((f) => console.log('  FAIL ' + f)); process.exit(1); }
