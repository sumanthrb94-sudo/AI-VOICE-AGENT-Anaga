// scripts/voicestudio-voices.mjs
//
// List the voice profiles on a self-hosted VoiceStudio box and print the env
// lines to pin them. Run this after standing the box up and cloning a voice.
//
//   VOICESTUDIO_URL=http://127.0.0.1:3900 node scripts/voicestudio-voices.mjs
//
// Optionally audition one, so you hear it before it ever speaks to a prospect:
//
//   VOICESTUDIO_URL=... node scripts/voicestudio-voices.mjs --say <profile-id>
//   VOICESTUDIO_URL=... node scripts/voicestudio-voices.mjs --say <id> --lang hi
//
// Why this exists: the TTS adapters REFUSE a gender with no pinned profile id
// rather than synthesizing against whatever voice happens to be available. That
// refusal is only useful if pinning one is easy, and the ids are opaque.

import fs from 'node:fs';

const BASE = String(process.env.VOICESTUDIO_URL || '').replace(/\/+$/, '');
if (!BASE) {
  console.error('VOICESTUDIO_URL is not set.\n' +
    '  VOICESTUDIO_URL=http://127.0.0.1:3900 node scripts/voicestudio-voices.mjs');
  process.exit(1);
}

const headers = {};
if (process.env.VOICESTUDIO_API_KEY) headers.Authorization = `Bearer ${process.env.VOICESTUDIO_API_KEY}`;

const args = process.argv.slice(2);
const argOf = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const sayId = argOf('--say');
const lang = argOf('--lang') || 'en';

async function get(path) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(BASE + path, { headers, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  } finally { clearTimeout(timer); }
}

// ---------------------------------------------------------------------------
// audition
// ---------------------------------------------------------------------------
const SAMPLES = {
  en: "Namaste! This is Anaga, an A I assistant from Modcon Builders. Do you have a quick minute to talk?",
  hi: 'नमस्ते, मैं अनघा हूँ, वाक की एक ए आई वॉइस असिस्टेंट। क्या मैं आपसे दो मिनट बात कर सकती हूँ?',
  te: 'నమస్కారం, నేను అనగా, మోడ్‌కాన్ బిల్డర్స్ నుండి ఒక ఏఐ వాయిస్ అసిస్టెంట్. మీకు కొన్ని నిమిషాలు ఉంటే మాట్లాడొచ్చా?',
};

if (sayId) {
  const out = `/tmp/voicestudio-${sayId.replace(/[^\w.-]/g, '_')}-${lang}.wav`;
  const res = await fetch(`${BASE}/v1/audio/speech`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.VOICESTUDIO_MODEL || 'tts-1',
      input: SAMPLES[lang] || SAMPLES.en,
      voice: sayId,
      response_format: 'wav',
      language: lang,
    }),
  });
  if (!res.ok) { console.error(`synthesis failed: HTTP ${res.status}`); process.exit(1); }
  fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
  console.log(`wrote ${out}`);
  console.log('Listen to it before this voice ever speaks to a prospect.');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------
let data;
try {
  data = await get('/v1/audio/voices');
} catch (err) {
  console.error(`Could not reach VoiceStudio at ${BASE} — ${err.message}`);
  console.error('Is the container up?  docker compose -f deploy/voicestudio/docker-compose.yml --profile gpu ps');
  process.exit(1);
}

const voices = Array.isArray(data?.voices) ? data.voices : [];
if (!voices.length) {
  console.log('No voices yet. Clone one in the VoiceStudio UI (3 seconds of reference audio),');
  console.log('then run this again.');
  process.exit(0);
}

console.log(`\n${voices.length} voice(s) on ${BASE}\n`);
for (const v of voices) {
  const id = v.voice_id || v.id || '(no id)';
  console.log(`  ${String(v.type || 'voice').padEnd(9)} ${String(id).padEnd(38)} ${v.name || ''}`);
}

const profiles = voices.filter((v) => v.type === 'profile');
console.log('\n─── pin these in the environment ───');
if (profiles.length) {
  console.log(`  VOICESTUDIO_VOICE_FEMALE=${profiles[0].voice_id || profiles[0].id}`);
  console.log(`  VOICESTUDIO_VOICE_MALE=${(profiles[1] || profiles[0]).voice_id || (profiles[1] || profiles[0]).id}`);
  console.log('\n  ⚠️ Those two lines are a GUESS at which clone is which — this endpoint');
  console.log('     does not report gender. Audition each one before pinning it:');
  console.log(`       node scripts/voicestudio-voices.mjs --say ${profiles[0].voice_id || profiles[0].id}`);
  console.log('     A male preset serving a female clone is exactly the failure the');
  console.log('     adapters refuse to make on their own — do not recreate it here.');
} else {
  console.log('  (no cloned profiles yet — clone a voice in the UI first)');
}
console.log();
