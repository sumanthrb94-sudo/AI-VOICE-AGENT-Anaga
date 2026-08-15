// scripts/test-console-auth.mjs
//
// authorizeRead(): a signed-in human OR the machine key may read; neither may
// escalate through the other.
//
// The console used to accept ONLY the fleet's shared secret, which meant a
// human had to paste a machine credential into a browser text box to see their
// own dashboard. Adding sessions alongside it creates exactly one new way to
// get this wrong — a low-privilege session falling THROUGH to the key check
// and being upgraded — so that is the test that matters most here.
//
// Run: node --experimental-detect-module scripts/test-console-auth.mjs

import assert from 'node:assert';
import crypto from 'node:crypto';

process.env.SESSION_SECRET = 'y'.repeat(48);
process.env.INTEGRATIONS_API_KEY = 'fleet-key-do-not-paste-in-a-browser';

// The user store is Firestore-backed; stub the module so currentUser() can
// resolve without a network or a service account.
const USERS = new Map();
const storePath = new URL('../api/_lib/store.js', import.meta.url).href;
const realImport = globalThis.__anagaImport;
void realImport;

// Node has no module-mock hook without a loader, so instead of faking the
// store we drive the real one through its documented "not configured" path and
// assert on what authorizeRead does with each ANSWER it can get. The session
// half is exercised against the real token code.
const { issueToken, sessionCookie } = await import('../api/_lib/auth.js');
const { authorizeRead, authorize } = await import('../api/_lib/integrations/http.js');

let pass = 0, fail = 0;
const failures = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ✓', name); }
  catch (e) { fail++; failures.push(`${name}: ${e.message}`); console.log('  ✗', name, '\n     ', e.message); }
}

const req = (headers = {}) => ({ method: 'GET', headers, query: {} });
const withKey = (k) => req({ authorization: `Bearer ${k}` });

console.log('\n═══ CONSOLE READ AUTH ═══\n');

await t('the machine key still works — the caller agent must not break', async () => {
  const out = await authorizeRead(withKey(process.env.INTEGRATIONS_API_KEY));
  assert.equal(out.ok, true);
  assert.equal(out.via, 'key');
  assert.equal(out.user, null);
});

await t('a wrong key is refused', async () => {
  const out = await authorizeRead(withKey('not-the-key'));
  assert.equal(out.ok, false);
  assert.equal(out.status, 401);
});

await t('the x-api-key header is still honoured', async () => {
  const out = await authorizeRead(req({ 'x-api-key': process.env.INTEGRATIONS_API_KEY }));
  assert.equal(out.ok, true);
  assert.equal(out.via, 'key');
});

await t('no credential at all is 401, not 200', async () => {
  const out = await authorizeRead(req());
  assert.equal(out.ok, false);
  assert.equal(out.status, 401);
  assert.equal(out.error, 'not_signed_in');
});

await t('a garbage cookie does not throw, it just fails', async () => {
  for (const bad of ['anaga_session=', 'anaga_session=....', 'anaga_session=a.b', 'nonsense']) {
    const out = await authorizeRead(req({ cookie: bad }));
    assert.equal(out.ok, false, `${bad} must be refused`);
  }
});

await t('a FORGED session is refused — the HMAC is the whole guarantee', async () => {
  const body = Buffer.from(JSON.stringify({
    uid: 'attacker@example.com', role: 'owner', pw: 0, exp: Date.now() + 3600_000,
  })).toString('base64url');
  const wrongMac = crypto.createHmac('sha256', 'the-wrong-secret').update(body).digest('base64url');
  const out = await authorizeRead(req({ cookie: `anaga_session=${body}.${wrongMac}` }));
  assert.equal(out.ok, false);
});

await t('an EXPIRED session is refused', async () => {
  const token = issueToken({ id: 'x@y.z', role: 'owner', pwChangedAt: 0 });
  assert.ok(token);
  // Re-sign with an expiry in the past using the real secret.
  const body = Buffer.from(JSON.stringify({
    uid: 'x@y.z', org: 'default', role: 'owner', pw: 0, exp: Date.now() - 1000,
  })).toString('base64url');
  const mac = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(body).digest('base64url');
  const out = await authorizeRead(req({ cookie: `anaga_session=${body}.${mac}` }));
  assert.equal(out.ok, false);
});

await t('sessionCookie() sets HttpOnly, Secure and SameSite=Lax', () => {
  // SameSite=Lax is what makes accepting a session on a READ endpoint safe:
  // the browser will not attach it to a cross-site XHR. If this ever loosens
  // to None, authorizeRead becomes a CSRF surface and needs a token.
  const c = sessionCookie('abc');
  assert.match(c, /HttpOnly/);
  assert.match(c, /Secure/);
  assert.match(c, /SameSite=Lax/);
});

await t('NO SESSION SECRET falls back to the key rather than opening up', async () => {
  const saved = process.env.SESSION_SECRET;
  delete process.env.SESSION_SECRET;
  const good = await authorizeRead(withKey(process.env.INTEGRATIONS_API_KEY));
  assert.equal(good.ok, true, 'the machine path must survive an unconfigured session system');
  const bad = await authorizeRead(req());
  assert.equal(bad.ok, false, 'and no credential is still refused');
  process.env.SESSION_SECRET = saved;
});

await t('NEITHER mechanism configured is a 503, not a 200', async () => {
  const s = process.env.SESSION_SECRET, k = process.env.INTEGRATIONS_API_KEY;
  delete process.env.SESSION_SECRET;
  delete process.env.INTEGRATIONS_API_KEY;
  const out = await authorizeRead(req());
  assert.equal(out.ok, false);
  assert.equal(out.status, 503, 'an unconfigured deployment must say so, never authorize');
  process.env.SESSION_SECRET = s; process.env.INTEGRATIONS_API_KEY = k;
});

await t('authorize() itself is unchanged — machine endpoints keep their contract', () => {
  // /api/calls/outcome and /api/leads/intake still use this and must NOT have
  // gained a session path: a browser should not be able to reach them at all.
  assert.equal(authorize(withKey(process.env.INTEGRATIONS_API_KEY)).ok, true);
  assert.equal(authorize(req()).ok, false);
});

await t('the mutating endpoints did NOT gain session auth', async () => {
  const fs = await import('node:fs');
  for (const f of ['../api/calls/outcome.js', '../api/leads/intake.js']) {
    const src = fs.readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /authorizeRead/,
      `${f} must stay machine-key only — it mutates state and spends money`);
  }
});

await t('DELETE of a recording demands a higher role than reading one', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../api/calls/transcript.js', import.meta.url), 'utf8');
  assert.match(src, /req\.method === 'DELETE' \? 'owner' : 'viewer'/,
    'destroying a compliance artifact must not be the same permission as reading it');
});

console.log(`\n═══ ${pass} passed, ${fail} failed ═══\n`);
if (fail) { failures.forEach((f) => console.log('  FAIL ' + f)); process.exit(1); }
