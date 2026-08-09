// caller-agent/src/providers/speech.js
//
// STT and TTS adapters (WP-4). Provider-abstracted: the media transport calls
// transcribe()/synth() and never learns which vendor answered.
//
// Providers:
//   sarvam       Saaras STT, Bulbul TTS — the Indic stack this product is built
//                on, and the default.
//   voicestudio  A self-hosted VoiceStudio over its OpenAI-compatible API. The
//                only option whose audio never leaves infrastructure we control,
//                which is the data-residency requirement in docs/COMPLIANCE.md.
//                Also the only one that can speak as a man, and the cheapest per
//                call once the box is paid for.
//                ⚠️ VoiceStudio is AGPL-3.0. We call it over its documented
//                network API and copy none of its source — see
//                engineering/VOICESTUDIO_REFERENCE.md §1 before changing this.
//   mock         Test double.
//
// AI4Bharat/Bhashini slot in behind the same two functions.
//
// ⚠️ VERIFICATION STATUS: the Sarvam TTS path mirrors api/_lib/tts.js, which is
// the code the live web demo uses, so its request shape is exercised. NEITHER
// STT path has been run against real telephony audio (8kHz μ-law from a phone
// line is materially harder than a browser mic), and the VoiceStudio paths have
// never seen a live box at all. Verify sample-rate and encoding handling in the
// WP-1 spike before launch. LAUNCH.md blocker #3 is exactly this.

const SARVAM_TTS_URL = 'https://api.sarvam.ai/text-to-speech';
const SARVAM_STT_URL = 'https://api.sarvam.ai/speech-to-text';

function sarvamKey() {
  const k = process.env.SARVAM_API_KEY;
  if (!k) throw new Error('SARVAM_API_KEY not configured');
  return k;
}

function voiceStudioBase() {
  const u = String(process.env.VOICESTUDIO_URL || '').replace(/\/+$/, '');
  if (!u) throw new Error('VOICESTUDIO_URL not configured');
  return u;
}

function voiceStudioHeaders(extra = {}) {
  const h = { ...extra };
  if (process.env.VOICESTUDIO_API_KEY) h.Authorization = `Bearer ${process.env.VOICESTUDIO_API_KEY}`;
  return h;
}

/** "hi-IN" -> "hi". The OpenAI-compatible endpoints want the bare subtag. */
function shortLang(lang) {
  return String(lang || 'en-IN').trim().split('-')[0].toLowerCase();
}

// ---------------------------------------------------------------------------
// STT
// ---------------------------------------------------------------------------
export function createSTT({ provider = process.env.STT_PROVIDER || 'sarvam' } = {}) {
  if (provider === 'mock') {
    // Test double: audio chunks carry their own text. Lets the whole media
    // path be exercised without a vendor or real audio.
    return {
      id: 'mock',
      async transcribe(chunks) {
        return chunks.map((c) => (Buffer.isBuffer(c) ? c.toString('utf8') : String(c))).join(' ').trim();
      },
    };
  }

  if (provider === 'voicestudio') {
    return {
      id: 'voicestudio',
      async transcribe(chunks, lang) {
        if (!chunks || !chunks.length) return '';
        const pcm = Buffer.concat(chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c))));

        // The transport hands us raw telephony PCM. Whisper-family engines want
        // a container, so wrap it in a WAV header rather than hoping the server
        // guesses the sample rate — at 8kHz a wrong guess does not fail loudly,
        // it just transcribes gibberish.
        const wav = wrapWav(pcm, Number(process.env.TELEPHONY_SAMPLE_RATE || 8000));

        const form = new FormData();
        form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
        form.append('model', process.env.VOICESTUDIO_ASR_MODEL || 'whisper-1');
        form.append('response_format', 'json');
        if (lang) form.append('language', shortLang(lang));

        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), Number(process.env.STT_TIMEOUT_MS || 8000));
        try {
          const res = await fetch(`${voiceStudioBase()}/v1/audio/transcriptions`, {
            method: 'POST',
            headers: voiceStudioHeaders(),
            body: form,
            signal: ctrl.signal,
          });
          if (!res.ok) throw new Error(`voicestudio_stt_${res.status}`);
          const data = await res.json();
          return String(data?.text || '').trim();
        } finally {
          clearTimeout(timer);
        }
      },
    };
  }

  if (provider !== 'sarvam') throw new Error(`unsupported STT_PROVIDER: ${provider}`);

  return {
    id: 'sarvam',
    async transcribe(chunks, lang) {
      if (!chunks || !chunks.length) return '';
      const audio = Buffer.concat(chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c))));

      const form = new FormData();
      form.append('file', new Blob([audio], { type: 'audio/wav' }), 'audio.wav');
      form.append('model', process.env.SARVAM_STT_MODEL || 'saaras:v2');
      form.append('language_code', lang || 'en-IN');

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), Number(process.env.STT_TIMEOUT_MS || 8000));
      try {
        const res = await fetch(SARVAM_STT_URL, {
          method: 'POST',
          headers: { 'api-subscription-key': sarvamKey() },
          body: form,
          signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(`sarvam_stt_${res.status}`);
        const data = await res.json();
        return String(data?.transcript || data?.text || '').trim();
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// TTS
// ---------------------------------------------------------------------------
export function createTTS({ provider = process.env.TTS_PROVIDER || 'sarvam' } = {}) {
  if (provider === 'mock') {
    return {
      id: 'mock',
      async synth(text) {
        // One frame per sentence so barge-in can be tested mid-utterance.
        const frames = String(text).split(/(?<=[.!?])\s+/).filter(Boolean).map((s) => Buffer.from(s, 'utf8'));
        return { frames: frames.length ? frames : [Buffer.from(String(text), 'utf8')], mime: 'audio/mock' };
      },
    };
  }

  if (provider === 'voicestudio') {
    return {
      id: 'voicestudio',
      async synth(text, lang) {
        const gender = String(process.env.TTS_GENDER || 'female').toLowerCase() === 'male' ? 'male' : 'female';
        const profile = gender === 'male'
          ? process.env.VOICESTUDIO_VOICE_MALE
          : process.env.VOICESTUDIO_VOICE_FEMALE;
        // Same refusal as api/_lib/tts.js: an engine will synthesize *something*
        // for an unknown voice, and on a real call nobody gets to check which
        // person it sounded like afterwards.
        if (!profile) throw new Error(`voicestudio_no_${gender}_voice`);

        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), Number(process.env.TTS_TIMEOUT_MS || 8000));
        let res;
        try {
          res = await fetch(`${voiceStudioBase()}/v1/audio/speech`, {
            method: 'POST',
            headers: voiceStudioHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({
              model: process.env.VOICESTUDIO_MODEL || 'tts-1',
              input: String(text).slice(0, 4096),
              voice: profile,
              // WAV, not PCM, on purpose: the header carries the true sample
              // rate. Asking for headerless PCM means guessing what the engine
              // rendered at, and a wrong guess is not a crash — it is a
              // chipmunk on a live call.
              response_format: 'wav',
              language: shortLang(lang),
            }),
            signal: ctrl.signal,
          });
        } finally {
          clearTimeout(timer);
        }
        if (!res.ok) throw new Error(`voicestudio_tts_${res.status}`);

        const wav = Buffer.from(await res.arrayBuffer());
        if (!wav.length) throw new Error('voicestudio_tts_empty');

        const target = Number(process.env.TELEPHONY_SAMPLE_RATE || 8000);
        const audio = toTelephonyPcm(wav, target);
        return { frames: frameAudio(audio, { sampleRate: target }), audio, mime: 'audio/pcm' };
      },
    };
  }

  if (provider !== 'sarvam') throw new Error(`unsupported TTS_PROVIDER: ${provider}`);

  // NOTE ON THE ENDPOINT. api/_lib/tts.js — the browser demo — moved to
  // /text-to-speech/stream, which is ~400ms faster to first byte. The call leg
  // deliberately did NOT follow it: that endpoint returns MP3, and the
  // telephony path needs raw 16-bit PCM at 8kHz, which means decoding MP3 in a
  // repo with zero dependencies. So this stays on the batch endpoint, whose
  // response time scales with the length of the string — which is exactly why
  // the transport splits a line into phrases before calling this (see
  // media/transport.js say()). If Sarvam ever exposes WAV on the stream
  // endpoint, switch and delete this note.
  return {
    id: 'sarvam',
    async synth(text, lang) {
      const body = {
        text: String(text).slice(0, 1500),
        target_language_code: lang || 'en-IN',
        speaker: process.env.TTS_SPEAKER || 'anushka',
        model: process.env.SARVAM_TTS_MODEL || 'bulbul:v2',
        // Telephony is 8kHz. Synthesizing at 22050 and resampling wastes both
        // latency and quality; ask for the rate the phone line actually uses.
        speech_sample_rate: Number(process.env.TELEPHONY_SAMPLE_RATE || 8000),
        enable_preprocessing: true,
      };

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), Number(process.env.TTS_TIMEOUT_MS || 8000));
      try {
        const res = await fetch(SARVAM_TTS_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'api-subscription-key': sarvamKey() },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(`sarvam_tts_${res.status}`);
        const data = await res.json();
        const b64 = Array.isArray(data?.audios) ? data.audios[0] : data?.audio;
        if (!b64) throw new Error('sarvam_tts_empty');

        const audio = Buffer.from(b64, 'base64');
        return { frames: frameAudio(audio), audio, mime: 'audio/wav' };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Phrase splitting — the cheapest second off time-to-first-audio
// ---------------------------------------------------------------------------
//
// Synthesizing a whole line before playing any of it means the prospect waits
// for the LAST word to be rendered before hearing the FIRST. Bulbul takes about
// a second on a two-sentence turn, and that second is silence on a live call.
//
// Split at phrase boundaries and the wait becomes the render time of the first
// phrase only; everything behind it renders while the earlier audio is still
// playing, because playback is paced in real time and there is always far more
// play time than synth time to hide it in.
//
// Boundaries are language-aware in the one way that matters here: Devanagari
// and the Indic scripts end sentences with a danda (।), not a full stop, and a
// splitter that only knows about "." leaves an entire Hindi turn as one chunk.

const SENTENCE_END = /(?<=[.!?।॥])\s+/;
const CLAUSE_END = /(?<=[,;:—–])\s+/;

/**
 * Split text into speakable parts, shortest-first-part biased.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {number} [opts.maxChars]  above this a part is split again at clauses
 * @param {number} [opts.minChars]  below this a part is merged into the next
 * @returns {string[]} always at least one part
 */
export function splitForSpeech(text, { maxChars = 140, minChars = 24 } = {}) {
  const whole = String(text ?? '').trim();
  if (!whole) return [];
  if (whole.length <= minChars) return [whole];

  const parts = [];
  for (const sentence of whole.split(SENTENCE_END)) {
    const s = sentence.trim();
    if (!s) continue;
    // A long sentence still blocks first audio, so break it at clause
    // boundaries. Falls through to the whole sentence when it has none — a
    // hard character split would cut mid-word and Bulbul would pronounce the
    // fragments as two separate words.
    if (s.length <= maxChars) { parts.push(s); continue; }
    let acc = '';
    for (const clause of s.split(CLAUSE_END)) {
      const c = clause.trim();
      if (!c) continue;
      if (acc && (acc.length + c.length + 1) > maxChars) { parts.push(acc); acc = c; }
      else acc = acc ? `${acc} ${c}` : c;
    }
    if (acc) parts.push(acc);
  }

  // Merge runt fragments forward. "Yes." on its own is a whole network round
  // trip to render two syllables, which costs more than it saves.
  const merged = [];
  for (const p of parts) {
    if (merged.length && merged[merged.length - 1].length < minChars) {
      merged[merged.length - 1] = `${merged[merged.length - 1]} ${p}`;
    } else {
      merged.push(p);
    }
  }
  // A trailing runt has nothing to merge into; fold it backwards instead.
  if (merged.length > 1 && merged[merged.length - 1].length < minChars) {
    const tail = merged.pop();
    merged[merged.length - 1] = `${merged[merged.length - 1]} ${tail}`;
  }
  return merged.length ? merged : [whole];
}

// ---------------------------------------------------------------------------
// Synthesis cache
// ---------------------------------------------------------------------------
//
// Several of the lines on every call are CONSTANTS: the AI disclosure that
// opens turn one, the opt-out acknowledgement, the two silence nudges, the
// apology when the brain is down. Paying a second of vendor latency to render
// the same sentence on every call is pure waste, and the opt-out line is
// exactly the one that must not be slow.
//
// The cache is deliberately process-wide rather than per-call: a worker handles
// many calls, so the first call in each language pays and the rest are free.
// Bounded, because audio is not small — the point is a handful of fixed lines,
// not a transcript archive.
export function withSynthCache(tts, { max = Number(process.env.TTS_CACHE_ENTRIES || 24) } = {}) {
  if (!(max > 0)) return tts;
  /** @type {Map<string, object>} */
  const cache = new Map();
  let hits = 0;
  let misses = 0;

  // The speaker is part of the key: the same words in a different voice are
  // different audio, and serving a woman's rendering for a male preset is the
  // kind of bug nobody notices until a prospect does.
  const keyOf = (text, lang) => [
    tts.id, lang || '', process.env.TTS_SPEAKER || '',
    process.env.TELEPHONY_SAMPLE_RATE || '', String(text),
  ].join(' ');

  return {
    ...tts,
    async synth(text, lang) {
      const key = keyOf(text, lang);
      const hit = cache.get(key);
      if (hit) {
        hits++;
        cache.delete(key);          // re-insert = most-recently-used
        cache.set(key, hit);
        return hit;
      }
      misses++;
      const audio = await tts.synth(text, lang);
      cache.set(key, audio);
      while (cache.size > max) cache.delete(cache.keys().next().value);
      return audio;
    },
    /**
     * Render lines we already know we will say. Never rejects and never
     * blocks the caller: a failed prewarm costs the latency it would have
     * saved, nothing else.
     */
    async prewarm(texts, lang) {
      const list = [].concat(texts || []).filter(Boolean);
      const done = await Promise.all(list.map((t) => this.synth(t, lang).then(() => true, () => false)));
      return done.filter(Boolean).length;
    },
    _cacheStats: () => ({ size: cache.size, hits, misses }),
  };
}

// ---------------------------------------------------------------------------
// WAV / rate conversion
// ---------------------------------------------------------------------------
//
// A TTS engine renders at whatever rate it likes — 24kHz is typical. A phone
// line is 8kHz. Handing 24kHz samples to a transport that believes they are
// 8kHz does not error; it plays them three times too fast, which is the single
// most likely way this integration sounds broken on its first real call.
// Everything below exists to make that impossible.

/** Wrap raw 16-bit mono PCM in a minimal RIFF/WAVE header. */
export function wrapWav(pcm, sampleRate, channels = 1) {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * 2;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);            // PCM fmt chunk size
  header.writeUInt16LE(1, 20);             // format 1 = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(channels * 2, 32);  // block align
  header.writeUInt16LE(16, 34);            // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Read a WAV's fmt/data chunks. Walks the chunk list rather than assuming the
 * data starts at byte 44 — real encoders insert LIST/fact chunks, and a fixed
 * offset would splice metadata into the audio as noise.
 */
export function parseWav(buf) {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not_a_wav');
  }
  let pos = 12;
  let fmt = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      if (!fmt) throw new Error('wav_data_before_fmt');
      return { ...fmt, data: buf.subarray(body, Math.min(body + size, buf.length)) };
    }
    pos = body + size + (size % 2);        // chunks are word-aligned
  }
  throw new Error('wav_no_data_chunk');
}

/** Average channels down to mono, in place of dropping one and losing half the energy. */
function downmix(samples, channels) {
  if (channels <= 1) return samples;
  const out = new Int16Array(Math.floor(samples.length / channels));
  for (let i = 0; i < out.length; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += samples[i * channels + c];
    out[i] = Math.round(sum / channels);
  }
  return out;
}

/**
 * Linear-interpolation resample. Deliberately simple: telephony is band-limited
 * to ~3.4kHz anyway, so the aliasing a proper low-pass would prevent is largely
 * filtered out by the line itself. If the WP-1 spike finds audible artefacts on
 * a real call, this is the function to replace with a windowed-sinc — not the
 * provider.
 */
export function resamplePcm16(samples, fromRate, toRate) {
  if (fromRate === toRate) return samples;
  const ratio = fromRate / toRate;
  const out = new Int16Array(Math.max(1, Math.floor(samples.length / ratio)));
  for (let i = 0; i < out.length; i++) {
    const src = i * ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(i0 + 1, samples.length - 1);
    const frac = src - i0;
    out[i] = Math.round(samples[i0] * (1 - frac) + samples[i1] * frac);
  }
  return out;
}

/** WAV bytes -> raw 16-bit mono PCM at the telephony rate. */
export function toTelephonyPcm(wavBuffer, targetRate = Number(process.env.TELEPHONY_SAMPLE_RATE || 8000)) {
  const { format, channels, sampleRate, bitsPerSample, data } = parseWav(wavBuffer);
  if (format !== 1 || bitsPerSample !== 16) {
    // Fail loudly. A silent mis-decode reaches the prospect's ear.
    throw new Error(`unsupported_wav_format_${format}_${bitsPerSample}bit`);
  }
  const interleaved = new Int16Array(data.buffer, data.byteOffset, Math.floor(data.length / 2));
  const mono = downmix(interleaved, channels);
  const resampled = resamplePcm16(mono, sampleRate, targetRate);
  return Buffer.from(resampled.buffer, resampled.byteOffset, resampled.length * 2);
}

/**
 * Split synthesized audio into ~20ms frames. Streaming in small frames is what
 * makes barge-in feel instant: playback stops at the next frame boundary
 * instead of at the end of the sentence.
 */
export function frameAudio(audio, { sampleRate = Number(process.env.TELEPHONY_SAMPLE_RATE || 8000), bytesPerSample = 2, frameMs = 20 } = {}) {
  const frameBytes = Math.max(1, Math.floor((sampleRate * bytesPerSample * frameMs) / 1000));
  const frames = [];
  for (let i = 0; i < audio.length; i += frameBytes) {
    frames.push(audio.subarray(i, Math.min(i + frameBytes, audio.length)));
  }
  return frames;
}
