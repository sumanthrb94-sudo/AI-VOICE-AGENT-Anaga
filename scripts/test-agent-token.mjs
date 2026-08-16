// scripts/test-agent-token.mjs
//
// The ticket that stops a stranger spending your vendor credit.
//
// ── WHY ────────────────────────────────────────────────────────────────────
// /agent is --allow-unauthenticated because a browser has no shared secret and
// Cloud Run has no other way to let one connect. Every deploy printed the
// consequence: anyone with the URL can open a socket and burn Sarvam and
// Deepgram credit, and the mitigations bounded the bill rather than preventing
// it.
//
// A forgery here is not a bug, it is somebody else's invoice. So the tests are
// about what must be REFUSED.
//
// Run: node --experimental-detect-module scripts/test-agent-token.mjs

import assert from 'node:assert';
import cryptoMod from 'node:crypto';

const {
  mintAgentToken, verifyAgentToken, agentTokenConfigured,
} = await import('../shared/agent-token.js');

let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓', name); }
  catch (e) { fail++; failures.push(`${name}: ${e.message}`); console.log('  ✗', name, '\n     ', e.message); }
}

const SECRET = 'a-secret-of-more-than-sixteen-characters';
const env = { AGENT_TOKEN_SECRET: SECRET };
const user = { email: 'Someone@Example.com', role: 'demo' };

console.log('\n═══ A VALID TICKET ═══\n');

t('round-trips, and lowercases the address it carries', () => {
  const v = verifyAgentToken(mintAgentToken(user, { env }), { env });
  assert.equal(v.ok, true);
  assert.equal(v.user.email, 'someone@example.com');
  assert.equal(v.user.role, 'demo');
});

t('two tickets minted in the same millisecond differ', () => {
  const now = () => 1_000_000;
  const a = mintAgentToken(user, { env, now });
  const b = mintAgentToken(user, { env, now });
  assert.notEqual(a, b, 'a repeated ticket is a replayable one');
});

console.log('\n═══ WHAT MUST BE REFUSED ═══\n');

t('a tampered PAYLOAD, even with the old signature', () => {
  // The attack: mint as `demo`, rewrite the role to `owner`, keep the mac.
  const token = mintAgentToken(user, { env });
  const [body, mac] = token.split('.');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
  payload.r = 'owner';
  const forged = `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${mac}`;
  const v = verifyAgentToken(forged, { env });
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'bad_signature');
});

t('a ticket signed with a DIFFERENT secret', () => {
  const other = mintAgentToken(user, { env: { AGENT_TOKEN_SECRET: 'a-completely-different-secret-x' } });
  assert.equal(verifyAgentToken(other, { env }).ok, false);
});

t('an EXPIRED ticket, and the expiry is read only after the signature', () => {
  // Checking `x` before verifying would mean trusting a number the attacker
  // chose — and a forged token with a far-future expiry would be accepted on
  // the strength of its own claim.
  const token = mintAgentToken(user, { env, ttlMs: 1000, now: () => 1_000_000 });
  const v = verifyAgentToken(token, { env, now: () => 1_002_000 });
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'expired');
});

t('a ticket that is still valid one second before it dies', () => {
  const token = mintAgentToken(user, { env, ttlMs: 5000, now: () => 1_000_000 });
  assert.equal(verifyAgentToken(token, { env, now: () => 1_004_000 }).ok, true);
});

t('garbage, in every shape, without throwing', () => {
  // timingSafeEqual THROWS on a length mismatch. Reaching it unguarded turns a
  // malformed token into a 500 — and into a different response TIME than a
  // merely wrong one, which is the side channel this is meant to avoid.
  for (const bad of ['', '.', 'a.', '.b', 'no-dot', 'a.b', '.'.repeat(50), 'x'.repeat(4000)]) {
    const v = verifyAgentToken(bad, { env });
    assert.equal(v.ok, false, `accepted ${JSON.stringify(bad.slice(0, 20))}`);
  }
});

t('a valid signature over a payload with no expiry', () => {
  const body = Buffer.from(JSON.stringify({ e: 'x@y.com', r: 'owner' })).toString('base64url');
  const crypto = cryptoMod;
  const mac = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  const v = verifyAgentToken(`${body}.${mac}`, { env });
  assert.equal(v.ok, false, 'a ticket with no expiry never expires');
  assert.equal(v.reason, 'expired');
});

console.log('\n═══ UNCONFIGURED IS NOT AUTHORISED ═══\n');

t('minting REFUSES rather than signing with a weak or empty secret', () => {
  // A token signed with "" verifies against "" — which every attacker also
  // has. Returning one would look like protection and be none.
  for (const secret of ['', 'short', 'x'.repeat(15)]) {
    assert.throws(() => mintAgentToken(user, { env: { AGENT_TOKEN_SECRET: secret } }),
      /agent_token_not_configured/, `minted with secret of length ${secret.length}`);
  }
});

t('verification refuses everything when unconfigured', () => {
  const v = verifyAgentToken(mintAgentToken(user, { env }), { env: {} });
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'not_configured');
});

t('agentTokenConfigured() is the single source of that judgement', () => {
  assert.equal(agentTokenConfigured({}), false);
  assert.equal(agentTokenConfigured({ AGENT_TOKEN_SECRET: 'short' }), false);
  assert.equal(agentTokenConfigured(env), true);
});

console.log(`\n═══ ${pass} passed, ${fail} failed ═══\n`);
if (fail) { failures.forEach((f) => console.log('  FAIL ' + f)); process.exit(1); }
