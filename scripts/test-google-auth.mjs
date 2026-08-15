// scripts/test-google-auth.mjs
//
// Google sign-in, with a REAL RSA key pair standing in for Google's.
//
// The token verifier is the whole security boundary of "sign in with Google",
// and every one of its checks is a way in if it is missing. So the tests here
// forge tokens: right signature wrong audience, right audience wrong signature,
// alg:none, expired, unverified address, wrong issuer, swapped key id. Each one
// must be refused.
//
// The JWKS is served from a fake fetch. Nothing here reaches the network.
//
// Run: node --experimental-detect-module scripts/test-google-auth.mjs

import assert from 'node:assert';
import crypto from 'node:crypto';

// ── a stand-in for Google's signing key ────────────────────────────────────
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'test-key-1';
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' };

// A SECOND key pair. This is what proves the verifier actually checks the
// signature against the published key rather than merely parsing the token.
const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

const CLIENT_ID = '1234567890-abcdef.apps.googleusercontent.com';
const b64u = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');

function mint({
  aud = CLIENT_ID,
  iss = 'https://accounts.google.com',
  email = 'sumanthbolla97@gmail.com',
  email_verified = true,
  exp = Math.floor(Date.now() / 1000) + 3600,
  iat = Math.floor(Date.now() / 1000) - 5,
  alg = 'RS256',
  kid = KID,
  signWith = privateKey,
  name = 'Sumanth Bolla',
  sub = '1029384756',
  tamper = null,
} = {}) {
  const header = b64u({ alg, kid, typ: 'JWT' });
  const payload = b64u({ iss, aud, email, email_verified, exp, iat, name, sub });
  if (alg === 'none') return `${header}.${payload}.`;
  let sig = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), signWith).toString('base64url');
  if (tamper === 'sig') sig = sig.slice(0, -4) + 'AAAA';
  return `${header}.${payload}.${sig}`;
}

// ── fake the JWKS endpoint ─────────────────────────────────────────────────
let certsCalls = 0;
let certsHeaders = { 'cache-control': 'public, max-age=3600' };
let certsStatus = 200;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (String(url).includes('googleapis.com/oauth2/v3/certs')) {
    certsCalls++;
    return {
      ok: certsStatus === 200,
      status: certsStatus,
      headers: { get: (k) => certsHeaders[String(k).toLowerCase()] || null },
      json: async () => ({ keys: [jwk] }),
    };
  }
  return realFetch(url, opts);
};

process.env.GOOGLE_CLIENT_ID = CLIENT_ID;
process.env.ADMIN_EMAILS = 'sumanthbolla97@gmail.com:owner, ops@modcon.example:operator';
process.env.SESSION_SECRET = 'x'.repeat(48);

const { verifyGoogleIdToken, allowedRole, googleSignInConfigured, _resetKeyCache } =
  await import('../api/_lib/google-identity.js');

let pass = 0, fail = 0;
const failures = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ✓', name); }
  catch (e) { fail++; failures.push(`${name}: ${e.message}`); console.log('  ✗', name, '\n     ', e.message); }
}

console.log('\n═══ GOOGLE SIGN-IN ═══\n');

await t('a genuine token is accepted, and the identity comes back', async () => {
  const id = await verifyGoogleIdToken(mint());
  assert.ok(id, 'a correctly signed token must verify');
  assert.equal(id.email, 'sumanthbolla97@gmail.com');
  assert.equal(id.name, 'Sumanth Bolla');
  assert.equal(id.emailVerified, true);
});

await t('THE AUDIENCE CHECK — a valid Google token for ANOTHER app is refused', async () => {
  // The check people skip. This token is perfectly signed by Google and
  // completely valid; it was just issued to somebody else's client id. Without
  // this, anyone who can register a Google OAuth client can sign in here as
  // whoever they like.
  const other_ = mint({ aud: '999-someoneelse.apps.googleusercontent.com' });
  assert.equal(await verifyGoogleIdToken(other_), null);
});

await t('an audience ARRAY still has to contain our client id', async () => {
  assert.ok(await verifyGoogleIdToken(mint({ aud: ['other', CLIENT_ID] })), 'ours is present → fine');
  assert.equal(await verifyGoogleIdToken(mint({ aud: ['a', 'b'] })), null, 'ours is absent → refused');
});

await t('NO CLIENT ID CONFIGURED IS A REFUSAL, not a skipped check', async () => {
  // `aud === undefined` would compare false, but an implementation that
  // "skips the check when unconfigured" accepts every token on earth. This
  // must fail closed.
  const saved = process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_ID;
  assert.equal(googleSignInConfigured(), false);
  assert.equal(await verifyGoogleIdToken(mint()), null);
  process.env.GOOGLE_CLIENT_ID = saved;
});

await t('a token signed with the WRONG KEY is refused', async () => {
  assert.equal(await verifyGoogleIdToken(mint({ signWith: other.privateKey })), null);
});

await t('a tampered signature is refused', async () => {
  assert.equal(await verifyGoogleIdToken(mint({ tamper: 'sig' })), null);
});

await t('alg:none is refused — the classic JWT hole', async () => {
  assert.equal(await verifyGoogleIdToken(mint({ alg: 'none' })), null);
});

await t('an unknown key id is refused rather than matched to any key', async () => {
  assert.equal(await verifyGoogleIdToken(mint({ kid: 'not-a-real-kid' })), null);
});

await t('an expired token is refused', async () => {
  assert.equal(await verifyGoogleIdToken(mint({ exp: Math.floor(Date.now() / 1000) - 600 })), null);
});

await t('a token from the future is refused', async () => {
  assert.equal(await verifyGoogleIdToken(mint({ iat: Math.floor(Date.now() / 1000) + 600 })), null);
});

await t('a wrong issuer is refused', async () => {
  assert.equal(await verifyGoogleIdToken(mint({ iss: 'https://evil.example' })), null);
});

await t('AN UNVERIFIED ADDRESS IS REFUSED — it could be anyone else\'s', async () => {
  assert.equal(await verifyGoogleIdToken(mint({ email_verified: false })), null);
});

await t('malformed input never throws, it just fails', async () => {
  for (const bad of [null, undefined, 42, '', 'a.b', 'a.b.c.d', '....', {}, 'not a jwt at all']) {
    assert.equal(await verifyGoogleIdToken(bad), null, `${JSON.stringify(bad)} must be refused quietly`);
  }
});

await t('the signing keys are fetched once and cached', async () => {
  _resetKeyCache();
  certsCalls = 0;
  await verifyGoogleIdToken(mint());
  await verifyGoogleIdToken(mint());
  await verifyGoogleIdToken(mint());
  assert.equal(certsCalls, 1, 'three sign-ins must not be three round trips to Google');
});

await t('the cache honours Google\'s own max-age, so key rotation is not fatal', async () => {
  _resetKeyCache();
  certsHeaders = { 'cache-control': 'public, max-age=1' };
  certsCalls = 0;
  await verifyGoogleIdToken(mint());
  // Ask again as if two seconds had passed.
  await verifyGoogleIdToken(mint(), { now: Date.now() + 2000 });
  assert.equal(certsCalls, 2, 'past max-age the keys must be re-fetched');
  certsHeaders = { 'cache-control': 'public, max-age=3600' };
});

await t('Google being unreachable fails closed', async () => {
  _resetKeyCache();
  certsStatus = 500;
  assert.equal(await verifyGoogleIdToken(mint()), null);
  certsStatus = 200;
  _resetKeyCache();
});

console.log('\n─── the allowlist ───\n');

await t('the founder is an owner', () => {
  assert.equal(allowedRole('sumanthbolla97@gmail.com'), 'owner');
});

await t('the allowlist is case- and space-insensitive', () => {
  assert.equal(allowedRole('  SumanthBolla97@Gmail.com '), 'owner');
  assert.equal(allowedRole('ops@modcon.example'), 'operator', 'entries after a comma-space still parse');
});

await t('AN UNLISTED GOOGLE ACCOUNT GETS NOTHING', () => {
  // The important property. Anybody on earth can produce a valid Google token
  // for their own address; the allowlist is what stops that being an account.
  assert.equal(allowedRole('stranger@gmail.com'), null);
  assert.equal(allowedRole(''), null);
  assert.equal(allowedRole(null), null);
});

await t('an entry with no role defaults to operator, never owner', () => {
  const saved = process.env.ADMIN_EMAILS;
  process.env.ADMIN_EMAILS = 'someone@modcon.example';
  assert.equal(allowedRole('someone@modcon.example'), 'operator');
  process.env.ADMIN_EMAILS = 'someone@modcon.example:superadmin';
  assert.equal(allowedRole('someone@modcon.example'), 'operator', 'an unknown role is not honoured');
  process.env.ADMIN_EMAILS = saved;
});

await t('no allowlist configured means nobody gets in', () => {
  const saved = process.env.ADMIN_EMAILS;
  delete process.env.ADMIN_EMAILS;
  assert.equal(allowedRole('sumanthbolla97@gmail.com'), null);
  process.env.ADMIN_EMAILS = saved;
});

await t('a partial match is not a match', () => {
  // "97@gmail.com" must not match "sumanthbolla97@gmail.com", and neither must
  // an address that merely contains an allowlisted one.
  assert.equal(allowedRole('97@gmail.com'), null);
  assert.equal(allowedRole('xsumanthbolla97@gmail.com'), null);
  assert.equal(allowedRole('sumanthbolla97@gmail.com.evil.example'), null);
});

console.log('\n─── the route ───\n');

const { default: googleRoute } = await import('../api/_lib/routes/auth-google.js');

function call(handler, { method = 'POST', body = null, headers = {} } = {}) {
  return new Promise((resolve) => {
    const req = {
      method, headers: { 'content-type': 'application/json', ...headers },
      url: '/api/auth/google', query: {},
      body: body === null ? undefined : JSON.stringify(body),
      on(ev, fn) { if (ev === 'data' && this.body) fn(Buffer.from(this.body)); if (ev === 'end') fn(); },
    };
    const out = { status: 0, headers: {}, json: null };
    const res = {
      status(c) { out.status = c; return res; },
      json(j) { out.json = j; resolve(out); return res; },
      setHeader(k, v) { out.headers[k.toLowerCase()] = v; },
      end() { resolve(out); },
    };
    handler(req, res);
  });
}

await t('with no durable store the route refuses rather than half-working', async () => {
  // A session is stateless but the ROLE is re-read from the user record on
  // every request. Succeeding into an in-memory map means the very next
  // request 401s, which is worse than an honest 503.
  const r = await call(googleRoute, { body: { credential: mint() } });
  assert.equal(r.status, 503);
  assert.equal(r.json.error, 'store_not_configured');
});

await t('GET is refused', async () => {
  const r = await call(googleRoute, { method: 'GET' });
  assert.ok(r.status === 405 || r.status === 404, `expected a method refusal, got ${r.status}`);
});

await t('with no GOOGLE_CLIENT_ID the route says so instead of letting anyone in', async () => {
  const saved = process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_ID;
  const r = await call(googleRoute, { body: { credential: mint() } });
  assert.equal(r.status, 503);
  assert.equal(r.json.error, 'google_not_configured');
  process.env.GOOGLE_CLIENT_ID = saved;
});

await t('the dispatcher knows the route, and still refuses an unknown action', async () => {
  const { default: authDispatch } = await import('../api/auth.js');
  const r = await call(authDispatch, { method: 'GET', headers: {} });
  // /api/auth/google with GET reaches the google handler (a method refusal),
  // never a default route — but an unknown action must 404.
  const unknown = await new Promise((resolve) => {
    const req = { method: 'POST', headers: {}, url: '/api/auth/nonsense', query: {}, on(e, f) { if (e === 'end') f(); } };
    const res = { status(c) { this._c = c; return this; }, json(j) { resolve({ status: this._c, json: j }); return this; }, setHeader() {} };
    authDispatch(req, res);
  });
  assert.equal(unknown.status, 404);
  assert.ok(unknown.json.actions.includes('google'), 'google must be a registered action');
  void r;
});

globalThis.fetch = realFetch;

console.log(`\n═══ ${pass} passed, ${fail} failed ═══\n`);
if (fail) { failures.forEach((f) => console.log('  FAIL ' + f)); process.exit(1); }
