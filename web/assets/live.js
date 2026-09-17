/* ===================================================================
   Anaga — the live call, over one socket.

   WHAT THIS REPLACES, AND WHY
   ---------------------------
   demo-call.js records a whole utterance, base64s it into a JSON body, POSTs
   it, and waits for the transcript, the reply and the audio to be produced one
   after another. Everything painful about this product came from that shape,
   because a request/response transport cannot stream and cannot tell you
   anything until the prospect has stopped talking. So the browser grew:

     an energy VAD          that fired on a fan
     a silence timer        that was wrong in both directions
     a barge-in heuristic   that failed three times on real hardware
     a phrase splitter      to hide synthesis latency
     a backchannel          to cover the dead air that was left

   None of that is here. Audio goes up as it is captured, Deepgram's neural VAD
   decides when a turn ends, `user_started` is barge-in, and her voice comes
   back as a stream. The five heuristics above are replaced by four events.

   POINT IT AT A SERVER
   --------------------
   window.ANAGA_AGENT_URL = "wss://anaga-agent-xxxx.a.run.app/agent"
   ...before this file loads. Locally: "ws://localhost:8080/agent".

   A TICKET, WHEN THE AGENT WANTS ONE
   ----------------------------------
   window.ANAGA_AGENT_TICKET = "<token from /api/auth/agent-token>"

   The agent refuses the upgrade without it once AGENT_TOKEN_SECRET is set,
   which is what stops a stranger with the URL spending vendor credit. It goes
   in the query string because a browser WebSocket cannot set a header — hence
   its short life, since a query string reaches access logs and screen shares.
   =================================================================== */
(function (global) {
  "use strict";

  var SAMPLE_RATE = 16000;

  /* HALF-DUPLEX — WHY THE MICROPHONE CLOSES WHILE SHE TALKS
     ------------------------------------------------------
     `echoCancellation: true` is requested below and is NOT enough. Her audio is
     played through a Web Audio graph into ctx.destination, and Chrome's echo
     canceller does not reliably take that as its reference signal — so on
     anything but earphones her voice reaches the microphone essentially
     uncancelled.

     Downstream, Deepgram cannot tell her voice from the prospect's. It hears
     her, fires speech_start, the bridge reads that as barge-in and calls
     cutOff(). She interrupts herself, mid-sentence, every sentence — which is
     indistinguishable from "the microphone is interrupting everything".

     web/assets/app.js already learned this on the older path and wrote it down:
     real echo arrived as "calling" and "wonderful thank you" and both were
     committed as caller turns. Text filtering cannot fix it; both are under any
     sane threshold. Closing the microphone makes the echo PHYSICALLY
     IMPOSSIBLE rather than probabilistically filtered.

     Barge-in is not lost, it becomes explicit: interrupt() opens the mic mid
     sentence, which is the same gesture as talking over someone on a phone
     call. With earphones there is no acoustic path at all, so pass
     halfDuplex:false and open-mic barge-in works as before. */

  /** Her audio is out of the speaker but still in the air and in the buffer. */
  var HOLD_MS = 280;

  /** If a `speaking:false` is ever lost, the mic must not stay shut forever —
      that is a dead call with no error. Longer than any single utterance. */
  var MAX_MUTE_MS = 20000;

  /**
   * @param {object} o
   * @param {function} o.onEvent   server messages, for the transcript UI
   * @param {function} o.onState   ("connecting"|"live"|"closed"|"error", detail)
   */
  function createLiveCall(o) {
    var opts = o || {};
    var ws = null, ctx = null, stream = null, capture = null, playback = null;
    var closed = false;

    // Default ON: it is safe on every device, including the speakerphone in a
    // meeting room. Only earphones can afford to turn it off.
    var halfDuplex = opts.halfDuplex !== false;
    var muted = false;          // mic gated because she is speaking
    var resumeTimer = null;
    var deadman = null;

    function clearTimers() {
      if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null; }
      if (deadman) { clearTimeout(deadman); deadman = null; }
    }

    function setMuted(on) {
      if (muted === on) return;
      muted = on;
      if (opts.onMic) opts.onMic(!on);
    }

    /** Driven by the server's `speaking` event. */
    function onSpeaking(on) {
      if (!halfDuplex) return;
      clearTimers();
      if (on) {
        setMuted(true);
        deadman = setTimeout(function () { deadman = null; setMuted(false); }, MAX_MUTE_MS);
      } else {
        // Not instant: the tail of her last word is still leaving the speaker,
        // and reopening on the same tick captures it as the prospect talking.
        resumeTimer = setTimeout(function () { resumeTimer = null; setMuted(false); }, HOLD_MS);
      }
    }

    /**
     * Cut her off deliberately — the button version of talking over someone.
     *
     * Two things, in this order. The local buffer is dropped so she stops in
     * the same tick rather than after everything already sent finishes playing;
     * then the microphone opens, so the speech that follows reaches Deepgram,
     * fires speech_start, and the bridge performs a REAL barge-in — amending
     * the transcript with "…[cut off]" exactly as an acoustic one would. No new
     * server message: the existing path already does the right thing once it
     * can hear.
     */
    function interrupt() {
      if (!ws || ws.readyState !== 1) return false;
      clearTimers();
      if (playback) playback.port.postMessage("clear");
      setMuted(false);
      return true;
    }

    function url() {
      // VAAK_AGENT_URL is the pre-rename name. A phone that has the old page
      // cached still sets it, and a blank agent URL is a call that never
      // connects — so it is still honoured.
      if (global.ANAGA_AGENT_URL) return global.ANAGA_AGENT_URL;
      if (global.VAAK_AGENT_URL) return global.VAAK_AGENT_URL;
      // Same host, ws(s) scheme — right when the page is served BY the agent
      // service, which is how the local dev loop works.
      var proto = location.protocol === "https:" ? "wss:" : "ws:";
      return proto + "//" + location.host + "/agent";
    }

    /** Must be called inside a user gesture — browsers require it for audio. */
    /**
     * @param {string} lang
     * @param {string} direction
     * @param {{voice?:string, pace?:number}} [tone]  chosen per call; the
     *        server bounds both, because this comes from a browser.
     */
    function start(lang, direction, tone) {
      if (ws || closed) return Promise.resolve(false);
      if (opts.onState) opts.onState("connecting");
      global.__micLive = true;

      return navigator.mediaDevices.getUserMedia({
        audio: {
          // STILL THE WHOLE DESIGN. Deepgram's VAD is neural and Deepgram's
          // turn-taking is native, and neither can tell her voice from the
          // prospect's if the browser hands both to the socket. Echo
          // cancellation removes her BEFORE anything downstream sees it.
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      }).then(function (s) {
        stream = s;
        var AC = global.AudioContext || global.webkitAudioContext;
        ctx = new AC();
        // ABSOLUTE, and overridable. This read "assets/pcm-worklet.js", which
        // resolves against the DOCUMENT's URL: fine from /live.html at the
        // root of the agent, a 404 from /call on the Next.js site, where it
        // becomes /call/assets/pcm-worklet.js. addModule() rejects, the whole
        // start() chain lands in the catch, and the page reports "no
        // microphone available" — a permissions message for a missing file.
        return ctx.audioWorklet.addModule(global.ANAGA_WORKLET_URL || "/assets/pcm-worklet.js");
      }).then(function () {
        capture = new AudioWorkletNode(ctx, "anaga-capture", {
          processorOptions: { targetRate: SAMPLE_RATE }
        });
        playback = new AudioWorkletNode(ctx, "anaga-playback", {
          outputChannelCount: [1],
          // THE STREAM'S RATE, WHICH IS NOT THIS DEVICE'S RATE. Omitting this
          // is what made her speak three times too fast: the worklet wrote
          // 16kHz samples one per frame into an output rendered at 48kHz.
          // Capture has always been told its target; playback was not.
          processorOptions: { sourceRate: SAMPLE_RATE }
        });
        ctx.createMediaStreamSource(stream).connect(capture);
        playback.connect(ctx.destination);

        // THE CAPTURE NODE MUST REACH THE DESTINATION, THROUGH SILENCE.
        //
        // A Web Audio graph only pulls nodes on a path to ctx.destination. The
        // capture worklet produces no output, so connecting it to a dangling
        // gain node — which looks tidy — means it is never pulled, process()
        // never runs, and not one byte is ever captured. The socket opens, she
        // greets, and the microphone silently does nothing.
        //
        // So it is connected all the way through, at zero gain: in the graph,
        // and inaudible.
        var mute = ctx.createGain();
        mute.gain.value = 0;
        capture.connect(mute).connect(ctx.destination);

        return open(lang, direction, tone);
      }).catch(function (err) {
        if (opts.onState) {
          opts.onState("error", err && (err.name === "NotAllowedError" || err.name === "SecurityError")
            ? "microphone blocked — allow it and reload"
            : "no microphone available");
        }
        return false;
      });
    }

    /** The socket URL, carrying a ticket if the page was given one. */
    function withTicket(u) {
      var t = global.ANAGA_AGENT_TICKET;
      if (!t) return u;
      return u + (u.indexOf("?") < 0 ? "?" : "&") + "t=" + encodeURIComponent(t);
    }

    function open(lang, direction, tone) {
      return new Promise(function (done) {
        ws = new WebSocket(withTicket(url()));
        ws.binaryType = "arraybuffer";

        ws.onopen = function () {
          ws.send(JSON.stringify({
            type: "start", lang: lang, direction: direction,
            voice: (tone && tone.voice) || undefined,
            pace: (tone && tone.pace) || undefined
          }));
          // Audio only starts flowing once the socket is up. Anything captured
          // before then is dropped rather than queued: it is the moment before
          // the call connected, and replaying it makes her answer a noise from
          // before she was listening.
          capture.port.onmessage = function (e) {
            // DROPPED, never queued. Queuing would replay her own echo into the
            // recogniser a moment later, which is the bug with a delay on it.
            if (muted) return;
            if (ws && ws.readyState === 1) {
              ws.send(e.data);
              global.__sentBytes = (global.__sentBytes || 0) + e.data.byteLength;
            }
          };
          if (opts.onState) opts.onState("live");
          done(true);
        };

        ws.onmessage = function (e) {
          if (typeof e.data !== "string") {
            global.__gotAudio = (global.__gotAudio || 0) + e.data.byteLength;
            playback.port.postMessage(e.data, [e.data]);
            return;
          }
          var m;
          try { m = JSON.parse(e.data); } catch (err) { return; }
          // BARGE-IN reaches the speaker before it reaches the UI. Everything
          // already buffered is dropped in the same tick.
          if (m.type === "clear") playback.port.postMessage("clear");
          if (m.type === "speaking") onSpeaking(Boolean(m.value));
          if (opts.onEvent) opts.onEvent(m);
          if (m.type === "ended") stop();
        };

        ws.onerror = function () { if (opts.onState) opts.onState("error", "connection failed"); done(false); };
        ws.onclose = function () { if (!closed && opts.onState) opts.onState("closed"); };
      });
    }

    function stop() {
      if (closed) return;
      closed = true;
      clearTimers();
      try { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "stop" })); } catch (e) {}
      try { if (ws) ws.close(); } catch (e) {}
      if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
      global.__micLive = false;
      if (ctx && ctx.close) { try { ctx.close(); } catch (e) {} }
      ws = null; stream = null; ctx = null; capture = null; playback = null;
    }

    return {
      start: start,
      stop: stop,
      interrupt: interrupt,
      /** True while the mic is closed because she is speaking. */
      isMuted: function () { return muted; },
      /** Earphones only — see the HALF-DUPLEX note at the top. */
      setHalfDuplex: function (on) {
        halfDuplex = Boolean(on);
        if (!halfDuplex) { clearTimers(); setMuted(false); }
      },
      isHalfDuplex: function () { return halfDuplex; },
      isLive: function () { return Boolean(ws) && ws.readyState === 1; },
      /** Test seam: what the page would connect to. */
      _url: url
    };
  }

  global.createLiveCall = createLiveCall;
})(window);
