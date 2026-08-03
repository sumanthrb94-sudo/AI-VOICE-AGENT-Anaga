// scripts/test-integrations.mjs
//
// Dependency-free smoke test for the Meta / CRM integration tubing
// (api/_lib/**, api/integrations/**, api/leads/**, api/calls/**).
//
//   node --experimental-detect-module scripts/test-integrations.mjs
//
// No network: every test exercises pure logic or a handler with a fake req/res,
// and the compliance gate is asserted to BLOCK when nothing is configured —
// if that assertion ever flips, the gate has stopped failing closed.
import assert from 'node:assert';
import crypto from 'node:crypto';

const R = new URL('../', import.meta.url).pathname.replace(/\/$/, '');
process.env.COMPLIANCE_MODE = 'strict';
process.env.META_APP_SECRET = 'test_app_secret';
process.env.META_VERIFY_TOKEN = 'verify_me';
process.env.INTEGRATIONS_API_KEY = 'k'.repeat(32);

const lead = await import(`${R}/api/_lib/integrations/lead.js`);
const meta = await import(`${R}/api/_lib/integrations/meta.js`);
const comp = await import(`${R}/api/_lib/compliance.js`);
const pipe = await import(`${R}/api/_lib/pipeline.js`);
const crm = await import(`${R}/api/_lib/integrations/crm.js`);

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('  ✓', name); }
  catch (e) { fail++; console.log('  ✗', name, '\n     ', e.message); }
};

console.log('\nphone normalization');
await t('bare 10-digit -> +91', () => assert.equal(lead.normalizePhone('9876543210'), '+919876543210'));
await t('spaced/dashed', () => assert.equal(lead.normalizePhone('98765 43210'), '+919876543210'));
await t('0-prefixed', () => assert.equal(lead.normalizePhone('09876543210'), '+919876543210'));
await t('91-prefixed', () => assert.equal(lead.normalizePhone('919876543210'), '+919876543210'));
await t('+91 form', () => assert.equal(lead.normalizePhone('+91 98765-43210'), '+919876543210'));
await t('00 international', () => assert.equal(lead.normalizePhone('0019876543210'), '+19876543210'));
await t('landline-ish 10-digit starting 4 rejected as mobile', () => assert.equal(lead.normalizePhone('4012345678'), '+4012345678'));
await t('garbage -> null', () => assert.equal(lead.normalizePhone('hello'), null));
await t('empty -> null', () => assert.equal(lead.normalizePhone(''), null));
await t('mask hides middle', () => assert.match(lead.maskPhone('+919876543210'), /^\+9198X+10$/));

console.log('\nmeta signature + challenge');
await t('good signature verifies', () => {
  const body = '{"object":"page"}';
  const sig = 'sha256=' + crypto.createHmac('sha256', 'test_app_secret').update(body).digest('hex');
  assert.equal(meta.verifySignature(body, sig).ok, true);
});
await t('tampered body rejected', () => {
  const sig = 'sha256=' + crypto.createHmac('sha256', 'test_app_secret').update('{"object":"page"}').digest('hex');
  assert.equal(meta.verifySignature('{"object":"pageX"}', sig).ok, false);
});
await t('missing header rejected', () => assert.equal(meta.verifySignature('{}', undefined).error, 'missing_signature'));
await t('challenge ok', () => {
  const v = meta.verifyChallenge({ 'hub.mode': 'subscribe', 'hub.verify_token': 'verify_me', 'hub.challenge': '12345' });
  assert.equal(v.ok, true); assert.equal(v.challenge, '12345');
});
await t('wrong verify token -> 403', () => {
  const v = meta.verifyChallenge({ 'hub.mode': 'subscribe', 'hub.verify_token': 'nope', 'hub.challenge': '1' });
  assert.equal(v.status, 403);
});
await t('parse leadgen changes', () => {
  const out = meta.parseLeadgenChanges({
    object: 'page',
    entry: [{ id: 'PAGE1', changes: [
      { field: 'leadgen', value: { leadgen_id: '999', form_id: 'F1', created_time: 1754209990 } },
      { field: 'messages', value: {} },
    ] }],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].leadgenId, '999');
  assert.equal(out[0].pageId, 'PAGE1');
  assert.match(out[0].createdTime, /^20/);
});
await t('graph record -> lead (known fields + consent)', () => {
  const l = meta.leadFromGraph({
    id: '999', created_time: new Date().toISOString(), platform: 'instagram',
    campaign_name: 'Skyline Aug',
    field_data: [
      { name: 'full_name', values: ['Ravi Kumar'] },
      { name: 'phone_number', values: ['+91 98765 43210'] },
      { name: 'what_is_your_budget?', values: ['1-2 Cr'] },
      { name: 'preferred_bhk', values: ['3BHK'] },
      { name: 'favourite_colour', values: ['blue'] },
    ],
  }, { leadgenId: '999', pageId: 'P1' });
  assert.equal(l.phone, '+919876543210');
  assert.equal(l.name, 'Ravi Kumar');
  assert.equal(l.known.budget, '1-2 Cr');
  assert.equal(l.known.configuration, '3BHK');
  assert.equal(l.extra['favourite_colour'], 'blue');
  assert.equal(l.consent.basis, 'lead_form');
  assert.equal(l.consent.granted, true);
  assert.equal(l.campaign.platform, 'instagram');
  assert.equal(l.source, 'meta_lead_ads');
});

console.log('\ncompliance gate (strict, nothing configured => must block)');
const mkLead = (over = {}) => lead.normalizeLead(
  { name: 'Test', phone: '9876543210', ...over },
  { source: 'api', sourceId: String(Math.random()), consent: { granted: true, basis: 'crm', at: new Date().toISOString() } },
);
await t('unconfigured scrub blocks in strict mode', async () => {
  const g = await comp.checkDialable(mkLead(), { ignoreWindow: true });
  assert.equal(g.allowed, false);
  assert.equal(g.reason, 'suppression_unverified');
});
await t('no consent blocks before any network call', async () => {
  const l = lead.normalizeLead({ phone: '9876543210' }, { source: 'api', consent: {} });
  const g = await comp.checkDialable(l);
  assert.equal(g.allowed, false);
  assert.equal(g.reason, 'no_consent');
});
await t('expired consent blocks', async () => {
  const old = new Date(Date.now() - 200 * 86400000).toISOString();
  const l = lead.normalizeLead({ phone: '9876543210' }, { source: 'api', consent: { granted: true, basis: 'lead_form', at: old } });
  const g = await comp.checkDialable(l);
  assert.equal(g.reason, 'consent_expired');
});
await t('invalid phone blocks', async () => {
  const l = lead.normalizeLead({ phone: 'abc' }, { source: 'api', consent: { granted: true, basis: 'crm', at: new Date().toISOString() } });
  assert.equal((await comp.checkDialable(l)).reason, 'invalid_phone');
});
await t('dev mode warns instead of blocking', async () => {
  process.env.COMPLIANCE_MODE = 'dev';
  const g = await comp.checkDialable(mkLead(), { ignoreWindow: true });
  process.env.COMPLIANCE_MODE = 'strict';
  assert.equal(g.allowed, true);
  assert.ok(g.warnings.some((w) => w.startsWith('dnd_unverified')));
});
await t('opt-out suppression blocks the next check (dev mode)', async () => {
  process.env.COMPLIANCE_MODE = 'dev';
  const l = mkLead({ phone: '9812345678' });
  assert.equal((await comp.checkDialable(l, { ignoreWindow: true })).allowed, true);
  await comp.addToSuppression('9812345678', 'opt_out');
  const g = await comp.checkDialable(mkLead({ phone: '9812345678' }), { ignoreWindow: true });
  process.env.COMPLIANCE_MODE = 'strict';
  assert.equal(g.allowed, false);
  assert.equal(g.reason, 'suppressed');
});
await t('calling window respects IST', () => {
  const h = comp.istHour(new Date('2026-08-03T04:00:00Z'));   // 09:30 IST
  assert.equal(h, 9);
  assert.equal(comp.withinCallingWindow(new Date('2026-08-03T04:00:00Z')), true);
  assert.equal(comp.withinCallingWindow(new Date('2026-08-03T18:00:00Z')), false); // 23:30 IST
});

console.log('\npipeline');
await t('dry run returns the dial job when the gate passes (dev)', async () => {
  process.env.COMPLIANCE_MODE = 'dev';
  const out = await pipe.intakeLead(mkLead({ phone: '9876500001' }), { dryRun: true, ignoreWindow: true });
  process.env.COMPLIANCE_MODE = 'strict';
  assert.equal(out.accepted, true);
  assert.equal(out.job.type, 'outbound_call');
  assert.equal(out.job.lead.phone, '+919876500001');
  assert.equal(out.job.agent.name, 'Anaga');
  assert.equal(out.steps.compliance.allowed, true);
});
await t('blocked lead is accepted but not queued', async () => {
  const out = await pipe.intakeLead(mkLead({ phone: '9876500002' }), { ignoreWindow: true });
  assert.equal(out.accepted, true);
  assert.equal(out.queued, false);
  assert.match(out.reason, /^blocked:/);
});
await t('duplicate is a no-op', async () => {
  const l = mkLead({ phone: '9876500003' });
  l.id = 'meta_lead_ads:dupe-1';
  await pipe.intakeLead(l, { ignoreWindow: true });
  const second = await pipe.intakeLead(l, { ignoreWindow: true });
  assert.equal(second.reason, 'duplicate_lead');
  assert.equal(second.steps.dedupe.duplicate, true);
});
await t('phone never appears unmasked in the result', async () => {
  const out = await pipe.intakeLead(mkLead({ phone: '9876500004' }), { ignoreWindow: true });
  assert.ok(!JSON.stringify(out.lead).includes('9876500004'));
});

console.log('\ncrm boundary');
await t('default provider is none and it no-ops truthfully', async () => {
  assert.equal(crm.crmProvider(), 'none');
  const r = await crm.upsertLead(mkLead());
  assert.equal(r.ok, true); assert.equal(r.noop, true);
});
await t('call note renders the closer-facing fields', () => {
  const note = crm.renderCallNote(
    mkLead({ purpose: 'investment' }),
    { disposition: 'booked', score: 78, summary: 'Wants a 3BHK.', comment: 'Serious buyer.', nextAction: 'Assign closer.' },
    { startedAt: '2026-08-03T10:00:00Z', durationSec: 96, history: [{ role: 'user', text: 'Saturday works' }] },
  );
  assert.match(note, /booked/); assert.match(note, /intent 78\/100/);
  assert.match(note, /Next action: Assign closer\./);
  assert.match(note, /purpose: investment/);
  assert.match(note, /Prospect: Saturday works/);
});

console.log('\nendpoint handlers (fake req/res)');
const mkRes = () => {
  const r = { statusCode: 0, body: null, headers: {} };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.send = (b) => { r.body = b; return r; };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  return r;
};
const metaHandler = (await import(`${R}/api/integrations/meta/leads.js`)).default;
const intakeHandler = (await import(`${R}/api/leads/intake.js`)).default;
const outcomeHandler = (await import(`${R}/api/calls/outcome.js`)).default;
const healthHandler = (await import(`${R}/api/integrations/health.js`)).default;

await t('meta GET handshake returns the challenge as text', async () => {
  const res = mkRes();
  await metaHandler({ method: 'GET', headers: {}, query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'verify_me', 'hub.challenge': 'abc123' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, 'abc123');
  assert.match(res.headers['Content-Type'], /text\/plain/);
});
await t('meta POST without signature -> 403, nothing processed', async () => {
  const res = mkRes();
  await metaHandler({ method: 'POST', headers: {}, body: { object: 'page', entry: [] } }, res);
  assert.equal(res.statusCode, 403);
});
await t('meta POST with valid signature but no leadgen -> 200 ignored', async () => {
  const body = { object: 'page', entry: [{ id: '1', changes: [{ field: 'messages', value: {} }] }] };
  const raw = JSON.stringify(body);
  const res = mkRes();
  await metaHandler({
    method: 'POST',
    headers: { 'x-hub-signature-256': 'sha256=' + crypto.createHmac('sha256', 'test_app_secret').update(raw).digest('hex') },
    body,
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ignored, 'no_leadgen_changes');
});
await t('intake without auth -> 401', async () => {
  const res = mkRes();
  await intakeHandler({ method: 'POST', headers: {}, body: { phone: '9876543210' } }, res);
  assert.equal(res.statusCode, 401);
});
await t('intake with auth, dry run, reports the gate verdict', async () => {
  const res = mkRes();
  await intakeHandler({
    method: 'POST',
    headers: { authorization: `Bearer ${'k'.repeat(32)}` },
    body: { phone: '9876500010', name: 'Ravi', consent: { granted: true, basis: 'crm', at: new Date().toISOString() }, dryRun: true, ignoreWindow: true },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.received, 1);
  assert.equal(res.body.results[0].steps.compliance.allowed, false); // strict + no scrub
  assert.equal(res.body.blocked, 1);
});
await t('intake rejects an oversized batch', async () => {
  const res = mkRes();
  await intakeHandler({ method: 'POST', headers: { authorization: `Bearer ${'k'.repeat(32)}` }, body: { leads: new Array(101).fill({ phone: '9876543210' }) } }, res);
  assert.equal(res.body.error, 'batch_too_large');
});
await t('outcome writes back with a heuristic review when the LLM is absent', async () => {
  const res = mkRes();
  await outcomeHandler({
    method: 'POST',
    headers: { authorization: `Bearer ${'k'.repeat(32)}` },
    body: {
      call: { id: 'smoke-1', disposition: 'booked' },
      lead: { phone: '9876500020', name: 'Ravi' },
      history: [{ role: 'agent', text: 'Hi' }, { role: 'user', text: 'Saturday works' }],
    },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.review.generatedBy, 'heuristic');
  assert.equal(res.body.review.disposition, 'booked');
  assert.equal(res.body.optOut, false);
  assert.equal(res.body.crm.logged, true);
});
await t('outcome detects an opt-out in the transcript and suppresses', async () => {
  const res = mkRes();
  await outcomeHandler({
    method: 'POST',
    headers: { authorization: `Bearer ${'k'.repeat(32)}` },
    body: {
      call: { id: 'smoke-2', disposition: 'callback' },   // agent said callback...
      lead: { phone: '9876500021' },
      history: [{ role: 'user', text: 'please remove me from your list, do not call again' }],
    },
  }, res);
  assert.equal(res.body.optOut, true);                      // ...transcript wins
  assert.equal(res.body.review.disposition, 'opt-out');
  assert.equal(res.body.review.score, 0);
  assert.equal(res.body.suppression.durable, false);        // no SUPPRESSION_LIST_URL
  const g = await comp.checkDialable(mkLead({ phone: '9876500021' }), { ignoreWindow: true });
  assert.equal(g.reason, 'suppressed');                     // and it blocks the next dial
});
await t('outcome rejects a lead with no dialable phone', async () => {
  const res = mkRes();
  await outcomeHandler({ method: 'POST', headers: { authorization: `Bearer ${'k'.repeat(32)}` }, body: { lead: { phone: 'nope' } } }, res);
  assert.equal(res.statusCode, 400);
});
await t('health reports blockers without leaking values', async () => {
  const res = mkRes();
  await healthHandler({ method: 'GET', headers: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.blockers.includes('dnd_scrub_not_configured'));
  assert.ok(res.body.blockers.includes('suppression_list_not_configured'));
  assert.equal(res.body.ready.production, false);
  assert.ok(!JSON.stringify(res.body).includes('test_app_secret'));
  assert.ok(!JSON.stringify(res.body).includes('k'.repeat(32)));
});
await t('wrong method -> 405 with Allow', async () => {
  const res = mkRes();
  await intakeHandler({ method: 'GET', headers: {} }, res);
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers['Allow'], 'POST');
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
