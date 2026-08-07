// scripts/preflight.mjs
//
// "Is this deployment allowed to dial a real number?" — answered by asking the
// deployment, not by reading a document.
//
//   BASE=https://your-deploy.vercel.app node scripts/preflight.mjs
//   BASE=… CALLER_AGENT=https://agent.internal node scripts/preflight.mjs
//
// Exit 0 only when every gate is green. Anything else exits 1 and names what is
// missing, so this can sit in CI or a deploy step.
//
// It deliberately reports the LIVE deployment rather than the repo. Those are
// different claims — the whole reason LAUNCH.md was wrong about Firestore for
// weeks is that the code was written, the tests passed, and nobody asked the
// running site.

const BASE = (process.env.BASE || '').replace(/\/+$/, '');
const AGENT = (process.env.CALLER_AGENT || '').replace(/\/+$/, '');

if (!BASE) {
  console.error('BASE is required.\n  BASE=https://your-deploy.vercel.app node scripts/preflight.mjs');
  process.exit(1);
}

const GREEN = '\x1b[32m', RED = '\x1b[31m', YELLOW = '\x1b[33m', DIM = '\x1b[2m', OFF = '\x1b[0m';
const okMark = `${GREEN}✓${OFF}`, noMark = `${RED}✗${OFF}`, warnMark = `${YELLOW}!${OFF}`;

const problems = [];
const warnings = [];

function check(pass, label, detail) {
  console.log(`  ${pass ? okMark : noMark} ${label}${detail ? `  ${DIM}${detail}${OFF}` : ''}`);
  if (!pass) problems.push(label);
}
function warn(label, detail) {
  console.log(`  ${warnMark} ${label}${detail ? `  ${DIM}${detail}${OFF}` : ''}`);
  warnings.push(label);
}

async function getJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return { ok: res.ok, status: res.status, data: await res.json().catch(() => null) };
  } catch (err) {
    return { ok: false, status: 0, error: String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

console.log(`\nPre-flight — ${BASE}\n`);

// ---------------------------------------------------------------------------
const health = await getJson(`${BASE}/api/integrations/health`);
if (!health.ok || !health.data) {
  console.error(`${noMark} /api/integrations/health unreachable (${health.status || health.error})`);
  process.exit(1);
}
const h = health.data;

console.log('compliance');
check(h.compliance?.mode === 'strict', 'COMPLIANCE_MODE is strict', h.compliance?.mode);
check(Boolean(h.compliance?.dndScrub), 'DND scrub configured');
check(Boolean(h.compliance?.suppressionList), 'suppression list configured', h.compliance?.suppressionBackend);
console.log(`  ${DIM}calling window: ${h.compliance?.callingWindowIST}${OFF}`);

console.log('\ndurability');
check(h.store?.backend === 'firestore', 'datastore is durable', h.store?.backend);
check(h.store?.reachable === true, 'datastore reachable');

console.log('\nrecording (docs/COMPLIANCE.md)');
check(Boolean(h.recording?.configured), 'recording storage configured');
check(h.recording?.indianRegion === true || h.recording?.overrideActive === true,
  'recording region', h.recording?.region);
if (h.recording?.overrideActive) {
  warn('RECORDING_ALLOW_NON_INDIAN_REGION is set — recordings leave India', h.recording?.region);
}
console.log(`  ${DIM}retention: ${h.recording?.retentionDays}d, enforced by ${h.recording?.retentionEnforcedBy}${OFF}`);
console.log(`  ${DIM}↑ verify that lifecycle rule exists in the bucket — this code cannot see it${OFF}`);

console.log('\nvoice');
check(h.tts?.available === true, 'a TTS provider is available', (h.tts?.ready || []).join(', '));
if (h.voiceStudio?.configured && !h.voiceStudio?.reachable) {
  check(false, 'VoiceStudio configured but unreachable', h.voiceStudio?.error);
} else if (h.voiceStudio?.reachable) {
  console.log(`  ${okMark} VoiceStudio reachable  ${DIM}${h.voiceStudio.voices} voice(s)${OFF}`);
}
if (!h.tts?.maleCapable) warn('no male voice available', 'the Arjun preset will report itself unserved');

console.log('\nintake & dialling');
check(Boolean(h.meta?.appSecret && h.meta?.pageAccessToken), 'Meta Lead Ads wired');
check(h.crm?.configured === true, 'CRM configured', h.crm?.provider);
check(h.dialQueue?.configured === true, 'dial queue configured');
check(h.dialQueue?.signed === true, 'dial jobs are signed');
check(h.brain?.configured === true, 'call brain configured', h.brain?.provider);

// A live 503 from the brain is the quota case — configured but unusable.
const turn = await fetch(`${BASE}/api/anaga/turn`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ history: [], lead: {} }),
}).then((r) => r.status).catch(() => 0);
if (turn === 503) warn('the brain answers 503 — key configured but out of quota or unreachable');

// ---------------------------------------------------------------------------
if (AGENT) {
  console.log(`\ncaller agent — ${AGENT}`);
  const a = await getJson(`${AGENT}/health`);
  if (!a.ok || !a.data) {
    check(false, 'caller agent /health unreachable', String(a.status || a.error));
  } else {
    check(a.data.canDialForReal === true, 'canDialForReal', (a.data.blockers || []).join(', '));
  }
} else {
  warn('CALLER_AGENT not set — the dialler was not checked', 'nothing places calls without it');
}

// ---------------------------------------------------------------------------
console.log('\nnot checkable from here — confirm by hand');
for (const line of [
  'DLT principal entity registration',
  '160-series outbound number provisioned',
  'telemarketer registration',
  'the bucket lifecycle rule really expires objects at 90 days',
  'one real call placed to a consenting internal number, end to end',
  'that call\'s opt-out reached the suppression list, and a re-dial was refused',
]) console.log(`  ${DIM}·${OFF} ${line}`);

// ---------------------------------------------------------------------------
console.log();
if (problems.length) {
  console.log(`${RED}NOT production ready${OFF} — ${problems.length} blocker(s):`);
  for (const p of problems) console.log(`  ${noMark} ${p}`);
  if (Array.isArray(h.blockers) && h.blockers.length) {
    console.log(`\n${DIM}the deployment also reports: ${h.blockers.join(', ')}${OFF}`);
  }
  console.log();
  process.exit(1);
}

if (warnings.length) console.log(`${YELLOW}${warnings.length} warning(s) above.${OFF}`);
console.log(`${GREEN}All automated gates pass.${OFF} The hand-checked list above is still yours to confirm.\n`);
