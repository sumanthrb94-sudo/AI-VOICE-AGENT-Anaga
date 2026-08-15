// shared/wav.js
//
// Read a RIFF/WAVE header and say what is actually inside.
//
// ── WHY THIS EXISTS ───────────────────────────────────────────────────────
// The call leg used to strip the header and throw the rest away:
//
//     if (id === 'data') return buf.subarray(at + 8, ...)
//
// which discards the two fields that decide whether the bytes are playable —
// the format tag and the SAMPLE RATE. Handing 24kHz samples to an 8kHz phone
// line as raw PCM does not fail; it plays her three times too slow and an
// octave and a half down. To a prospect that is not "a provider fell back",
// it is a broken agent, and nothing anywhere reports it.
//
// That is not hypothetical. api/_lib/tts.js's IndicF5 adapter hardcoded
// `sample_rate: 24000` and never read the rate the transport asked for, so any
// fallback to it produced exactly that.
//
// So: parse the header, return what it says, and let the caller refuse a
// mismatch loudly. A vendor that answers in the wrong format is a vendor that
// failed — it should sound like a failure, not like a bad agent.

/** WAVE format tags we care about. There are dozens; these are the three the
 *  telephony and browser legs can actually consume. */
export const WAVE_FORMAT = {
  PCM: 1,
  ALAW: 6,
  MULAW: 7,
  EXTENSIBLE: 0xfffe,
};

/**
 * @typedef {object} WavInfo
 * @property {Buffer}  samples      the data chunk, header removed
 * @property {number}  format       WAVE format tag (1 = PCM, 7 = mu-law)
 * @property {number}  sampleRate   samples per second, as the file declares
 * @property {number}  channels
 * @property {number}  bitsPerSample
 * @property {boolean} wrapped      false when the input had no RIFF header
 */

/**
 * Parse a WAV buffer. A buffer with no RIFF header is returned as-is with
 * `wrapped: false` and unknown fields — callers that requested raw PCM get
 * exactly that back, and callers that need to verify know they cannot.
 *
 * @param {Buffer} buf
 * @returns {WavInfo}
 */
export function readWav(buf) {
  const unknown = {
    samples: buf, format: 0, sampleRate: 0, channels: 0, bitsPerSample: 0, wrapped: false,
  };
  if (!buf || buf.length < 12) return unknown;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return unknown;

  let format = 0, sampleRate = 0, channels = 0, bitsPerSample = 0;
  let samples = null;
  let at = 12;

  // Walk the chunks. `fmt ` may come after `data` in a non-conforming file, so
  // the loop does not stop at the first `data` — it reads to the end and then
  // reports both. Chunks are word-aligned, hence the odd-size pad.
  while (at + 8 <= buf.length) {
    const id = buf.toString('ascii', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    const body = at + 8;

    if (id === 'fmt ' && body + 16 <= buf.length) {
      format = buf.readUInt16LE(body);
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bitsPerSample = buf.readUInt16LE(body + 14);
      // WAVE_FORMAT_EXTENSIBLE hides the real tag in the first two bytes of
      // its extension block. Without this, a perfectly ordinary mu-law file
      // written by some encoders reads as "format 65534" and gets refused.
      if (format === WAVE_FORMAT.EXTENSIBLE && body + 26 <= buf.length) {
        format = buf.readUInt16LE(body + 24);
      }
    } else if (id === 'data') {
      // A `data` size of 0 or 0xFFFFFFFF appears in streamed WAV, where the
      // writer could not know the length in advance. Take the rest of the
      // buffer rather than returning nothing.
      const end = size > 0 && size !== 0xffffffff
        ? Math.min(buf.length, body + size)
        : buf.length;
      samples = buf.subarray(body, end);
    }

    at = body + size + (size % 2);
    // A corrupt size field can make `at` stall or go backwards; stop rather
    // than spin.
    if (size === 0 && id !== 'data') break;
  }

  if (!samples) return unknown;
  return { samples, format, sampleRate, channels, bitsPerSample, wrapped: true };
}

/**
 * Unwrap audio for a transport that expects raw samples at a known rate, and
 * REFUSE anything that would play wrong.
 *
 * @param {Buffer} buf                       what the provider returned
 * @param {string} mime                      what the provider said it was
 * @param {{encoding:string, sampleRate:number}} want   what the wire speaks
 * @returns {Buffer} raw samples, ready for the transport
 * @throws {Error} when the audio cannot be played correctly on this transport
 */
export function unwrapFor(buf, mime, want) {
  const m = String(mime || '').toLowerCase();
  const wantMulaw = want.encoding === 'mulaw';
  const rate = Number(want.sampleRate) || 0;

  const info = readWav(buf);

  if (info.wrapped) {
    // The header is authoritative — it describes the bytes that follow, which
    // the MIME type merely claims something about.
    if (wantMulaw && info.format !== WAVE_FORMAT.MULAW) {
      throw new Error(`voice returned WAV format ${info.format}, and this line needs mu-law`);
    }
    if (!wantMulaw && info.format !== WAVE_FORMAT.PCM) {
      throw new Error(`voice returned WAV format ${info.format}, and this line needs linear PCM`);
    }
    if (!wantMulaw && info.bitsPerSample && info.bitsPerSample !== 16) {
      throw new Error(`voice returned ${info.bitsPerSample}-bit audio, and this line needs 16-bit`);
    }
    if (info.channels && info.channels !== 1) {
      throw new Error(`voice returned ${info.channels} channels, and this line is mono`);
    }
    // THE CHECK THAT WAS MISSING. A rate mismatch does not sound like an
    // error, it sounds like a different, worse agent.
    if (rate && info.sampleRate && info.sampleRate !== rate) {
      throw new Error(
        `voice returned ${info.sampleRate}Hz audio for a ${rate}Hz line — `
        + 'it would play at the wrong speed and pitch',
      );
    }
    return info.samples;
  }

  // No header. Fall back to trusting the MIME, which is all there is — but
  // still refuse a format that is obviously not what the wire speaks.
  if (wantMulaw) {
    if (/mulaw|ulaw|pcmu|basic/.test(m)) return buf;
    throw new Error(`voice returned ${mime || 'an unknown format'}, which is not mu-law`);
  }
  if (/l16|linear16|pcm|octet-stream/.test(m)) return buf;
  throw new Error(`voice returned ${mime || 'an unknown format'}, which is not PCM`);
}
