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
            starts talking, whatever is buffered must never be heard. */

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
  constructor() {
    super();
    this.queue = [];
    this.at = 0;
    this.port.onmessage = (e) => {
      // BARGE-IN. Everything buffered is dropped, immediately — a phone line
      // holds hundreds of milliseconds, and playing it after the prospect has
      // started talking is the agent talking over them.
      if (e.data === 'clear') { this.queue.length = 0; this.at = 0; return; }
      this.queue.push(new Int16Array(e.data));
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;
    for (let i = 0; i < out.length; i++) {
      const head = this.queue[0];
      if (!head) { out[i] = 0; continue; }        // nothing to say: silence
      out[i] = head[this.at] / 0x8000;
      if (++this.at >= head.length) { this.queue.shift(); this.at = 0; }
    }
    return true;
  }
}

registerProcessor('vaak-capture', CaptureProcessor);
registerProcessor('vaak-playback', PlaybackProcessor);
