// scripts/test-e2e-demo.mjs
//
// Two real people using the product at the same time, against the real
// handlers: an ADMIN who owns the console, and DEMO users who do not.
//
// ── WHY THIS SUITE ────────────────────────────────────────────────────────
// A stack of new machinery went in quickly — the `demo` role, the per-user
// call record, the transcript panel, the socket ticket — and every one of them
// turns on the same question: WHO IS ASKING. The failure mode is not a crash.
// It is one demo user opening another's transcript, or a demo session reaching
// the console, and neither shows up as an error anywhere.
//
// So the personas run CONCURRENTLY. Scoping bugs love a single-user test: a
// filter that ignores identity passes every time there is only one identity to
// confuse it with.
//
// Run: node --experimental-detect-module scripts/test-e2e-demo.mjs

import assert from 'node:assert';

process.env.SESSION_SECRET = 'z'.repeat(48);
process.env.AGENT_TOKEN_SECRET = 'an-agent-secret-of-sufficient-length';
process.env.ADMIN_EMAILS = 'boss@modcon.example:owner';
process.env.DEMO_SIGNIN = 'open';
process.env.TTS_CACHE = '0';

const { issueToken, sessionCookie, hasRole } = await import('../api/_lib/auth.js');
const { allowedRole } = await import('../api/_lib/google-identity.js');
const { mintAgentToken, verifyAgentToken } = await import('../shared/agent-token.js');
const demoRoute = (await import('../api/_lib/routes/calls-demo.js')).default;
const { storeBackend, createUser } = await import('../api/_lib/store.js');

// ── WHAT CANNOT BE FAKED HERE, AND WHY THAT IS SAID OUT LOUD ──────────────
// currentUser() resolves the ROLE from the user store, not from the session
// token — which is the right design (a forged token cannot invent a role) and
// means the handler-level personas need a real store. CI has no Firestore
// credentials, deliberately: a CI job that can reach the datastore is a CI job
// that can dial someone.
//
// So those sections SKIP, loudly, rather than passing without running. A suite
// that reports green on assertions it never made is worse than one that admits
// what it could not check. Set FIREBASE_SERVICE_ACCOUNT to run them.
const STORE = storeBackend() === 'firestore';
let skipped = 0;
function skip(name, why) { skipped++; console.log('  ⊘', name, '—', why); }

let pass = 0, fail = 0;
const failures = [];
async function t(name, fn, { needsStore = false } = {}) {
  if (needsStore && !STORE) return skip(name, 'no user store configured');
  try { await fn(); pass++; console.log('  ✓', name); }
  catch (e) { fail++; failures.push(`${name}: ${e.message}`); console.log('  ✗', name, '\n     ', e.message); }
}
function section(s) { console.log(`\n${s}`); }

/* ---------------------------------------------------------------- people */

const PEOPLE = {
  admin: { email: 'boss@modcon.example', name: 'Sumanth', role: 'owner' },
  asha: { email: 'asha@example.com', name: 'Asha', role: 'demo' },
  ravi: { email: 'ravi@example.com', name: 'Ravi', role: 'demo' },
};

/** A signed-in browser, as the handlers actually see one. */
function as(person, { method = 'GET', body = null, query = {} } = {}) {
  const p = PEOPLE[person];
  const token = issueToken({ email: p.email, name: p.name, role: p.role, orgId: 'modcon' });
  const cookie = sessionCookie(token).split(';')[0];
  return { method, headers: { cookie }, query, body, socket: { remoteAddress: '10.0.0.9' } };
}

/** A visitor who has not signed in. */
const anonymous = (over = {}) => ({ method: 'GET', headers: {}, query: {}, socket: { remoteAddress: '10.0.0.9' }, ...over });

/** Collect a handler's response rather than writing it to a socket. */
function capture() {
  const res = {
    statusCode: 200, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; this.done = true; return this; },
    end() { this.done = true; return this; },
  };
  return res;
}

async function call(req) {
  const res = capture();
  await demoRoute(req, res);
  return res;
}

/** One call's worth of plausible payload. */
const payload = (who, turns = 3) => ({
  lang: 'te-IN',
  startedAt: Date.now() - 60_000,
  history: Array.from({ length: turns * 2 }, (_, i) => (
    i % 2 === 0
      ? { role: 'agent', text: `Anaga line ${i / 2 + 1} for ${who}` }
      : { role: 'user', text: `${who} said something ${(i + 1) / 2}` }
  )),
  timings: Array.from({ length: turns }, (_, i) => ({ ttfa: 1200 + i * 50, llm: 1000, tts: 260 })),
});

console.log('\n═══ TWO PEOPLE, AT THE SAME TIME ═══\n');

// ── Sign-in, before anyone reaches anything ────────────────────────────────
section('§1 who gets an account at all');

await t('the admin address is owner; a stranger is demo; both are real', () => {
  assert.equal(allowedRole('boss@modcon.example'), 'owner');
  assert.equal(allowedRole('asha@example.com'), 'demo');
});

await t('with DEMO_SIGNIN off, a stranger gets NOTHING', () => {
  const was = process.env.DEMO_SIGNIN;
  process.env.DEMO_SIGNIN = '';
  try {
    assert.equal(allowedRole('asha@example.com'), null, 'demo sign-up must be opt-in');
    assert.equal(allowedRole('boss@modcon.example'), 'owner', 'and the admin list is unaffected');
  } finally { process.env.DEMO_SIGNIN = was; }
});

await t('a demo session cannot satisfy any console guard', () => {
  // Every console endpoint asks for viewer or above. This is the whole
  // enforcement — no endpoint has to know that `demo` exists.
  for (const need of ['viewer', 'operator', 'owner']) {
    assert.equal(hasRole({ role: 'demo' }, need), false, `demo passed ${need}`);
  }
  assert.equal(hasRole({ role: 'owner' }, 'demo'), true, 'an owner may still hold a demo call');
});

// ── The calls themselves, held at the same moment ──────────────────────────
section('§2 both hold a call, concurrently');

let ashaId = null, raviId = null;

await t('two demo users record calls at the same time, and both succeed', async () => {
  const [a, r] = await Promise.all([
    call(as('asha', { method: 'POST', body: payload('asha') })),
    call(as('ravi', { method: 'POST', body: payload('ravi', 2) })),
  ]);
  assert.equal(a.statusCode, 201, `asha: ${JSON.stringify(a.body)}`);
  assert.equal(r.statusCode, 201, `ravi: ${JSON.stringify(r.body)}`);
  ashaId = a.body.id; raviId = r.body.id;
  assert.notEqual(ashaId, raviId, 'two calls must not share an id');
}, { needsStore: true });

await t('an anonymous visitor cannot record a call', async () => {
  const res = await call(anonymous({ method: 'POST', body: payload('nobody') }));
  assert.equal(res.statusCode, 401);
});

await t('a call with no conversation in it is refused', async () => {
  const res = await call(as('asha', { method: 'POST', body: { lang: 'te-IN', history: [] } }));
  assert.equal(res.statusCode, 400);
}, { needsStore: true });

// ── The read, which is where identity actually matters ─────────────────────
section('§3 who can see what');

await t('Asha sees her own call and NOT Ravi\'s', async () => {
  const res = await call(as('asha'));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.scope, 'mine');
  const ids = res.body.calls.map((c) => c.id);
  assert.ok(ids.includes(ashaId), 'her own call is missing');
  assert.ok(!ids.includes(raviId), 'SHE CAN SEE ANOTHER USER\'S CALL');
}, { needsStore: true });

await t('Ravi sees his own and NOT Asha\'s — the mirror image', async () => {
  const res = await call(as('ravi'));
  const ids = res.body.calls.map((c) => c.id);
  assert.ok(ids.includes(raviId));
  assert.ok(!ids.includes(ashaId), 'HE CAN SEE ANOTHER USER\'S CALL');
}, { needsStore: true });

await t('the admin sees BOTH, and is told the scope is `all`', async () => {
  const res = await call(as('admin'));
  assert.equal(res.body.scope, 'all');
  const ids = res.body.calls.map((c) => c.id);
  assert.ok(ids.includes(ashaId) && ids.includes(raviId),
    'an owner must see every demo call, or the console is blind to them');
}, { needsStore: true });

await t('the admin is told WHOSE each call is; a demo user is not', async () => {
  const admin = await call(as('admin'));
  assert.ok(admin.body.calls.every((c) => typeof c.by === 'string'),
    'the console needs to attribute a call');
  const asha = await call(as('asha'));
  assert.ok(asha.body.calls.every((c) => c.by === undefined),
    'a demo user has no business learning other addresses');
}, { needsStore: true });

await t('no transcript rides along in the LIST, for anyone', async () => {
  // Transcripts are fetched one at a time through the endpoint that logs the
  // read. A list that carried them would bypass that quietly.
  for (const who of ['asha', 'admin']) {
    const res = await call(as(who));
    assert.ok(res.body.calls.every((c) => !('history' in c)), `${who} got transcripts in a list`);
  }
}, { needsStore: true });

await t('an anonymous visitor sees nothing at all', async () => {
  const res = await call(anonymous());
  assert.equal(res.statusCode, 401);
}, { needsStore: true });

// ── The socket ticket, which is what a call actually needs ─────────────────
section('§4 the ticket each of them carries');

await t('both personas get a working ticket, and it names them', () => {
  for (const who of ['asha', 'admin']) {
    const v = verifyAgentToken(mintAgentToken(PEOPLE[who]));
    assert.equal(v.ok, true, `${who} could not get a ticket`);
    assert.equal(v.user.email, PEOPLE[who].email.toLowerCase());
  }
});

await t('Asha cannot turn her ticket into an owner\'s', () => {
  const token = mintAgentToken(PEOPLE.asha);
  const [body, mac] = token.split('.');
  const p = JSON.parse(Buffer.from(body, 'base64url').toString());
  p.r = 'owner'; p.e = 'boss@modcon.example';
  const forged = `${Buffer.from(JSON.stringify(p)).toString('base64url')}.${mac}`;
  assert.equal(verifyAgentToken(forged).ok, false, 'A DEMO USER JUST BECAME THE OWNER');
});

// ── The whole point: a demo user is never an admin ─────────────────────────
section('§5 the boundary, stated once more');

await t('nothing a demo user can do produces a viewer-or-above session', async () => {
  // The console reads go through authorizeRead({role:'viewer'}), so this is
  // the property every one of them depends on.
  const { authorizeRead } = await import('../api/_lib/integrations/http.js');
  const out = await authorizeRead(as('asha'), { role: 'viewer' });
  assert.equal(out.ok, false, 'a demo session reached a console endpoint');
  assert.equal(out.status, 403, 'and it must be a 403 that STOPS, not a fall-through');
}, { needsStore: true });

await t('the admin does reach the console', async () => {
  const { authorizeRead } = await import('../api/_lib/integrations/http.js');
  const out = await authorizeRead(as('admin'), { role: 'viewer' });
  assert.equal(out.ok, true);
  assert.equal(out.via, 'session');
  assert.equal(out.user.email, 'boss@modcon.example');
}, { needsStore: true });

console.log(`\n═══ ${pass} passed, ${fail} failed, ${skipped} skipped ═══\n`);
if (skipped) {
  console.log('  The skipped assertions are the SCOPING ones — one user reading');
  console.log('  another\'s calls, a demo session reaching the console. They need a');
  console.log('  user store, because currentUser() resolves the role from it rather');
  console.log('  than from the session token. Run with FIREBASE_SERVICE_ACCOUNT set,');
  console.log('  against a scratch project, to exercise them.\n');
}
if (fail) { failures.forEach((f) => console.log('  FAIL ' + f)); process.exit(1); }
