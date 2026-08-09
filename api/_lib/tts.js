// api/_lib/tts.js
//
// Text-to-speech — provider-abstracted. Keys live ONLY here (server-side env),
// never in the browser. Every provider returns { audio: base64, mime } behind
// the same synth() call, so nothing above this file knows who spoke.
//
// ── PROVIDERS ─────────────────────────────────────────────────────────────
//   voicestudio Self-hosted VoiceStudio (github.com/debpalash/VoiceStudio) via
//              its OpenAI-compatible /v1/audio/speech. Cloned voices, either
//              gender, Hindi/Telugu/Tamil/Kannada/Marathi/Bengali, no
//              per-character cost, and the audio never leaves infrastructure we
//              control — which is the data-residency requirement in
//              docs/COMPLIANCE.md, not merely a saving. Needs a GPU host.
//              ⚠️ LICENSE: VoiceStudio is AGPL-3.0-only. We call it over its
//              documented network API and copy none of its source, which its
//              own licence notice covers as ordinary commercial use. Do NOT
//              vendor its code into this repo — that is what would pull the
//              AGPL network clause over our server. Read
//              engineering/VOICESTUDIO_REFERENCE.md before touching this.
//   google     Cloud Text-to-Speech. Needs GOOGLE_API_KEY (or the service
//              account) AND the Text-to-Speech API enabled on the project.
//   gtranslate The voice translate.google.com speaks with. No key, no project,
//              no billing — it works on a fresh deploy. ONE voice per language,
//              so it cannot honour a male request. Undocumented endpoint: treat
//              it as a floor, not a promise.
//   sarvam     Sarvam Bulbul, v3 by default. Indic-native and Indian data
//              residency. v3 is the reason to be here rather than v2: Sarvam's
//              own evaluation puts it first at 8kHz TELEPHONY — which is the
//              call leg, not the demo — it is trained on the code-mixed,
//              numeric and named-entity text these conversations are made of,
//              and it ships 30+ voices against v2's seven. SARVAM_TTS_MODEL
//              pins it back to bulbul:v2 if v3 ever regresses.
//   indicf5    Self-hosted AI4Bharat IndicF5 — 11 Indian languages INCLUDING
//              Telugu, reference-audio voice cloning, no per-character cost.
//              Needs a GPU host. This is the open-source option, and it is
//              IndicF5 rather than the better-known Fish-Speech or GPT-SoVITS
//              for one disqualifying reason: neither of those officially
//              supports Telugu or Hindi, so on this product they are a GPU
//              bill for languages we do not sell in.
//
// TTS_PROVIDER is a comma-separated CHAIN, tried in order (default
// "sarvam,google,indicf5,voicestudio,gtranslate"). The chain exists because of a real
// incident: one provider hiccup used to drop the whole call to the robotic
// on-device browser voice, silently, for the rest of the session. Now a failure
// costs one hop. The order is a COST decision — cheapest per call first — and
// every provider is inert until its own env is set, so the order changes
// nothing on a deployment that has only configured one of them.
//
// gtranslate is LAST and must stay last: it needs no credential, so anywhere it
// sits in the chain, nothing after it is ever reached. See DEFAULT_CHAIN.
//
// ⚠️ Vendor voice ids drift. Sarvam speaker names and Google voice names both
// get renamed between releases. Google voices are therefore resolved from the
// live /v1/voices catalogue rather than hardcoded; the static lists below are
// only preferences.

import { chunk } from './translate.js';

// The STREAM endpoint returns MP3 as it is generated; the batch one returns a
// base64 WAV only once the whole clip exists. Measured on the same sentence:
//   stream  ttfb 1.02s  total 1.44s   52 KB
//   batch   ttfb 1.20s  total 1.85s  204 KB
// ~400ms off the total and a quarter of the bytes, which matters most on a
// phone. Set SARVAM_STREAM=0 to fall back to the batch endpoint.
const SARVAM_URL = 'https://api.sarvam.ai/text-to-speech';
const SARVAM_STREAM_URL = 'https://api.sarvam.ai/text-to-speech/stream';
const GOOGLE_TTS_URL = 'https://texttospeech.googleapis.com/v1/text:synthesize';
const GOOGLE_VOICES_URL = 'https://texttospeech.googleapis.com/v1/voices';
const GTRANSLATE_TTS_URL = 'https://translate.googleapis.com/translate_tts';

// Speakers, probed against the live API rather than copied from docs. The list
// used to hold only the four female voices, which is why this file claimed
// Sarvam could never speak as a man and why the male preset was told to go and
// enable Google Cloud TTS. It can: abhilash, karun and hitesh are male and work
// in en-IN, hi-IN and te-IN.
//
// ⚠️ THESE ARE THE v2 SPEAKERS AND THE DEFAULT MODEL IS NOW v3. Sarvam say v3
// ships 30+ voices; their names have NOT been probed from here (egress to
// api.sarvam.ai is blocked in this environment), so the allowlist below is
// still v2's and the extra voices are unreachable until somebody probes them.
// SARVAM_SPEAKERS overrides it without a deploy, and the probe is one loop over
// candidate names against /text-to-speech — the same way this list was built.
const SARVAM_SPEAKERS = (process.env.SARVAM_SPEAKERS || 'anushka,manisha,vidya,arya,abhilash,karun,hitesh')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const SARVAM_MALE_SPEAKERS = ['abhilash', 'karun', 'hitesh'];

// The Google Translate endpoint truncates long text; it is built for a phrase.
const GTRANSLATE_CHUNK = 190;

// Ordered BEST FIRST, with the keyless fallback LAST.
//
// This was 'voicestudio,google,gtranslate,sarvam', which was a real regression
// on a live site: gtranslate needs no credential, so it always succeeds, so
// Sarvam was never reached. Production served the free Google Translate voice
// for every line while a paid Sarvam key sat configured and unused — the same
// voice this file's own header calls "a floor, not a promise". A fallback
// ordered above the thing it is a fallback FOR is not a fallback.
//
// Verified on the deployment: POST /api/tts returned provider "gtranslate"
// with SARVAM_API_KEY set.
// ORDER IS A COST DECISION, not a quality one, and it is set deliberately:
//   sarvam     cheapest per character, and Indic-native
//   google     next cheapest, and the only one with a guaranteed male voice
//   indicf5    self-hosted AI4Bharat — no per-character cost once the box is
//              paid for, but a box has to exist and be warm. Ahead of
//              voicestudio because it is the one that speaks Telugu.
//   voicestudio the other self-hosted option, kept so an existing deployment
//              that stood one up does not silently lose its voice
//   gtranslate free, keyless, and the worst. LAST, always: anything after a
//              provider that cannot fail is unreachable.
const DEFAULT_CHAIN = 'sarvam,google,indicf5,voicestudio,gtranslate';

const clamp = (n, lo, hi, d) => { n = Number(n); return Number.isNaN(n) ? d : Math.max(lo, Math.min(hi, n)); };

export function providerChain() {
  return String(process.env.TTS_PROVIDER || DEFAULT_CHAIN)
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/** Can a given provider run at all on this deployment? */
export function providerReady(name) {
  if (name === 'sarvam') return Boolean(process.env.SARVAM_API_KEY);
  if (name === 'gtranslate') return true;                      // needs nothing
  if (name === 'voicestudio') return Boolean(process.env.VOICESTUDIO_URL);
  if (name === 'indicf5') return Boolean(process.env.INDICF5_URL);
  if (name === 'google') {
    return Boolean(process.env.GOOGLE_API_KEY || process.env.GOOGLE_SERVICE_ACCOUNT || process.env.FIREBASE_SERVICE_ACCOUNT);
  }
  return false;
}

/**
 * Which providers can serve a given gender.
 *
 * VoiceStudio can do either, but only for a voice profile someone actually
 * cloned and pinned in env — the engine will happily synthesize *something*
 * otherwise, and "something" is how a male preset ends up sounding like a woman
 * with nobody noticing. A gender is claimed only when there is a concrete
 * profile id behind it.
 */
export function genderReady(name, gender) {
  const male = String(gender).toLowerCase() === 'male';
  if (name === 'google') return providerReady('google');       // resolves by ssmlGender
  if (name === 'voicestudio') {
    if (!providerReady('voicestudio')) return false;
    return Boolean(male ? process.env.VOICESTUDIO_VOICE_MALE : process.env.VOICESTUDIO_VOICE_FEMALE);
  }
  // IndicF5 clones whatever reference clip it is pointed at, so a gender is
  // only claimed when a reference for it is actually configured. Same rule as
  // VoiceStudio, same reason: the model will happily synthesize SOMETHING for
  // a missing reference, and "something" is how a male preset ends up sounding
  // like a woman with nobody noticing.
  if (name === 'indicf5') {
    if (!providerReady('indicf5')) return false;
    return Boolean(male ? process.env.INDICF5_VOICE_MALE : process.env.INDICF5_VOICE_FEMALE);
  }
  // Sarvam has male speakers (probed live: abhilash, karun, hitesh), so it is
  // male-capable. gtranslate genuinely is not — one voice per language.
  if (name === 'sarvam') return providerReady('sarvam');
  return !male && providerReady(name);
}

/** True when at least one provider in the chain can run. */
export function ttsAvailable() {
  return providerChain().some(providerReady);
}

/**
 * Is the self-hosted box actually up? Configured and reachable are different
 * facts: a VOICESTUDIO_URL pointing at a stopped container looks identical to a
 * working one until the first call needs audio. Never throws.
 */
export async function voiceStudioHealth() {
  const base = String(process.env.VOICESTUDIO_URL || '').replace(/\/+$/, '');
  if (!base) return { configured: false, reachable: false };

  const headers = {};
  if (process.env.VOICESTUDIO_API_KEY) headers.Authorization = `Bearer ${process.env.VOICESTUDIO_API_KEY}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(`${base}/v1/audio/voices`, { headers, signal: ctrl.signal });
    if (!res.ok) return { configured: true, reachable: false, error: `http_${res.status}` };
    const data = await res.json();
    return {
      configured: true,
      reachable: true,
      // Count only — voice ids can carry a person's name, and this endpoint is
      // read by anyone with the operator key.
      voices: Array.isArray(data?.voices) ? data.voices.length : 0,
      male: Boolean(process.env.VOICESTUDIO_VOICE_MALE),
      female: Boolean(process.env.VOICESTUDIO_VOICE_FEMALE),
    };
  } catch (err) {
    return { configured: true, reachable: false, error: err?.name === 'AbortError' ? 'timeout' : 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

/** For the health endpoint and the /api/tts probe. */
export function ttsStatus() {
  const chain = providerChain();
  return {
    available: chain.some(providerReady),
    chain,
    ready: chain.filter(providerReady),
    // Whether ANY provider in the chain can genuinely speak as a man. Saying so
    // up front beats shipping a "male" preset that quietly returns a woman.
    maleCapable: chain.some((p) => genderReady(p, 'male')),
  };
}

// ---------------------------------------------------------------------------
// synth
// ---------------------------------------------------------------------------

/**
 * synth({ text, lang, speaker, gender, voice, pitch, pace, loudness })
 *   -> { audio, mime, provider, voice, gender }
 *
 * `gender` is a request ("male" | "female"); the returned `gender` is what was
 * actually served. They differ when the male-capable provider is unavailable,
 * and the caller is expected to surface that rather than paper over it.
 */
export async function synth(opts = {}) {
  const text = String(opts.text || '').trim();
  if (!text) throw new Error('tts_text_required');

  const chain = providerChain().filter(providerReady);
  if (!chain.length) throw new Error('tts_unavailable');

  const errors = [];
  for (const provider of chain) {
    try {
      let out;
      if (provider === 'voicestudio') out = await viaVoiceStudio(text, opts);
      else if (provider === 'google') out = await viaGoogle(text, opts);
      else if (provider === 'gtranslate') out = await viaGoogleTranslate(text, opts);
      else if (provider === 'sarvam') out = await viaSarvam(text, opts);
      else if (provider === 'indicf5') out = await viaIndicF5(text, opts);
      else continue;

      // A FALLBACK IS NOT A SUCCESS, even though the response is a 200.
      //
      // This loop used to swallow `errors` whenever any later provider worked.
      // So a deployment whose premium voice was failing on every single request
      // — expired key, revoked key, quota exhausted — served the free fallback
      // voice to every caller while looking perfectly healthy: 200s in the log,
      // nothing in the error stream, and the readiness probe still reporting
      // the premium provider as "ready", because readiness is only "is the
      // environment variable set".
      //
      // The symptom reaching a human is "the voice sounds terrible", which is
      // a sentence with no stack trace attached. Carry the failures out so the
      // handler can say WHICH provider dropped out and why.
      if (errors.length) out.fellBackFrom = errors;
      return out;
    } catch (err) {
      errors.push(`${provider}: ${err?.message || 'failed'}`);
    }
  }
  const e = new Error('tts_all_providers_failed');
  e.detail = errors.join(' | ');
  throw e;
}

// ---------------------------------------------------------------------------
// voicestudio — self-hosted, OpenAI-compatible
// ---------------------------------------------------------------------------
//
// Speaks POST /v1/audio/speech, so this is the same shape as any OpenAI audio
// client. Pin cloned profile ids per gender:
//
//   VOICESTUDIO_URL          http://10.0.0.4:3900   (no trailing slash needed)
//   VOICESTUDIO_API_KEY      optional — loopback is unauthenticated by default
//   VOICESTUDIO_MODEL        default "tts-1" (whatever engine is active there)
//   VOICESTUDIO_VOICE_FEMALE cloned profile id, from GET /v1/audio/voices
//   VOICESTUDIO_VOICE_MALE   ditto
//
// A gender with no profile id is REFUSED rather than approximated, so the chain
// moves to a provider that can actually do it. Every engine will synthesize
// *something* for an unknown voice, and that something is how "Arjun" ends up
// sounding like a woman.

// ---------------------------------------------------------------------------
// indicf5 — self-hosted AI4Bharat, the open-source option
// ---------------------------------------------------------------------------
//
// IndicF5 covers 11 Indian languages INCLUDING TELUGU, which is the reason it
// is here and the reason the obvious open-source picks are not: Fish-Speech and
// GPT-SoVITS are excellent and neither officially supports Telugu or Hindi, so
// on this product they would be a GPU bill for a language we do not sell in.
//
// It is a reference-audio cloning model: it needs a voice clip and that clip's
// transcript, not a voice id. Shipping a WAV on every request would be absurd,
// so the references live ON THE SERVER under names, and we send the name. The
// server contract is ours and is implemented in deploy/indicf5/ —
//
//   POST {INDICF5_URL}/tts
//     { text, language, voice, sample_rate }  ->  audio/wav bytes
//
// ⚠️ VERIFICATION: this adapter has never run against a live box. It is written
// against the contract in deploy/indicf5/, and that server is written against
// AI4Bharat's documented inference call. Treat both as unproven until a real
// GPU has answered one request — exactly the status the VoiceStudio path has.
//
// LICENCE: the model card requires that you only clone voices you have explicit
// permission to clone. A reference clip of a person who did not agree is not a
// configuration detail, it is the thing that makes this unlawful.
async function viaIndicF5(text, opts) {
  const base = String(process.env.INDICF5_URL || '').replace(/\/+$/, '');
  if (!base) throw new Error('indicf5_not_configured');

  const wantMale = String(opts.gender || 'female').toLowerCase() === 'male';
  const voice = wantMale ? process.env.INDICF5_VOICE_MALE : process.env.INDICF5_VOICE_FEMALE;
  if (!voice) throw new Error(`indicf5_no_${wantMale ? 'male' : 'female'}_voice`);

  const headers = { 'Content-Type': 'application/json' };
  if (process.env.INDICF5_API_KEY) headers.Authorization = `Bearer ${process.env.INDICF5_API_KEY}`;

  const ctrl = new AbortController();
  // Longer than the hosted vendors on purpose: a cold GPU loading weights is
  // the normal first request, and killing it at 8s means the box never gets to
  // warm up and the provider looks permanently broken.
  const timer = setTimeout(() => ctrl.abort(), Number(process.env.INDICF5_TIMEOUT_MS || 30000));
  let res;
  try {
    res = await fetch(`${base}/tts`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        text: text.slice(0, 2000),
        language: shortLang(opts.lang),
        voice,
        sample_rate: Number(process.env.INDICF5_SAMPLE_RATE || 24000),
      }),
      signal: ctrl.signal,
    });
  } catch (err) {
    throw new Error(err?.name === 'AbortError' ? 'indicf5_timeout' : 'indicf5_unreachable');
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) throw new Error(`indicf5_tts_${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('indicf5_tts_empty');

  return {
    audio: buf.toString('base64'),
    mime: 'audio/wav',
    provider: 'indicf5',
    voice,
    gender: wantMale ? 'male' : 'female',
  };
}

async function viaVoiceStudio(text, opts) {
  const base = String(process.env.VOICESTUDIO_URL || '').replace(/\/+$/, '');
  if (!base) throw new Error('voicestudio_not_configured');

  const wantMale = String(opts.gender || 'female').toLowerCase() === 'male';
  const profile = wantMale ? process.env.VOICESTUDIO_VOICE_MALE : process.env.VOICESTUDIO_VOICE_FEMALE;
  if (!profile) throw new Error(`voicestudio_no_${wantMale ? 'male' : 'female'}_voice`);

  const headers = { 'Content-Type': 'application/json' };
  if (process.env.VOICESTUDIO_API_KEY) headers.Authorization = `Bearer ${process.env.VOICESTUDIO_API_KEY}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Number(process.env.VOICESTUDIO_TIMEOUT_MS || 25000));
  let res;
  try {
    res = await fetch(`${base}/v1/audio/speech`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: process.env.VOICESTUDIO_MODEL || 'tts-1',
        input: text.slice(0, 4096),           // the endpoint's documented cap
        voice: profile,
        response_format: 'mp3',
        speed: clamp(opts.pace, 0.25, 4, 1),  // its own accepted range
        language: shortLang(opts.lang),
      }),
      signal: ctrl.signal,
    });
  } catch (err) {
    // A self-hosted box that is down or cold is the normal failure here, and it
    // must read as "try the next provider", not as an outage.
    throw new Error(err?.name === 'AbortError' ? 'voicestudio_timeout' : 'voicestudio_unreachable');
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) throw new Error(`voicestudio_tts_${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('voicestudio_tts_empty');

  return {
    audio: buf.toString('base64'),
    mime: 'audio/mpeg',
    provider: 'voicestudio',
    voice: profile,
    gender: wantMale ? 'male' : 'female',
  };
}

// ---------------------------------------------------------------------------
// google — Cloud Text-to-Speech
// ---------------------------------------------------------------------------

// Preference, best first. Only hints: whatever the live catalogue offers wins.
const GOOGLE_TIERS = ['Chirp3-HD', 'Neural2', 'Wavenet', 'Standard'];

let voiceCatalogue = { at: 0, byLang: new Map() };
const VOICE_TTL_MS = 12 * 60 * 60 * 1000;

async function googleVoices(languageCode) {
  const now = Date.now();
  if (now - voiceCatalogue.at > VOICE_TTL_MS) voiceCatalogue = { at: now, byLang: new Map() };
  if (voiceCatalogue.byLang.has(languageCode)) return voiceCatalogue.byLang.get(languageCode);

  const { googleFetch } = await import('./google.js');
  const data = await googleFetch(`${GOOGLE_VOICES_URL}?languageCode=${encodeURIComponent(languageCode)}`);
  const voices = Array.isArray(data?.voices) ? data.voices : [];
  voiceCatalogue.byLang.set(languageCode, voices);
  return voices;
}

/**
 * Resolve a concrete voice name for (language, gender). Returns null when the
 * catalogue is unreachable — the caller then asks Google to pick by ssmlGender,
 * which still honours the gender without us naming a voice.
 */
export async function resolveGoogleVoice(languageCode, gender, preferred) {
  let voices;
  try { voices = await googleVoices(languageCode); }
  catch { return null; }

  const want = String(gender || 'female').toUpperCase() === 'MALE' ? 'MALE' : 'FEMALE';
  const matching = voices.filter((v) => v.ssmlGender === want);
  if (!matching.length) return null;

  if (preferred) {
    const exact = matching.find((v) => v.name === preferred);
    if (exact) return exact.name;
  }
  for (const tier of GOOGLE_TIERS) {
    const hit = matching.find((v) => v.name.includes(tier));
    if (hit) return hit.name;
  }
  return matching[0].name;
}

async function viaGoogle(text, opts) {
  const { googleFetch } = await import('./google.js');
  const languageCode = normalizeLang(opts.lang);
  const wantMale = String(opts.gender || 'female').toLowerCase() === 'male';
  const ssmlGender = wantMale ? 'MALE' : 'FEMALE';

  const name = await resolveGoogleVoice(languageCode, ssmlGender, opts.voice);
  const voice = name ? { languageCode, name } : { languageCode, ssmlGender };

  const data = await googleFetch(GOOGLE_TTS_URL, {
    method: 'POST',
    body: {
      input: { text: text.slice(0, 4500) },
      voice,
      audioConfig: {
        audioEncoding: 'MP3',
        // Our normalized scales -> Google's. pitch is semitones (-20..20);
        // speakingRate is a multiplier; volumeGainDb is decibels.
        pitch: clamp(Number(opts.pitch || 0) * 8, -20, 20, 0),
        speakingRate: clamp(opts.pace, 0.25, 4, 1),
        volumeGainDb: clamp(20 * Math.log10(clamp(opts.loudness, 0.1, 3, 1)), -96, 16, 0),
        sampleRateHertz: 24000,
      },
    },
  });

  if (!data?.audioContent) throw new Error('google_tts_empty');
  return {
    audio: data.audioContent,
    mime: 'audio/mpeg',
    provider: 'google',
    voice: name || `${languageCode}/${ssmlGender}`,
    gender: wantMale ? 'male' : 'female',
  };
}

// ---------------------------------------------------------------------------
// gtranslate — the voice on translate.google.com. No key, one voice per language.
// ---------------------------------------------------------------------------

async function viaGoogleTranslate(text, opts) {
  const tl = shortLang(opts.lang);
  // The endpoint offers normal or slow, nothing finer. Anything under ~0.85 of
  // normal pace reads as the deliberate "slow" setting.
  const ttsspeed = clamp(opts.pace, 0.25, 4, 1) < 0.85 ? 0.24 : 1;

  const parts = chunk(text, GTRANSLATE_CHUNK);
  const buffers = [];

  for (let i = 0; i < parts.length; i++) {
    const url = `${GTRANSLATE_TTS_URL}?ie=UTF-8&client=tw-ob&ttsspeed=${ttsspeed}` +
      `&tl=${encodeURIComponent(tl)}&total=${parts.length}&idx=${i}` +
      `&textlen=${parts[i].length}&q=${encodeURIComponent(parts[i])}`;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    let res;
    try {
      // redirect:'manual' — a 302 here is Google's /sorry/ bot check, not a
      // move. Following it would report a failure on a host we never called.
      res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VaakVoice/1.0)', Referer: 'https://translate.google.com/' },
        redirect: 'manual',
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (res.status >= 300 && res.status < 400) throw new Error('gtranslate_tts_rate_limited');
    if (!res.ok) throw new Error(`gtranslate_tts_${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error('gtranslate_tts_empty');
    buffers.push(buf);
  }

  // MP3 frames are self-delimiting, so concatenating chunk responses plays as
  // one clip in every browser decoder we target.
  return {
    audio: Buffer.concat(buffers).toString('base64'),
    mime: 'audio/mpeg',
    provider: 'gtranslate',
    voice: `translate/${tl}`,
    // Deliberately not echoing the request. This endpoint has one voice per
    // language and it is not a man's; claiming otherwise would make the UI lie.
    gender: 'female',
  };
}

// ---------------------------------------------------------------------------
// sarvam — Bulbul v2
// ---------------------------------------------------------------------------

async function viaSarvam(text, opts) {
  const key = process.env.SARVAM_API_KEY;
  if (!key) throw new Error('sarvam_not_configured');

  const spk = SARVAM_SPEAKERS.includes(String(opts.speaker || '').toLowerCase())
    ? String(opts.speaker).toLowerCase()
    : 'anushka';

  const body = {
    // v3 accepts 2500 per request, up from v2's 1500.
    text: text.slice(0, Number(process.env.SARVAM_MAX_CHARS || 2500)),
    target_language_code: normalizeLang(opts.lang),
    speaker: spk,
    model: process.env.SARVAM_TTS_MODEL || 'bulbul:v3',
    pitch: clamp(opts.pitch, -1, 1, 0),
    pace: clamp(opts.pace, 0.3, 3, 1.0),
    loudness: clamp(opts.loudness, 0.1, 3, 1.0),
    // 22050 was leaving quality on the table: bulbul:v2 accepts up to 48000
    // (probed). The browser plays whatever it is given, so ask for the good one.
    // The CALL leg overrides this to the telephony rate — see caller-agent.
    speech_sample_rate: Number(process.env.SARVAM_SAMPLE_RATE || 24000),
    enable_preprocessing: true,
  };

  const streaming = process.env.SARVAM_STREAM !== '0';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  let res;
  try {
    res = await fetch(streaming ? SARVAM_STREAM_URL : SARVAM_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-subscription-key': key },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let detail = 'HTTP ' + res.status;
    try { const e = await res.json(); detail = (e && (e.message || e.error)) || detail; } catch { /* ignore */ }
    throw new Error('sarvam_tts_failed: ' + detail);
  }

  // Which gender the chosen speaker actually is — reported, not assumed, so the
  // UI's mismatch warning stays truthful now that Sarvam serves both.
  const gender = SARVAM_MALE_SPEAKERS.includes(spk) ? 'male' : 'female';

  if (streaming) {
    // Raw MP3 bytes, not JSON.
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error('sarvam_tts_empty');
    return { audio: buf.toString('base64'), mime: 'audio/mpeg', provider: 'sarvam', voice: spk, gender };
  }

  const data = await res.json();
  const audio = data && (Array.isArray(data.audios) ? data.audios[0] : data.audio);
  if (!audio) throw new Error('sarvam_tts_empty');
  return { audio, mime: 'audio/wav', provider: 'sarvam', voice: spk, gender };
}

// ---------------------------------------------------------------------------
// language helpers
// ---------------------------------------------------------------------------

/** "hi" | "hi-in" -> "hi-IN". Google and Sarvam both want the regional form. */
export function normalizeLang(lang) {
  const s = String(lang || 'en-IN').trim().replace('_', '-');
  const [base, region] = s.split('-');
  const b = (base || 'en').toLowerCase();
  if (region) return `${b}-${region.toUpperCase()}`;
  const DEFAULT_REGION = { en: 'IN', hi: 'IN', te: 'IN', ta: 'IN', kn: 'IN', ml: 'IN', mr: 'IN', bn: 'IN', gu: 'IN', pa: 'IN' };
  return `${b}-${DEFAULT_REGION[b] || 'IN'}`;
}

/** "hi-IN" -> "hi". The Google Translate voice endpoint wants the bare tag. */
export function shortLang(lang) {
  return normalizeLang(lang).split('-')[0];
}
