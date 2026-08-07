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
//   sarvam     Sarvam Bulbul. Strong Indic prosody, female speakers only in the
//              set we use.
//
// TTS_PROVIDER is a comma-separated CHAIN, tried in order (default
// "voicestudio,google,gtranslate,sarvam"). The chain exists because of a real
// incident: one provider hiccup used to drop the whole call to the robotic
// on-device browser voice, silently, for the rest of the session. Now a failure
// costs one hop. voicestudio leads because when it is configured it is both the
// cheapest per call and the only one whose audio stays on our own hardware — and
// it is inert until VOICESTUDIO_URL is set, so leading with it changes nothing
// on a deployment that has not stood one up.
//
// ⚠️ Vendor voice ids drift. Sarvam speaker names and Google voice names both
// get renamed between releases. Google voices are therefore resolved from the
// live /v1/voices catalogue rather than hardcoded; the static lists below are
// only preferences.

import { chunk } from './translate.js';

const SARVAM_URL = 'https://api.sarvam.ai/text-to-speech';
const GOOGLE_TTS_URL = 'https://texttospeech.googleapis.com/v1/text:synthesize';
const GOOGLE_VOICES_URL = 'https://texttospeech.googleapis.com/v1/voices';
const GTRANSLATE_TTS_URL = 'https://translate.googleapis.com/translate_tts';

// female Bulbul v2 speakers used by the UI voices
const SARVAM_SPEAKERS = ['anushka', 'manisha', 'vidya', 'arya'];

// The Google Translate endpoint truncates long text; it is built for a phrase.
const GTRANSLATE_CHUNK = 190;

const DEFAULT_CHAIN = 'voicestudio,google,gtranslate,sarvam';

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
  // gtranslate has one voice per language; every Sarvam speaker we use is female.
  return !male && providerReady(name);
}

/** True when at least one provider in the chain can run. */
export function ttsAvailable() {
  return providerChain().some(providerReady);
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
      if (provider === 'voicestudio') return await viaVoiceStudio(text, opts);
      if (provider === 'google') return await viaGoogle(text, opts);
      if (provider === 'gtranslate') return await viaGoogleTranslate(text, opts);
      if (provider === 'sarvam') return await viaSarvam(text, opts);
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
    text: text.slice(0, 1500),
    target_language_code: normalizeLang(opts.lang),
    speaker: spk,
    model: process.env.SARVAM_TTS_MODEL || 'bulbul:v2',
    pitch: clamp(opts.pitch, -1, 1, 0),
    pace: clamp(opts.pace, 0.3, 3, 1.0),
    loudness: clamp(opts.loudness, 0.1, 3, 1.0),
    speech_sample_rate: 22050,
    enable_preprocessing: true,
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  let res;
  try {
    res = await fetch(SARVAM_URL, {
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
  const data = await res.json();
  const audio = data && (Array.isArray(data.audios) ? data.audios[0] : data.audio);
  if (!audio) throw new Error('sarvam_tts_empty');
  return { audio, mime: 'audio/wav', provider: 'sarvam', voice: spk, gender: 'female' };
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
