/* ===================================================================
   Vaak — the live call, over one socket.

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
   window.VAAK_AGENT_URL = "wss://vaak-agent-xxxx.a.run.app/agent"
   ...before this file loads. Locally: "ws://localhost:8080/agent".
   =================================================================== */
(function (global) {
  "use strict";

  var SAMPLE_RATE = 16000;

  /**
   * @param {object} o
   * @param {function} o.onEvent   server messages, for the transcript UI
   * @param {function} o.onState   ("connecting"|"live"|"closed"|"error", detail)
   */
  function createLiveCall(o) {
    var opts = o || {};
    var ws = null, ctx = null, stream = null, capture = null, playback = null;
    var closed = false;

    function url() {
      if (global.VAAK_AGENT_URL) return global.VAAK_AGENT_URL;
      // Same host, ws(s) scheme — right when the page is served BY the agent
      // service, which is how the local dev loop works.
      var proto = location.protocol === "https:" ? "wss:" : "ws:";
      return proto + "//" + location.host + "/agent";
    }

    /** Must be called inside a user gesture — browsers require it for audio. */
    function start(lang, direction) {
      if (ws || closed) return Promise.resolve(false);
      if (opts.onState) opts.onState("connecting");

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
        return ctx.audioWorklet.addModule("assets/pcm-worklet.js");
      }).then(function () {
        capture = new AudioWorkletNode(ctx, "vaak-capture", {
          processorOptions: { targetRate: SAMPLE_RATE }
        });
        playback = new AudioWorkletNode(ctx, "vaak-playback", {
          outputChannelCount: [1]
        });
        ctx.createMediaStreamSource(stream).connect(capture);
        playback.connect(ctx.destination);
        // The capture node produces no output; connecting it to nothing would
        // let some browsers garbage-collect it mid-call.
        capture.connect(ctx.createGain());

        return open(lang, direction);
      }).catch(function (err) {
        if (opts.onState) {
          opts.onState("error", err && (err.name === "NotAllowedError" || err.name === "SecurityError")
            ? "microphone blocked — allow it and reload"
            : "no microphone available");
        }
        return false;
      });
    }

    function open(lang, direction) {
      return new Promise(function (done) {
        ws = new WebSocket(url());
        ws.binaryType = "arraybuffer";

        ws.onopen = function () {
          ws.send(JSON.stringify({ type: "start", lang: lang, direction: direction }));
          // Audio only starts flowing once the socket is up. Anything captured
          // before then is dropped rather than queued: it is the moment before
          // the call connected, and replaying it makes her answer a noise from
          // before she was listening.
          capture.port.onmessage = function (e) {
            if (ws && ws.readyState === 1) ws.send(e.data);
          };
          if (opts.onState) opts.onState("live");
          done(true);
        };

        ws.onmessage = function (e) {
          if (typeof e.data !== "string") { playback.port.postMessage(e.data, [e.data]); return; }
          var m;
          try { m = JSON.parse(e.data); } catch (err) { return; }
          // BARGE-IN reaches the speaker before it reaches the UI. Everything
          // already buffered is dropped in the same tick.
          if (m.type === "clear") playback.port.postMessage("clear");
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
      try { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "stop" })); } catch (e) {}
      try { if (ws) ws.close(); } catch (e) {}
      if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
      if (ctx && ctx.close) { try { ctx.close(); } catch (e) {} }
      ws = null; stream = null; ctx = null; capture = null; playback = null;
    }

    return {
      start: start,
      stop: stop,
      isLive: function () { return Boolean(ws) && ws.readyState === 1; },
      /** Test seam: what the page would connect to. */
      _url: url
    };
  }

  global.createLiveCall = createLiveCall;
})(window);
