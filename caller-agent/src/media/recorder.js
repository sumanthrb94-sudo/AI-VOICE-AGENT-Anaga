// caller-agent/src/media/recorder.js
//
// Captures both legs of a live call into one mono WAV.
//
// This is the piece that was missing. session.js has always ended with
//
//     if (typeof telephony.recording === 'function') { … storeRecording(…) }
//
// and NO telephony adapter has ever implemented recording() — not the mock, not
// Plivo, not Exotel, not the media server. So the whole storage path below it
// (SigV4 upload, the Indian-region gate, presigned playback, DPDP erasure) was
// built, tested and reachable by nothing: every call produced no audio at all,
// silently, because the guard that skipped it looks exactly like a feature that
// is merely switched off.
//
// docs/COMPLIANCE.md requires the recording. The transport already sees both
// sides of the conversation — inbound frames arrive at pushAudio(), outbound
// frames leave through audioOut() — so this mixes them onto one timeline.
//
// MIXED, not two channels, on purpose: a reviewer wants to hear the call the way
// the participants heard it, and a mono file is half the bytes to store, ship
// and stream back through a signed URL.

/** Telephony audio is 16-bit signed little-endian mono. */
const BYTES_PER_SAMPLE = 2;

/**
 * @param {object} [opts]
 * @param {number} [opts.sampleRate]  must match the transport's audio
 * @param {number} [opts.maxSeconds]  hard ceiling — a stuck call must not eat RAM
 * @param {function} [opts.now]
 */
export function createCallRecorder({
  sampleRate = Number(process.env.TELEPHONY_SAMPLE_RATE || 8000),
  maxSeconds = Number(process.env.CALL_MAX_SECONDS || 300),
  now = () => Date.now(),
} = {}) {
  // Preallocated rather than grown: the ceiling is known (the session enforces
  // the same one), and 300s at 8kHz is 4.8MB, which is cheaper than the
  // repeated copies a growing buffer would make on every 20ms frame.
  const capacity = Math.max(1, Math.floor(sampleRate * maxSeconds));
  const timeline = new Int16Array(capacity);

  let startedAt = null;
  let end = 0;              // highest sample index written
  let dropped = 0;          // samples past the ceiling
  let inboundFrames = 0;
  let outboundFrames = 0;

  /** Lay a chunk onto the shared timeline at the moment it happened. */
  function mix(chunk, t) {
    if (!chunk || !chunk.length) return;
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (startedAt == null) startedAt = t;

    // Position by WALL CLOCK, not by how much audio we have already seen.
    // Appending would pack the two legs end to end and produce a recording in
    // which nobody ever interrupts anybody — which is precisely the behaviour
    // these recordings exist to review.
    let at = Math.floor(((t - startedAt) * sampleRate) / 1000);
    if (at < end) at = end - Math.min(end - at, Math.floor(buf.length / BYTES_PER_SAMPLE));
    if (at < 0) at = 0;

    const samples = Math.floor(buf.length / BYTES_PER_SAMPLE);
    for (let i = 0; i < samples; i++) {
      const idx = at + i;
      if (idx >= capacity) { dropped += samples - i; break; }
      // Sum the legs and clip. Two people talking at once is the interesting
      // part of a call; wrapping instead of clipping would turn it into a bang.
      const sum = timeline[idx] + buf.readInt16LE(i * BYTES_PER_SAMPLE);
      timeline[idx] = sum > 32767 ? 32767 : sum < -32768 ? -32768 : sum;
      if (idx + 1 > end) end = idx + 1;
    }
  }

  return {
    /** Audio from the prospect. */
    inbound(chunk, t = now()) { inboundFrames++; mix(chunk, t); },
    /** Audio we played to them. */
    outbound(chunk, t = now()) { outboundFrames++; mix(chunk, t); },

    /** The call so far as WAV bytes, or null if nothing was ever captured. */
    wav() {
      if (!end) return null;
      const pcm = Buffer.from(timeline.buffer, timeline.byteOffset, end * BYTES_PER_SAMPLE);
      return wrapWav(pcm, sampleRate);
    },

    stats() {
      return {
        durationSec: Math.round((end / sampleRate) * 10) / 10,
        bytes: end * BYTES_PER_SAMPLE,
        inboundFrames,
        outboundFrames,
        truncated: dropped > 0,
        droppedSamples: dropped,
      };
    },

    /**
     * What the transport should log about this recording, as [event, data]
     * pairs. Lives here rather than in the transport so that the one caller
     * cannot forget the truncation warning — a truncated recording of a long
     * call is evidence with a hole in it, and filing it as though it were the
     * whole call is the failure worth being loud about.
     */
    report() {
      const s = this.stats();
      const out = [['call_recorded', s]];
      if (s.truncated) {
        out.push(['RECORDING_TRUNCATED', {
          droppedSamples: s.droppedSamples, severity: 'high',
          detail: 'the call outran CALL_MAX_SECONDS — the tail is not in the recording',
        }]);
      }
      return out;
    },
  };
}

/** Minimal RIFF/WAVE header around raw 16-bit mono PCM. */
function wrapWav(pcm, sampleRate, channels = 1) {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * BYTES_PER_SAMPLE;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(channels * BYTES_PER_SAMPLE, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
