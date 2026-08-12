/* ===================================================================
   Vaak — the microphone, done properly.

   THE PROBLEM THIS REPLACES
   -------------------------
   The Web Speech API is free and instant and cannot do the one thing this
   product needs: echo cancellation. It takes the microphone exclusively,
   exposes no audio stream, and transcribes Anaga's own voice coming back off
   a phone speaker. She answers herself and the call becomes a loop.

   Three heuristics were shipped to tell her voice from a prospect's — a
   timing window, a content match against what she recently said, an energy
   threshold — and all three failed on real hardware. On Bluetooth the delay
   sits outside the browser entirely, so no window is wide enough and no
   threshold is safe.

   WHAT THIS DOES INSTEAD
   ----------------------
   One getUserMedia stream with echoCancellation. The browser subtracts what
   it is playing from what it hears BEFORE anything downstream sees it, so her
   voice is gone at the source rather than filtered out afterwards. From that
   one stream:

     an AnalyserNode  decides when you START and STOP talking (endpointing),
                      and notices you talking over her (barge-in);
     a MediaRecorder  captures the utterance, which is POSTed for transcription.

   No guard is load-bearing. There is nothing to guess.

   THE THRESHOLD IS MEASURED, NOT CHOSEN. Ambient noise in a car and in an
   empty office differ by more than any constant can straddle, so the floor is
   learned continuously from the quiet and speech is "clearly above the room".
   See the block above gate() for how, and for why the first version of that
   idea reported an entire room as a talking prospect.
   =================================================================== */
(function (global) {
  "use strict";

  function pickMime() {
    // Sarvam accepts WebM, OGG, MP4/M4A and WAV. Chrome gives WebM/Opus,
    // Safari gives MP4 — take whichever the browser will actually produce.
    var want = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
    for (var i = 0; i < want.length; i++) {
      if (global.MediaRecorder && MediaRecorder.isTypeSupported(want[i])) return want[i];
    }
    return "";
  }

  /**
   * @param {object} o
   * @param {function} o.onSpeechStart  they began talking (use for barge-in)
   * @param {function} o.onUtterance    ({blob, mime, ms}) they finished
   * @param {function} o.onLevel        0..1, for a meter
   * @param {function} o.onError        (code) — "denied" | "unavailable" | other
   */
  function createMic(o) {
    var opts = o || {};
    var stream = null, ctx = null, analyser = null, buf = null, freq = null;
    var rec = null, chunks = [], mime = pickMime();
    var running = false, closed = false;

    // Endpointing, the same shape as the call leg
    // (caller-agent/src/media/timings.js), with one difference:
    //
    // A SINGLE SILENCE WINDOW IS WRONG IN BOTH DIRECTIONS.
    //
    // 800ms is right in the middle of a sentence: Indian English and
    // code-mixing pause to reach for a word, and cutting somebody off there
    // sends half an utterance to be transcribed. It is far too long after
    // "అవును" — a complete answer, obviously finished, and the prospect then
    // waits 800ms of dead air before the pipeline even starts.
    //
    // So the window scales with how long they spoke. A short burst is almost
    // always a complete short answer; a long one is a sentence that may still
    // be going. This is a cheap approximation of the semantic endpointing that
    // dedicated voice stacks use, and it costs nothing.
    var SILENCE_MS = Number(opts.silenceMs || 800);          // after a long turn
    var SILENCE_MIN_MS = Number(opts.silenceMinMs || 420);   // after a short one
    var SHORT_UTTERANCE_MS = 1200;
    var MIN_SPEECH_MS = Number(opts.minSpeechMs || 300);

    /** How long to wait before calling it finished, given what we just heard. */
    function silenceBudget(spokenMs) {
      return spokenMs <= SHORT_UTTERANCE_MS ? SILENCE_MIN_MS : SILENCE_MS;
    }
    var MAX_UTTERANCE_MS = Number(opts.maxUtteranceMs || 15000);
    var ONSET_MS = 140;                 // sustained, before we call it speech

    /* ===================================================================
       TELLING A VOICE FROM A ROOM.

       WHAT WAS HERE, AND WHY IT FIRED ON EVERYTHING
       ---------------------------------------------
       A bare RMS threshold with a floor that only adapted while the gate was
       CLOSED:

           isVoice = level > max(0.012, floor * 2.2)
           if (!isVoice && !speaking) floor = floor*0.98 + level*0.02

       Two failures, both of which look like "it thinks the room is talking":

       1. THE FLOOR LATCHED. The moment ambient noise crossed the threshold,
          isVoice stayed true, so the floor stopped updating and could never
          rise to catch up. A fan starting, a TV, traffic through a window —
          the gate opened and never closed again. The comment above it claimed
          this was exactly what it prevented. It did the opposite.

       2. CALIBRATION TOOK THE PEAK. floor = max(floor, level) over the first
          600ms, so a door closing during calibration set the floor to the bang
          and the microphone went deaf for the rest of the call.

       AND EVEN FIXED, RMS IS THE WRONG INSTRUMENT. Energy cannot distinguish
       speech from noise, because loudness is not what makes something speech.
       Measured on real-world audio (arXiv 2601.17270, "Window Size Versus
       Accuracy Experiments in Voice Activity Detection"), Matthews correlation
       against ground truth:

           RMS energy   0.11        <- what this was
           WebRTC VAD   0.41
           Silero VAD   0.72

       0.11 is very nearly a coin toss. No threshold tuning improves it, which
       is why this now measures the SHAPE of the sound as well as its size.

       WHAT IT DOES NOW
       ----------------
       - The floor is the 20th PERCENTILE of the last ~3 seconds, recorded
         whether the gate is open or shut. Speech is intermittent — even a fast
         talker leaves gaps between words — so the quietest fifth of a window is
         the room, not the speaker. Continuous noise fills the whole window, so
         the percentile rises into it and the gate closes on its own.
       - HYSTERESIS: a higher threshold to open than to close, so a level
         sitting on the boundary does not flap the gate open and shut.
       - A SPECTRAL TEST to open: energy concentrated in the 300-3400 Hz speech
         band, and a non-flat spectrum. A fan or a rumble is mostly below the
         band; a hiss or a fricative-shaped noise is spectrally flat; voiced
         speech is neither. This is cheap, needs no model, and is what a room
         full of steady noise fails.

       THIS IS STILL NOT SILERO. It is an honest heuristic and it will lose to a
       neural VAD on hard cases — a TV playing dialogue is speech-shaped and
       will get through. The real fix is the model; see docs/VAD.md.
       =================================================================== */
    var floor = 0.02, floorReady = false, calibMs = 0;
    var CALIBRATE_MS = 600;
    // ~3.2 seconds of history at 60fps. Long enough that a pause between
    // words does not read as the room going quiet, short enough that walking
    // into a noisier place is noticed within a turn.
    var recent = new Float32Array(200), recentAt = 0, recentN = 0;
    var RESAMPLE_EVERY = 4, untilResample = 1;
    var OPEN_MULT = 3.0, CLOSE_MULT = 1.8;
    var ABS_OPEN = 0.014, ABS_CLOSE = 0.008;
    // Voice sits in the telephone band and is not spectrally flat.
    var BAND_MIN = Number(opts.bandRatio || 0.5);
    var FLAT_MAX = Number(opts.flatnessMax || 0.55);
    var speechMs = 0, silenceMs = 0, onsetMs = 0, speaking = false, last = 0;
    var gateOpen = false;

    function rms() {
      analyser.getByteTimeDomainData(buf);
      var sum = 0;
      for (var i = 0; i < buf.length; i++) {
        var v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      return Math.sqrt(sum / buf.length);
    }

    /**
     * Does this sound like a VOICE, rather than merely being loud?
     *
     * Two classical features, both a few lines and both computable from the
     * spectrum the analyser already produces:
     *
     *   BAND RATIO — how much of the energy lies between 300 and 3400 Hz, the
     *   band a telephone carries because it is where speech lives. Air
     *   conditioning, traffic and mains hum are mostly below it; tapping and
     *   clatter are mostly above.
     *
     *   SPECTRAL FLATNESS — the geometric mean of the spectrum over its
     *   arithmetic mean (Wiener entropy). White noise is flat and scores near
     *   1; voiced speech has harmonics and formants and scores far lower.
     *
     * @returns {boolean} true when the sound has the shape of speech.
     */
    function speechLike() {
      if (!freq) return true;                 // no spectrum: do not block
      analyser.getByteFrequencyData(freq);
      var perBin = (ctx.sampleRate / 2) / freq.length;
      var lo = Math.max(1, Math.floor(300 / perBin));
      var hi = Math.min(freq.length - 1, Math.ceil(3400 / perBin));
      var band = 0, total = 0, logSum = 0, n = 0;
      for (var i = 1; i < freq.length; i++) {
        var v = freq[i] / 255;
        total += v;
        if (i >= lo && i <= hi) band += v;
        logSum += Math.log(v + 1e-6);
        n++;
      }
      if (total < 1e-4 || !n) return false;   // nothing there at all
      var mean = total / n;
      var flatness = Math.exp(logSum / n) / (mean + 1e-9);
      return (band / total) >= BAND_MIN && flatness <= FLAT_MAX;
    }

    /**
     * The gate. Separated out and exposed as a test seam because the failure
     * that shipped — a floor that stops adapting once it is exceeded — is
     * invisible from the outside and takes seconds of real audio to reproduce.
     *
     * @param {number} level    RMS of this frame
     * @param {boolean} voiceish does it have the shape of speech
     * @param {number} dt       ms since the last frame
     */
    function gate(level, voiceish, dt) {
      // ALWAYS record. This is the whole fix for the latch: the room is
      // measured whether or not the gate is open.
      //
      // A PERCENTILE, NOT AN AVERAGE. An exponential mean has to choose one
      // rate and both choices are wrong — fast enough for a fan to raise it
      // within a few seconds is fast enough for the prospect's own voice to
      // raise it and deafen the microphone mid-sentence. Slow enough to ignore
      // speech took roughly twenty seconds to notice a fan.
      //
      // The low percentile of a rolling window has neither problem, and it is
      // what noise estimators actually use (minimum statistics). Speech is
      // intermittent — even a fast talker leaves gaps between words — so the
      // quietest fifth of the last few seconds is the room, not the speaker.
      // Continuous noise fills the whole window, so the percentile rises to it
      // and the gate closes on its own.
      recent[recentAt] = level;
      recentAt = (recentAt + 1) % recent.length;
      if (recentN < recent.length) recentN++;
      if (--untilResample <= 0) {
        untilResample = RESAMPLE_EVERY;
        var sorted = Array.prototype.slice.call(recent, 0, recentN);
        sorted.sort(function (a, b) { return a - b; });
        floor = sorted[Math.floor(sorted.length * 0.2)] || 0;
      }

      var openAt = Math.max(ABS_OPEN, floor * OPEN_MULT);
      var closeAt = Math.max(ABS_CLOSE, floor * CLOSE_MULT);
      // Hysteresis: once open, a lower bar keeps it open, so the quiet tail of
      // a word does not chop the utterance in half. The spectral test applies
      // only to OPENING — an unvoiced consonant at the end of a word is
      // legitimately noise-shaped and must not close the gate early.
      //
      // The state is the GATE'S OWN, deliberately. It first read the
      // endpointer's `speaking`/`onsetMs`, which meant the hysteresis was
      // driven by a component downstream of it and only worked because those
      // happened to be set one frame after the gate first opened — true today,
      // silently wrong the moment either is touched.
      gateOpen = gateOpen ? (level > closeAt) : (level > openAt && voiceish);
      return gateOpen;
    }

    function startRecorder() {
      if (!global.MediaRecorder || !stream) return;
      try {
        chunks = [];
        // 24 kbps, NOT the browser default.
        //
        // Chrome defaults audio-only capture to about 128 kbps, which produced
        // 130 KB turns in production — then +33% again for base64 in the JSON
        // body. On an Indian mobile uplink that is most of a second spent
        // uploading before the recogniser has seen a byte. Speech is
        // transparent to STT at 24 kbps and Saaras is trained on telephony,
        // which is worse than this. Five times less to send, same words back.
        var conf = { audioBitsPerSecond: Number(opts.bitrate || 24000) };
        if (mime) conf.mimeType = mime;
        rec = new MediaRecorder(stream, conf);
        rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
        rec.start();
        recStarted = (global.performance && performance.now) ? performance.now() : Date.now();
      } catch (e) { rec = null; }
    }

    /* THE RECORDER MUST NOT ACCUMULATE THE WHOLE CALL.
       ---------------------------------------------------------------
       It used to start once per utterance and run until the NEXT utterance
       ended — which meant the blob held every second of silence in between and
       the whole of Anaga's turn as well. Saaras rejects anything over thirty
       seconds, so a pause while she talked produced HTTP 400, which surfaced in
       the browser as "brain unavailable" — a message about the one component
       that was working perfectly.

       It was visible in the logs before it broke anything: a 24 kbps recorder
       reporting 830 kbps, because the bytes covered far more time than the
       prospect had spoken.

       So while nobody is talking, the recorder is cycled: stopped and started
       fresh, discarding what it has. The buffer therefore holds at most
       IDLE_RESET_MS of run-up plus the utterance itself. The run-up is not
       waste — it is the pre-roll that catches the first syllable, which the
       onset detector would otherwise clip. */
    var IDLE_RESET_MS = 1000;
    var recStarted = 0;

    var cycles = 0;
    function cycleIfIdle(now) {
      if (speaking || !rec || rec.state === "inactive") return;
      if (now - recStarted < IDLE_RESET_MS) return;
      var r = rec;
      rec = null;
      cycles++;
      r.onstop = function () { chunks = []; startRecorder(); };
      try { r.stop(); } catch (e) { startRecorder(); }
    }

    /** Close the current utterance and hand it over. */
    function finish(ms) {
      var r = rec;
      rec = null;
      if (!r || r.state === "inactive") { startRecorder(); return; }
      r.onstop = function () {
        var blob = new Blob(chunks, { type: mime || "audio/webm" });
        chunks = [];
        // A new recorder immediately: each utterance is its own standalone
        // file. WebM chunks after the first carry no header, so slicing one
        // long recording would produce something no decoder will open.
        startRecorder();
        if (blob.size > 0 && opts.onUtterance) opts.onUtterance({ blob: blob, mime: mime, ms: ms });
      };
      try { r.stop(); } catch (e) { startRecorder(); }
    }

    function tick(now) {
      if (closed || !analyser) return;
      requestAnimationFrame(tick);
      var dt = last ? Math.min(120, now - last) : 16;
      last = now;

      var level = rms();
      if (opts.onLevel) opts.onLevel(Math.min(1, level * 6));

      // LEARN THE ROOM before deciding anything. The window fills itself from
      // here on; this only holds the gate shut until there is enough history to
      // take a percentile of. Taking the MAXIMUM, as it used to, meant one door
      // closing during the first 600ms set the floor to the bang and the
      // microphone stayed deaf for the whole call.
      if (!floorReady) {
        calibMs += dt;
        gate(level, false, dt);            // fill the window, decide nothing
        if (calibMs >= CALIBRATE_MS) floorReady = true;
        return;
      }
      var isVoice = gate(level, speechLike(), dt);
      // Keep the buffer bounded while the line is quiet — see cycleIfIdle.
      if (!isVoice) cycleIfIdle(now);

      if (!speaking) {
        onsetMs = isVoice ? onsetMs + dt : 0;
        if (onsetMs >= ONSET_MS) {
          speaking = true; speechMs = onsetMs; silenceMs = 0; onsetMs = 0;
          if (opts.onSpeechStart) opts.onSpeechStart();
        }
        return;
      }

      speechMs += dt;
      silenceMs = isVoice ? 0 : silenceMs + dt;
      if (silenceMs >= silenceBudget(speechMs - silenceMs) || speechMs >= MAX_UTTERANCE_MS) {
        var spoken = speechMs - silenceMs;
        speaking = false; speechMs = 0; silenceMs = 0;
        // Too short to be a sentence: a cough, a knock, a chair.
        if (spoken >= MIN_SPEECH_MS) finish(spoken);
      }
    }

    return {
      mime: function () { return mime; },
      /** Must be called inside a user gesture — browsers require it. */
      open: function () {
        if (running || closed) return Promise.resolve(false);
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          if (opts.onError) opts.onError("unavailable");
          return Promise.resolve(false);
        }
        return navigator.mediaDevices.getUserMedia({
          audio: {
            // THE WHOLE POINT. Without this her voice reaches the recorder and
            // no amount of downstream cleverness reliably removes it.
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          }
        }).then(function (s) {
          if (closed) { s.getTracks().forEach(function (t) { t.stop(); }); return false; }
          stream = s;
          var AC = global.AudioContext || global.webkitAudioContext;
          ctx = new AC();
          analyser = ctx.createAnalyser();
          analyser.fftSize = 1024;
          // Smoothing is for meters, not decisions: the default 0.8 blurs a
          // frame into the several before it, which is precisely what a VAD
          // must not do.
          analyser.smoothingTimeConstant = 0.2;
          ctx.createMediaStreamSource(stream).connect(analyser);
          buf = new Uint8Array(analyser.fftSize);
          freq = new Uint8Array(analyser.frequencyBinCount);
          running = true;
          startRecorder();
          requestAnimationFrame(tick);
          return true;
        }).catch(function (err) {
          if (opts.onError) {
            opts.onError(err && (err.name === "NotAllowedError" || err.name === "SecurityError")
              ? "denied" : "unavailable");
          }
          return false;
        });
      },
      close: function () {
        closed = true; running = false;
        try { if (rec && rec.state !== "inactive") rec.stop(); } catch (e) {}
        rec = null;
        if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
        stream = null; analyser = null;
        if (ctx && ctx.close) { try { ctx.close(); } catch (e) {} }
        ctx = null;
      },
      isOpen: function () { return running; },
      _track: function () { return stream ? stream.getAudioTracks()[0] : null; },
      // Test seam: how many times the idle buffer has been thrown away. If this
      // stops growing while the line is quiet, the blob is accumulating again.
      _cycles: function () { return cycles; },
      // Test seams for the gate. The latching floor was invisible from outside
      // and took seconds of real audio to reproduce; this makes it a unit test.
      _gate: function (level, voiceish, dt) { floorReady = true; return gate(level, voiceish, dt || 16); },
      _floor: function () { return floor; },
      // Test seam: drive endpointing without a microphone.
      _feed: function (isVoice, dt) {
        if (!floorReady) { floorReady = true; }
        var d = dt || 100;
        if (!speaking) {
          onsetMs = isVoice ? onsetMs + d : 0;
          if (onsetMs >= ONSET_MS) {
            speaking = true; speechMs = onsetMs; silenceMs = 0; onsetMs = 0;
            if (opts.onSpeechStart) opts.onSpeechStart();
          }
          return;
        }
        speechMs += d;
        silenceMs = isVoice ? 0 : silenceMs + d;
        if (silenceMs >= silenceBudget(speechMs - silenceMs) || speechMs >= MAX_UTTERANCE_MS) {
          var spoken = speechMs - silenceMs;
          speaking = false; speechMs = 0; silenceMs = 0;
          if (spoken >= MIN_SPEECH_MS) finish(spoken);
        }
      }
    };
  }

  global.createMic = createMic;
})(window);
