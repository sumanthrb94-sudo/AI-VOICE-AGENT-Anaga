// caller-agent/src/providers/speech.js
//
// STT and TTS adapters (WP-4). Provider-abstracted: the media transport calls
// transcribe()/synth() and never learns which vendor answered.
//
// Default: Sarvam (Saaras STT, Bulbul TTS) — the Indic stack this product is
// built on. AI4Bharat/Bhashini slot in behind the same two functions.
//
// ⚠️ VERIFICATION STATUS: the Sarvam TTS path mirrors api/_lib/tts.js, which is
// the code the live web demo uses, so its request shape is exercised. The
// Sarvam STT path is implemented to the documented API but has NOT been run
// against real telephony audio (8kHz μ-law from a phone line is materially
// harder than a browser mic). Verify sample-rate and encoding handling in the
// WP-1 spike before launch.

const SARVAM_TTS_URL = 'https://api.sarvam.ai/text-to-speech';
const SARVAM_STT_URL = 'https://api.sarvam.ai/speech-to-text';

function sarvamKey() {
  const k = process.env.SARVAM_API_KEY;
  if (!k) throw new Error('SARVAM_API_KEY not configured');
  return k;
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

  if (provider !== 'sarvam') throw new Error(`unsupported TTS_PROVIDER: ${provider}`);

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
