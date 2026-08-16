// scripts/test-container-contents.mjs
//
// Does the Cloud Run image actually contain everything the service imports?
//
// ── WHY THIS IS A TEST AND NOT A CODE REVIEW ──────────────────────────────
// deploy/cloudrun/Dockerfile copies an EXPLICIT list of directories rather
// than `COPY . .`, which is right — the whole repo would put the Vercel
// functions, the test suites and a frontend toolchain into a container that
// answers phone calls. But an explicit list is a list that goes stale, and the
// failure mode is nasty: the build succeeds, the container starts, /health
// says fine, and the service dies on the first import at runtime — or worse,
// serves a 404 for the page it exists to serve.
//
// It already had one hole. `web/` was not copied, so server.js's serveStatic()
// resolved ../../../web to a directory that did not exist and /live.html
// 404'd on a service whose entire purpose is a live call.
//
// This walks main.js's real import graph and asserts every file it reaches
// falls inside a COPY line, without needing Docker.
//
// Run: node --experimental-detect-module scripts/test-container-contents.mjs

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCKERFILE = path.join(ROOT, 'deploy/cloudrun/Dockerfile');
const ENTRY = path.join(ROOT, 'caller-agent/src/agent/main.js');

let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓', name); }
  catch (e) { fail++; failures.push(`${name}: ${e.message}`); console.log('  ✗', name, '\n     ', e.message); }
}

/** The directories the Dockerfile actually copies. */
function copiedPrefixes() {
  const df = fs.readFileSync(DOCKERFILE, 'utf8');
  const out = [];
  for (const m of df.matchAll(/^COPY\s+(\S+)\s+\S+\s*$/gm)) {
    out.push(m[1].replace(/\/$/, ''));
  }
  return out;
}

/** Every local file main.js reaches, transitively. */
function importGraph(entry) {
  const seen = new Set();
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);

    let src;
    try { src = fs.readFileSync(file, 'utf8'); } catch { continue; }

    // Static imports and re-exports, plus dynamic import('...') with a literal.
    const specs = [
      ...src.matchAll(/(?:^|\s)(?:import|export)[\s\S]{0,200}?from\s+['"]([^'"]+)['"]/g),
      ...src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
    ].map((m) => m[1]);

    for (const spec of specs) {
      if (!spec.startsWith('.')) continue;   // node: builtins, and nothing else
      let resolved = path.resolve(path.dirname(file), spec);
      if (!fs.existsSync(resolved) && fs.existsSync(`${resolved}.js`)) resolved = `${resolved}.js`;
      if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) stack.push(resolved);
      else failures.push(`unresolved import ${spec} from ${path.relative(ROOT, file)}`);
    }
  }
  return [...seen];
}

console.log('\n═══ CLOUD RUN IMAGE CONTENTS ═══\n');

const prefixes = copiedPrefixes();
const graph = importGraph(ENTRY);

const covered = (rel) => prefixes.some((p) => rel === p || rel.startsWith(`${p}/`));

t(`the Dockerfile copies something at all (${prefixes.length} paths)`, () => {
  assert.ok(prefixes.length >= 4, `only found: ${prefixes.join(', ')}`);
});

t(`EVERY module the service imports is in the image (${graph.length} files)`, () => {
  const missing = graph
    .map((f) => path.relative(ROOT, f))
    .filter((rel) => !covered(rel));
  assert.deepEqual(missing, [],
    `\n       these would be MISSING at runtime:\n       ${missing.join('\n       ')}`);
});

t('the call page is in the image, so there is something to click', () => {
  // server.js serves ../../../web statically. Without this COPY the container
  // starts, /health says fine, and /live.html 404s.
  assert.ok(covered('web/live.html'), 'web/ must be copied');
  assert.ok(fs.existsSync(path.join(ROOT, 'web/live.html')), 'and must exist in the repo');
  assert.ok(covered('web/assets/live.js'));
  assert.ok(covered('web/assets/pcm-worklet.js'),
    'the AudioWorklet is loaded by URL at runtime, not imported');
});

t('the flow and persona data are in the image', () => {
  // Loaded with `with { type: 'json' }`, so they are imports the graph walker
  // above may not see as .js — assert them by name.
  for (const f of ['caller-agent/flows/real-estate-qualify.flow.json',
                   'caller-agent/flows/anaga.persona.json']) {
    assert.ok(covered(f), `${f} is not copied — the agent would have no script`);
    assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} is missing from the repo`);
  }
});

t('the latency harness is in the image, so it can be measured in-region', () => {
  // deploy/cloudrun/measure.sh runs this as a Cloud Run JOB on the same image,
  // in asia-south1, because Cloud Shell cannot be pinned to a region and a
  // number measured from the wrong continent is a claim about a network path
  // no prospect is on. If the COPY goes stale the job fails with MODULE_NOT_FOUND
  // after provisioning, which reads as a broken image rather than a missing file.
  assert.ok(covered('scripts/measure-latency.mjs'),
    'scripts/measure-latency.mjs must be copied for measure.sh to work');

  // And everything IT reaches, which is a different graph from the service's.
  const harness = importGraph(path.join(ROOT, 'scripts/measure-latency.mjs'));
  const missing = harness
    .map((f) => path.relative(ROOT, f))
    .filter((rel) => !covered(rel));
  assert.deepEqual(missing, [],
    `\n       the harness would fail at runtime on:\n       ${missing.join('\n       ')}`);
});

t('the frontend toolchain is NOT in the image', () => {
  // A container that answers phone calls has no business carrying Next.js.
  for (const p of ['node_modules', 'app', 'components', '.next', 'out', 'package.json']) {
    assert.ok(!prefixes.includes(p), `${p} must not be copied into the call service`);
  }
});

t('nothing that could hold a credential is copied', () => {
  for (const p of ['.secrets', '.env', '.git']) {
    assert.ok(!prefixes.some((x) => x === p || x.startsWith(`${p}/`)), `${p} must never ship`);
  }
  const ignore = fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf8');
  for (const pat of ['.secrets', '*-adminsdk-*.json', '.git']) {
    assert.ok(ignore.includes(pat), `.dockerignore must list ${pat}`);
  }
});

t('no import resolved to a file that does not exist', () => {
  const unresolved = failures.filter((f) => f.startsWith('unresolved import'));
  assert.deepEqual(unresolved, []);
});

console.log(`\n═══ ${pass} passed, ${fail} failed ═══\n`);
if (fail) { failures.forEach((f) => console.log('  FAIL ' + f)); process.exit(1); }
