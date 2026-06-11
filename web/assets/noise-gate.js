/* ===================================================================
   Anaga NOISE GATE — a tiny client-side speech gate for the live call.

   PURPOSE: a real-time voice agent should only forward the CUSTOMER'S clear
   speech, not the room they're sitting in (fans, AC, traffic, distant chatter).
   If every little sound reaches the server, the model's own VAD keeps
   barge-in-interrupting Anaga ("any noise makes her stop") and the transcript
   fills with garbage. This gate sits in front of the upstream send: it watches
   the mic energy, learns the room's noise floor, and only opens once it hears
   something clearly louder than that floor — i.e. actual speech.

   It is deliberately simple, fast, and dependency-free (it runs ~25-50x/sec):
   a classic energy-based gate with an adaptive floor, onset confirmation, a
   hangover tail, and a prefix buffer. No FFT, no allocation in the hot path
   beyond the frame(s) we actually return.

   ── The DSP, in four ideas ──────────────────────────────────────────
   1. ENERGY (RMS). Per frame we compute root-mean-square amplitude — a cheap
      proxy for loudness. Speech RMS is well above room-noise RMS.
   2. ADAPTIVE FLOOR (EMA). The "background" level isn't fixed, so we track it
      with an exponential moving average updated ONLY when we're NOT in speech.
      The room can get louder/quieter and the gate follows it. dB (20*log10)
      is used for the threshold so it's a ratio, not an absolute level: speech
      is "thresholdDb above the floor".
   3. ONSET + HANGOVER. To avoid opening on a single noisy click we require a
      few consecutive loud frames (onset confirmation). To avoid CHOPPING words
      at natural gaps (stops between syllables/words), once open we stay open
      through a hangover window after energy drops back down.
   4. PREFIX. Speech onset is detected a few frames late (we needed confirmation
      and the attack ramps up), so the very first phonemes would be clipped.
      We keep a small ring buffer of recent audio and, on the OPEN transition,
      prepend that prefix so the word starts cleanly.

   Vanilla JS, no build step, no npm deps, fail-soft. Mirrors the style of
   live-call.js. Used as:
       const gate = NoiseGate.create({ sampleRate: 16000 });
       // in onFrames, instead of sending `down` directly:
       const out = gate.feed(down);
       if (out.length) sendUpstream(out);
   =================================================================== */
(function () {
  'use strict';

  const EMPTY = new Float32Array(0);

  /* ---- defaults: tuned for noise robustness without clipping speech ---- */
  const DEFAULTS = {
    sampleRate: 16000,   // frames are expected at this rate (post-resample `down`)
    prefixMs: 200,       // how much pre-onset audio to prepend so onsets aren't clipped
    hangoverMs: 350,     // keep the gate open this long after energy drops (word gaps)
    thresholdDb: 13,     // speech must be this many dB above the adaptive noise floor (~4.5x) — ignore background
    absFloor: 0.006,     // minimum RMS to ever count as speech — wants a near-field (close-mic) voice, not the room
    onsetMs: 130,        // sustained "loud" time before we declare speech — transient noise/clicks won't open it
    floorAttackMs: 200,  // EMA time constant when the floor RISES (noise got louder)
    floorReleaseMs: 800  // EMA time constant when the floor FALLS (slower = stable)
  };

  /* root-mean-square of a Float32 frame, 0..1. Robust to empty/odd-length input. */
  function rms(float32) {
    if (!float32 || !float32.length) return 0;
    let sum = 0;
    const n = float32.length;
    for (let i = 0; i < n; i++) { const v = float32[i]; sum += v * v; }
    const m = sum / n;
    // guard against NaN/negative fp dust before sqrt
    return m > 0 ? Math.sqrt(m) : 0;
  }

  /* linear amplitude ratio for a dB gain (dB -> factor). 9 dB ≈ 2.82x. */
  function dbToRatio(db) { return Math.pow(10, db / 20); }

  /* one-pole EMA smoothing factor for a time constant (ms) at this frame size.
     alpha ≈ 1 - exp(-dt/tau); per-frame we approximate dt as frameMs. Clamped
     to (0,1]. Larger alpha = faster adaptation. */
  function emaAlpha(frameMs, tauMs) {
    if (!(tauMs > 0)) return 1;
    const a = 1 - Math.exp(-frameMs / tauMs);
    return a < 0 ? 0 : (a > 1 ? 1 : a);
  }

  /**
   * NoiseGate.create(opts) -> gate
   * opts (all optional): { sampleRate, prefixMs, hangoverMs, thresholdDb,
   *                        absFloor, onsetMs, floorAttackMs, floorReleaseMs }
   * See DEFAULTS above for meanings / chosen values.
   */
  function create(opts) {
    opts = opts || {};
    const cfg = {
      sampleRate:     numOr(opts.sampleRate,     DEFAULTS.sampleRate),
      prefixMs:       numOr(opts.prefixMs,       DEFAULTS.prefixMs),
      hangoverMs:     numOr(opts.hangoverMs,     DEFAULTS.hangoverMs),
      thresholdDb:    numOr(opts.thresholdDb,    DEFAULTS.thresholdDb),
      absFloor:       numOr(opts.absFloor,       DEFAULTS.absFloor),
      onsetMs:        numOr(opts.onsetMs,        DEFAULTS.onsetMs),
      floorAttackMs:  numOr(opts.floorAttackMs,  DEFAULTS.floorAttackMs),
      floorReleaseMs: numOr(opts.floorReleaseMs, DEFAULTS.floorReleaseMs)
    };
    const sr = cfg.sampleRate > 0 ? cfg.sampleRate : DEFAULTS.sampleRate;
    const threshRatio = dbToRatio(cfg.thresholdDb);

    // PREFIX ring buffer: a flat Float32 ring holding the last ~prefixMs of audio.
    // Sized once; we never reallocate it in the hot path. +1 slot so a full ring
    // is distinguishable from an empty one.
    const prefixCap = Math.max(1, Math.round(sr * cfg.prefixMs / 1000));
    const ring = new Float32Array(prefixCap);
    let ringWrite = 0;     // next write index
    let ringCount = 0;     // how many valid samples are in the ring (<= prefixCap)

    // adaptive noise floor (RMS units). Seed with absFloor so the first frames
    // don't open on noise before the EMA has anything to compare against.
    let floor = cfg.absFloor;
    let lastRms = 0;       // most recent frame RMS (for level())
    let speech = false;    // current gate state (post-hangover)
    let onsetMs = 0;       // accumulated "loud" time toward onset confirmation
    let hangMs = 0;        // remaining hangover time once energy drops
    let seeded = false;    // have we observed at least one frame yet?

    /* push a frame into the prefix ring (copying samples, oldest overwritten). */
    function pushPrefix(frame) {
      const n = frame.length;
      if (n >= prefixCap) {
        // frame alone is >= ring: keep only its tail.
        ring.set(frame.subarray(n - prefixCap));
        ringWrite = 0;
        ringCount = prefixCap;
        return;
      }
      for (let i = 0; i < n; i++) {
        ring[ringWrite] = frame[i];
        ringWrite = ringWrite + 1 === prefixCap ? 0 : ringWrite + 1;
      }
      ringCount = Math.min(prefixCap, ringCount + n);
    }

    /* read the ring out in chronological order into a fresh Float32Array. */
    function readPrefix() {
      const out = new Float32Array(ringCount);
      // oldest sample is `ringCount` slots behind the write head.
      let idx = ringWrite - ringCount;
      if (idx < 0) idx += prefixCap;
      for (let i = 0; i < ringCount; i++) {
        out[i] = ring[idx];
        idx = idx + 1 === prefixCap ? 0 : idx + 1;
      }
      return out;
    }

    /**
     * gate.feed(float32) -> Float32Array  (what to actually SEND this tick)
     *   • suppressed  -> EMPTY (length 0)
     *   • on onset    -> prefix ++ current frame
     *   • in speech / hangover -> current frame
     */
    function feed(frame) {
      // robustness: ignore empty/odd input but keep state coherent.
      if (!frame || !frame.length) return EMPTY;

      const frameMs = (frame.length / sr) * 1000;
      const level = rms(frame);
      lastRms = level;
      seeded = true;

      // "loud" = clearly above the adaptive floor AND above the absolute floor.
      // Comparing in linear RMS: floor * ratio is the same as floorDb + thresholdDb.
      const openThresh = Math.max(cfg.absFloor, floor * threshRatio);
      const loud = level >= openThresh;

      const wasSpeech = speech;

      if (loud) {
        // accumulate onset evidence; refill hangover so the tail is full.
        onsetMs += frameMs;
        hangMs = cfg.hangoverMs;
        if (!speech && onsetMs >= cfg.onsetMs) speech = true;
      } else {
        // not loud: drop onset evidence; if we were open, bleed the hangover.
        onsetMs = 0;
        if (speech) {
          hangMs -= frameMs;
          if (hangMs <= 0) { speech = false; hangMs = 0; }
        }
      }

      // ADAPT the noise floor ONLY while we're confidently NOT in speech, so
      // speech energy never pollutes the floor (which would raise the bar and
      // eventually gate out the talker). Asymmetric: rise quickly toward louder
      // rooms, fall slowly for stability.
      if (!speech && !loud) {
        const tau = level > floor ? cfg.floorAttackMs : cfg.floorReleaseMs;
        const alpha = emaAlpha(frameMs, tau);
        floor = floor + alpha * (level - floor);
        if (floor < 0) floor = 0;
      }

      // Decide output, THEN update the prefix ring. Order matters: on the OPEN
      // transition the prefix must be the audio BEFORE this frame; we append the
      // current frame ourselves. After that, push the frame for future prefixes.
      let out;
      if (speech && !wasSpeech) {
        // ONSET edge: prefix (pre-roll) ++ current frame.
        const pre = readPrefix();
        out = new Float32Array(pre.length + frame.length);
        out.set(pre, 0);
        out.set(frame, pre.length);
      } else if (speech) {
        out = frame;                 // steady speech (or hangover) -> pass through
      } else {
        out = EMPTY;                 // suppressed -> send nothing
      }

      // Maintain the pre-roll buffer for the NEXT onset. We keep filling it even
      // during speech so that a brief close→reopen still has fresh pre-roll.
      pushPrefix(frame);

      return out;
    }

    /* current gate state (true through the hangover tail). */
    function isSpeech() { return speech; }
    /* most recent frame RMS, 0..1 — handy for a UI level meter. */
    function level() { return lastRms; }
    /* current adaptive noise floor in RMS units. */
    function noiseFloor() { return floor; }

    /* clear all state/buffers — call between calls so one room's floor and any
       half-open onset don't leak into the next. */
    function reset() {
      ringWrite = 0;
      ringCount = 0;
      floor = cfg.absFloor;
      lastRms = 0;
      speech = false;
      onsetMs = 0;
      hangMs = 0;
      seeded = false;
      // zero the ring so stale samples can never be read back.
      ring.fill(0);
    }

    return {
      feed: feed,
      isSpeech: isSpeech,
      level: level,
      noiseFloor: noiseFloor,
      reset: reset,
      // exposed for debugging / tuning; not part of the core contract.
      config: cfg
    };
  }

  /* coerce to a finite number, else fall back. */
  function numOr(v, fallback) {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return isFinite(n) ? n : fallback;
  }

  /* ---- public API ---- */
  if (typeof window !== 'undefined') {
    window.NoiseGate = {
      create: create,
      rms: rms,           // static helper: NoiseGate.rms(float32) -> 0..1
      DEFAULTS: DEFAULTS
    };
  }
})();
