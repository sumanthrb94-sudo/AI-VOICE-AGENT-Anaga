// scripts/test-contrast.mjs
//
// Every text/background pair in the design system, measured.
//
// WHY THIS EXISTS. app/globals.css annotates each semantic pair with its
// contrast ratio, and the file's own header says "a ratio nobody checked is a
// ratio that drifts". The first set of those annotations was computed by hand
// and TWO OF THEM WERE WRONG — --color-text-faint was documented at 4.6:1 and
// actually measured 3.3:1, i.e. it failed the 4.5:1 floor the same file
// declares. A comment asserting a number is not a check; this is.
//
// Run: node scripts/test-contrast.mjs

import assert from 'node:assert';
import fs from 'node:fs';

const css = fs.readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');

/* ---------------------------------------------------------------- colour */

function srgbToLinear(c) {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  assert.ok(m, `not a 6-digit hex: ${hex}`);
  const n = parseInt(m[1], 16);
  const r = srgbToLinear((n >> 16) & 255);
  const g = srgbToLinear((n >> 8) & 255);
  const b = srgbToLinear(n & 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio, rounded the way the annotations are written. */
function ratio(fg, bg) {
  const a = luminance(fg), b = luminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

/* ------------------------------------------------- read the tokens as CSS */

/** Every `--name: value;` in the file, last definition per block scope. */
function tokensIn(block) {
  const out = {};
  for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    out[m[1]] = m[2].trim();
  }
  return out;
}

function blockAfter(selector) {
  const i = css.indexOf(selector);
  assert.ok(i >= 0, `no ${selector} block in globals.css`);
  const open = css.indexOf('{', i);
  const close = css.indexOf('\n}', open);
  return css.slice(open, close);
}

const ramp = tokensIn(blockAfter('@theme'));
const dark = tokensIn(blockAfter(':root {'));
const light = tokensIn(blockAfter(':root[data-theme="light"]'));

/** Resolve `var(--x)` chains down to a literal hex. */
function resolve(name, scope) {
  let v = scope[name] ?? ramp[name];
  assert.ok(v, `token ${name} is not defined`);
  let guard = 0;
  while (v.startsWith('var(')) {
    const inner = /^var\(\s*(--[a-z0-9-]+)\s*\)$/i.exec(v);
    assert.ok(inner, `cannot resolve ${name}: ${v}`);
    v = scope[inner[1]] ?? ramp[inner[1]];
    assert.ok(v, `token ${inner[1]} (via ${name}) is not defined`);
    assert.ok(++guard < 10, `var() cycle at ${name}`);
  }
  return v;
}

/* ----------------------------------------------------------------- tests */

let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓', name); }
  catch (e) { fail++; failures.push(`${name}: ${e.message}`); console.log('  ✗', name, '\n     ', e.message); }
}

// WCAG AA: 4.5:1 for normal text, 3:1 for large text and for non-text
// indicators. Everything below is used at normal size somewhere, so 4.5 is the
// floor for all of it.
const AA = 4.5;
const AA_LARGE = 3;

const SURFACES = ['--color-bg', '--color-surface', '--color-elevated'];
const TEXTS = ['--color-text', '--color-text-dim', '--color-text-faint'];

console.log('\n═══ CONTRAST ═══\n');

for (const [theme, scope] of [['dark', dark], ['light', light]]) {
  console.log(`─── ${theme} ───`);
  for (const text of TEXTS) {
    for (const surface of SURFACES) {
      t(`${theme}: ${text.replace('--color-', '')} on ${surface.replace('--color-', '')}`, () => {
        const r = ratio(resolve(text, scope), resolve(surface, scope));
        assert.ok(r >= AA, `${r}:1 — below the ${AA}:1 floor this system declares`);
      });
    }
  }

  // The accent carries links and small labels, so it is held to text contrast
  // too — this is the pair that was wrong in the very first version of the
  // light palette, where the dark-mode amber measured 2.1:1 on white.
  for (const surface of SURFACES) {
    t(`${theme}: accent on ${surface.replace('--color-', '')}`, () => {
      const r = ratio(resolve('--color-accent', scope), resolve(surface, scope));
      assert.ok(r >= AA, `${r}:1 — accent is used for link text, so it needs ${AA}:1`);
    });
  }

  // Status colours appear as text next to their own word ("Blocked", "Opt-out")
  // and never as colour alone, but the word still has to be readable.
  for (const status of ['--color-ok', '--color-warn', '--color-bad']) {
    t(`${theme}: ${status.replace('--color-', '')} on bg`, () => {
      const r = ratio(resolve(status, scope), resolve('--color-bg', scope));
      assert.ok(r >= AA, `${r}:1 — status text must be readable, not just visible`);
    });
  }

  // The one pair that is a FILL: text sitting on the brand button.
  t(`${theme}: on-accent on the accent fill`, () => {
    const r = ratio(resolve('--color-on-accent', scope), resolve('--color-accent-fill', scope));
    assert.ok(r >= AA, `${r}:1 — button labels are normal-size text`);
  });

  // TWO BARS, because these are two different jobs.
  //
  // --color-line separates a card from the page. It is decoration, and WCAG
  // asks nothing of it; it only has to be visible at all.
  //
  // --color-line-strong is the EDGE OF A CONTROL — an input, a secondary
  // button, a focusable tile. WCAG 1.4.11 requires 3:1 for non-text UI
  // boundaries, because a control whose edge you cannot find is a control you
  // cannot use. Both were drawn with the decorative 1.24:1 line until this
  // test separated them.
  t(`${theme}: decorative line is at least visible`, () => {
    const r = ratio(resolve('--color-line', scope), resolve('--color-surface', scope));
    assert.ok(r >= 1.2, `${r}:1 — a border nobody can see is not a border`);
  });

  t(`${theme}: control boundary meets ${AA_LARGE}:1 (WCAG 1.4.11)`, () => {
    const r = ratio(resolve('--color-line-strong', scope), resolve('--color-surface', scope));
    assert.ok(r >= AA_LARGE, `${r}:1 — the edge of an input must be findable`);
  });
}

/* --------------------------------------------- the annotations must be true */

console.log('\n─── the comments in globals.css ───');

t('every documented ratio matches the measured one', () => {
  // Annotations look like:  --color-text-dim: var(--color-ink-300);  /* 7.1:1 on bg */
  // A comment that claims a number is a claim, and a wrong one is worse than
  // none — it is the reason somebody stops re-checking.
  const claims = [...css.matchAll(/(--color-[a-z-]+)\s*:\s*[^;]+;\s*\/\*\s*([\d.]+):1([^*]*)\*\//g)];
  assert.ok(claims.length >= 4, `expected several annotated pairs, found ${claims.length}`);

  const wrong = [];
  for (const [, token, claimed, note] of claims) {
    const scope = /white|on brand-600/.test(note) ? light : dark;
    // Work out what the note says it is measured AGAINST.
    let against = null;
    if (/on bg\b/.test(note)) against = resolve('--color-bg', scope);
    else if (/on ink-950/.test(note)) against = ramp['--color-ink-950'];
    else if (/on white/.test(note)) against = '#ffffff';
    else if (/on brand-500/.test(note)) against = ramp['--color-brand-500'];
    else if (/on brand-600/.test(note)) against = ramp['--color-brand-600'];
    if (!against) continue;

    const actual = ratio(resolve(token, scope), against);
    // Allow a little rounding slack, but not a whole point.
    if (Math.abs(actual - Number(claimed)) > 0.15) {
      wrong.push(`${token}: comment says ${claimed}:1, measured ${actual}:1${note.trim() ? ` (${note.trim()})` : ''}`);
    }
  }
  assert.deepEqual(wrong, [], `\n     ${wrong.join('\n     ')}`);
});

console.log(`\n═══ ${pass} passed, ${fail} failed ═══\n`);
if (fail) { failures.forEach((f) => console.log('  FAIL ' + f)); process.exit(1); }
