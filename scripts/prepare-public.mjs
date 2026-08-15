// scripts/prepare-public.mjs
//
// Runs before `next build`. Two jobs, and the second one is a security gate.
//
// 1. STAGE THE HAND-WRITTEN AUDIO ENGINE.
//    web/assets/*.js is not React and is deliberately not going to be. mic.js
//    (the VAD, the percentile noise floor, the hysteresis gate), pcm-worklet.js
//    (an AudioWorklet, which MUST be a separate file URL — addModule takes a
//    URL, not an import), live.js and demo-call.js are vanilla ES5-ish modules
//    with hundreds of tests behind them and no framework opinions. Rewriting
//    them into components would throw away every one of those tests to gain
//    nothing.
//
//    They stay in web/ because caller-agent/src/agent/server.js serves that
//    directory for the local dev loop and the Playwright suites load it. This
//    copies them into public/, which Next.js emits verbatim into out/.
//
//    HTML is deliberately NOT copied: public/index.html would collide with the
//    route app/page.tsx exports to out/index.html, and Next fails the build on
//    that collision rather than silently picking one.
//
// 2. REFUSE TO SHIP CONFIDENTIAL MATERIAL.
//    scripts/build-static.sh used to publish docs/BUSINESS_PLAN.md — a file
//    whose own header says "Confidential — for prospective investors and
//    founding team only" — because the control was a commented-out `cp` that
//    nobody uncommented. The allowlist and the guard move here so they survive
//    the move to Next.js instead of being lost with the script that held them.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');

/** Vanilla assets the new pages load by URL. Named, never globbed — a glob
 *  would quietly start shipping whatever anyone drops in web/assets. */
const ASSETS = [
  'mic.js',          // microphone, VAD, endpointer
  'pcm-worklet.js',  // AudioWorklet — must be a real file URL
  'demo-call.js',    // the HTTP call demo
  'live.js',         // the streaming call client
  'tel.js',          // Telugu voice sampler
];

/** Documents that are deliberately public. Everything else in docs/ is not. */
const PUBLIC_DOCS = [
  'docs/COMPLIANCE.md',    // how we treat DND, consent and opt-out
  'docs/INTEGRATIONS.md',  // what we connect to
];

const CONFIDENTIAL = /^\s*>?\s*\*{0,2}confidential/im;

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

// --- stage ------------------------------------------------------------------
fs.rmSync(PUBLIC, { recursive: true, force: true });
fs.mkdirSync(path.join(PUBLIC, 'assets'), { recursive: true });

for (const name of ASSETS) {
  const src = path.join(ROOT, 'web', 'assets', name);
  if (!fs.existsSync(src)) {
    console.error(`✗ web/assets/${name} is listed in prepare-public.mjs but does not exist`);
    process.exit(1);
  }
  copy(src, path.join(PUBLIC, 'assets', name));
}

for (const rel of PUBLIC_DOCS) {
  const src = path.join(ROOT, rel);
  if (!fs.existsSync(src)) {
    console.error(`✗ PUBLIC_DOCS lists ${rel}, which does not exist`);
    process.exit(1);
  }
  copy(src, path.join(PUBLIC, 'docs', path.basename(rel)));
}

// --- guard ------------------------------------------------------------------
// Belt and braces. Whatever anyone adds above, a document that declares itself
// confidential must never reach the output directory.
const leaked = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full); continue; }
    if (!/\.(md|markdown|txt|html)$/i.test(entry.name)) continue;
    if (CONFIDENTIAL.test(fs.readFileSync(full, 'utf8'))) leaked.push(path.relative(ROOT, full));
  }
})(PUBLIC);

if (leaked.length) {
  console.error('✗ CONFIDENTIAL MATERIAL WOULD BE PUBLISHED:');
  for (const f of leaked) console.error(`    ${f}`);
  console.error('  Remove it from PUBLIC_DOCS — this build would put it on a public URL.');
  process.exit(1);
}

console.log(`✓ staged ${ASSETS.length} assets + ${PUBLIC_DOCS.length} public docs into public/`);
