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
    var stream = null, ctx = null, analyser = null, buf = null;
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

    var floor = 0, floorReady = false, calibMs = 0;
    var CALIBRATE_MS = 600;
    var speechMs = 0, silenceMs = 0, onsetMs = 0, speaking = false, last = 0;

    function rms() {
      analyser.getByteTimeDomainData(buf);
      var sum = 0;
      for (var i = 0; i < buf.length; i++) {
        var v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      return Math.sqrt(sum / buf.length);
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
      } catch (e) { rec = null; }
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

      // LEARN THE ROOM. During calibration, and continuously while quiet
      // afterwards, so a fan starting up or a window opening does not turn
      // into somebody talking.
      if (!floorReady) {
        calibMs += dt;
        floor = Math.max(floor, level);
        if (calibMs >= CALIBRATE_MS) { floorReady = true; }
        return;
      }
      var isVoice = level > Math.max(0.012, floor * 2.2);
      if (!isVoice && !speaking) floor = floor * 0.98 + level * 0.02;

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
          ctx.createMediaStreamSource(stream).connect(analyser);
          buf = new Uint8Array(analyser.fftSize);
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
