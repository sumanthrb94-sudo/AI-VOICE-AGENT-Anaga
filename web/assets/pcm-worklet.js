/* PCM in and PCM out, on the audio thread.
   ==========================================================================
   Two processors, both tiny, both here for the same reason: this work cannot
   happen on the main thread. A React render, a scroll, or a background tab
   throttling the page all produce audible glitches when audio is assembled on
   the main thread — and the whole point of moving to a socket was to stop
   audio being at the mercy of anything.

   CAPTURE  Float32 (whatever the device runs at, usually 48kHz) down to
            16-bit LE PCM at 16kHz, which is what Deepgram's live socket takes.
            The resampling is a plain decimation with a linear step; it is not
            a good resampler, and it does not need to be — 16kHz is a LOW-PASS
            of speech that the recogniser was trained on, and Saaras and
            Deepgram both run telephony audio that is worse than this.

   PLAYBACK a ring buffer she is fed into, so her voice plays continuously
            while the next phrase is still being synthesized. Without this,
            each phrase is its own <audio> element and the seams are audible.
            `clear` empties it instantly — that is barge-in: when the prospect
            starts talking, whatever is buffered must never be heard.

            IT ALSO RESAMPLES, and for a while it did not. Capture was
            resampled and playback was not, so 16kHz samples were written one
            per frame into an output the browser renders at the DEVICE rate —
            48kHz on most phones and laptops. That is not a glitch and it does
            not error: she simply speaks three times too fast, pitched up, and
            it sounds like a bad voice rather than a bug. Symmetry with
            CaptureProcessor is the whole fix. */

class CaptureProcessor extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    const o = (opts && opts.processorOptions) || {};
    this.target = o.targetRate || 16000;
    this.ratio = sampleRate / this.target;   // `sampleRate` is a worklet global
    this.pos = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;

    // How many output samples this 128-frame quantum yields. Tracked as a
    // running fractional position rather than a per-block count, so the drift
    // does not accumulate into a slow desync over a long call.
    const out = [];
    for (; this.pos < ch.length; this.pos += this.ratio) {
      const s = ch[Math.floor(this.pos)];
      // Clamp before scaling: a value outside [-1,1] wraps rather than clips
      // when it is cast to a signed 16-bit integer, which is heard as a crack.
      const c = s > 1 ? 1 : s < -1 ? -1 : s;
      out.push(c < 0 ? c * 0x8000 : c * 0x7fff);
    }
    this.pos -= ch.length;

    if (out.length) {
      const pcm = new Int16Array(out.length);
      for (let i = 0; i < out.length; i++) pcm[i] = out[i];
      this.port.postMessage(pcm.buffer, [pcm.buffer]);
    }
    return true;
  }
}

class PlaybackProcessor extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    const o = (opts && opts.processorOptions) || {};
    // The rate the SOCKET speaks, which is not the rate this thread renders at.
    this.source = o.sourceRate || 16000;
    // Advance through the incoming samples this much per output frame. At a
    // 48kHz device and a 16kHz stream that is 1/3: three output frames per
    // input sample, which is what makes her play at the right speed.
    this.step = this.source / sampleRate;         // `sampleRate` is a worklet global
    this.queue = [];
    this.at = 0;                                  // FRACTIONAL, hence the interpolation
    this.last = 0;                                // final sample of the buffer just retired
    this.port.onmessage = (e) => {
      // BARGE-IN. Everything buffered is dropped, immediately — a phone line
      // holds hundreds of milliseconds, and playing it after the prospect has
      // started talking is the agent talking over them.
      if (e.data === 'clear') { this.queue.length = 0; this.at = 0; this.last = 0; return; }
      this.queue.push(new Int16Array(e.data));
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;

    for (let i = 0; i < out.length; i++) {
      const head = this.queue[0];
      if (!head) { out[i] = 0; continue; }        // nothing to say: silence

      // LINEAR INTERPOLATION, not nearest-neighbour. Upsampling 3:1 by
      // repeating each sample is a staircase, and a staircase is high-frequency
      // energy that was never in her voice — it is heard as a rasp on every
      // vowel. Interpolating costs one multiply per frame.
      const idx = Math.floor(this.at);
      const frac = this.at - idx;
      const a = idx < head.length ? head[idx] : this.last;
      // The sample after this one may live in the NEXT buffer. Reaching for it
      // keeps phrase seams smooth; without it every buffer boundary is a small
      // discontinuity, and she is fed a new buffer several times a second.
      const b = idx + 1 < head.length ? head[idx + 1]
        : (this.queue[1] && this.queue[1].length ? this.queue[1][0] : a);
      out[i] = (a + (b - a) * frac) / 0x8000;

      this.at += this.step;
      if (this.at >= head.length) {
        this.at -= head.length;                   // carry the fraction, do not reset it
        this.last = head[head.length - 1];
        this.queue.shift();
      }
    }
    return true;
  }
}

registerProcessor('anaga-capture', CaptureProcessor);
registerProcessor('anaga-playback', PlaybackProcessor);
