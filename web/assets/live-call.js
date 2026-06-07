/* ===================================================================
   Anaga LIVE CALL — real-time, full-duplex voice via the Gemini Live API.

   A self-contained `window.LiveCall` module: it mints a short-lived ephemeral
   token from /api/live/token (the raw GEMINI_API_KEY never reaches the browser),
   opens the Gemini Live WebSocket DIRECTLY to Google, streams the mic up as
   16 kHz PCM16, and plays Anaga's 24 kHz PCM16 reply back gap-free — with
   barge-in (the caller can talk over her and she stops instantly).

   This is the "native audio" path: Gemini hears and speaks itself (no separate
   STT/TTS), so it's genuinely conversational and multilingual (Telugu / Hindi /
   English, code-mixed). It complements the turn-based demo in app.js; that one
   stays as the fallback when this isn't available.

   Vanilla JS, no build step, no npm deps. Fail-soft everywhere: if anything is
   missing (no key, no WebSocket/AudioContext/mic, mint fails), isAvailable()
   stays false and the caller keeps using the turn-based flow.

   ── Verified Gemini Live facts used (Google docs, 2026) ──
   • WS endpoint (ephemeral-token / v1alpha):
       wss://generativelanguage.googleapis.com/ws/
         google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained
         ?access_token=<token>
   • First client message is { setup: { model, generationConfig, systemInstruction, ... } };
     wait for { setupComplete } before streaming.
   • Mic up:   { realtimeInput: { audio: { data: <b64 PCM16>, mimeType: "audio/pcm;rate=16000" } } }
   • Model down: serverContent.modelTurn.parts[].inlineData.data  (base64 PCM16 @ 24 kHz)
   • Barge-in:  serverContent.interrupted === true  → flush playback immediately.
   • Turn end:  serverContent.turnComplete === true.
   • Transcripts (opt-in via setup.inputAudioTranscription / outputAudioTranscription):
       serverContent.inputTranscription.text  /  serverContent.outputTranscription.text
   • Native-audio models auto-detect & switch language; steer via the system prompt.
   Docs: https://ai.google.dev/gemini-api/docs/live-api
         https://ai.google.dev/gemini-api/docs/live-api/capabilities
   =================================================================== */
(function () {
  'use strict';

  /* ---- constants verified against the Live API docs ---- */
  const TOKEN_URL   = '/api/live/token';
  const WS_BASE     = 'wss://generativelanguage.googleapis.com/ws/' +
                      'google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained';
  const IN_RATE     = 16000;   // mic is resampled to 16 kHz PCM16 before sending
  const OUT_RATE    = 24000;   // model audio is 24 kHz PCM16
  const SEND_MS     = 40;      // chunk size we ship mic audio in (latency vs. overhead)

  /* Anaga's persona for the live session — mirrors api/_lib/prompts.js (SYL_RULES)
     and web/assets/llm-client.js, tuned for SPOKEN, full-duplex audio. Overridable
     via opts.systemPrompt. */
  const DEFAULT_PERSONA = [
    "You are Anaga — a warm, sharp, genuinely conversational female AI voice agent for Modcon",
    "Builders (a real-estate developer), on a live phone call about 'SYL Residences' at Tukkuguda.",
    "You sound like a real person on the phone, not a script being read. Keep turns short and",
    "natural — this is a real-time voice call, so one or two spoken sentences at a time, and let",
    "the caller talk.",
    "PROJECT: 'SYL Residences, Tukkuguda' (the Modcon One development) — a ~4.5-acre integrated",
    "residential + commercial project in Tukkuguda, South Hyderabad, on the 200ft Srisailam Highway",
    "off ORR Exit-14: ~5 min to Fab City, 10-15 min to the RGI airport, Aga Khan Academy and Statue",
    "of Equality, ~30-45 min to the Financial District. Residential: low-density biophilic",
    "'villaments' with big balconies and forest views, and a 22,000 sft clubhouse (infinity pool,",
    "gym, yoga, sauna, library, co-working, banquet). Commercial: a G+4 block (retail, co-working,",
    "healthcare, business-stay). Modcon also has a SEPARATE project 'Agartha' (agartha.in) — only",
    "mention it if asked about other projects. Contact +91 95348 69999, info@modconbuilders.com.",
    "For exact prices, sizes, floor plans, RERA or possession you don't have, offer modcon.in /",
    "WhatsApp / the site visit — never invent specifics.",
    "LANGUAGE: speak in the SAME language the caller uses — English, Hindi, or Telugu, or natural",
    "code-mixing. If they switch language, you switch too. Use everyday spoken phrasing.",
    "CONVERSE, DON'T INTERROGATE: actually listen and respond. If they ask anything (price,",
    "location, size, possession, loan/EMI, amenities, builder), answer it directly and honestly",
    "FIRST, then gently continue. Briefly acknowledge what they said so it feels human.",
    "DISCLOSURE: in your very first turn, say you're an AI voice agent from Modcon Builders calling",
    "about SYL Residences at Tukkuguda, and check it's a good time; don't start qualifying until they agree. If",
    "it's a bad time, offer to call later and end warmly.",
    "QUALIFY conversationally — over the call learn purpose (to live in vs investment), budget,",
    "configuration (BHK/villa) and timeline; weave them in, never fire a checklist, never re-ask",
    "what they've answered.",
    "SITE VISIT: once they're warm, recommend SYL Residences and offer a site visit this",
    "weekend; if they agree, book Saturday or Sunday and confirm.",
    "OPT-OUT: if at any point they want out ('not interested', 'don't call', 'remove me', or the",
    "Hindi/Telugu equivalent), acknowledge warmly, say you're adding them to the do-not-call list,",
    "apologise, and end the call. Never persuade after that.",
    "HONESTY: you qualify and book; humans close. Never claim to close a deal or quote a final",
    "price, and don't invent specifics you weren't given — offer to confirm exact details on the",
    "visit or over WhatsApp."
  ].join(' ');

  /* ---- module-private state for a single active call ---- */
  let available = null;          // null = unknown, true / false after probe()
  let probedModel = null;        // model reported by the GET probe

  let session = null;            // the current live session object (see start())

  /* ============================ utilities ============================ */

  function supportsLive() {
    return typeof window !== 'undefined' &&
      typeof window.WebSocket === 'function' &&
      !!(window.AudioContext || window.webkitAudioContext) &&
      !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  // Float32 [-1,1] PCM -> little-endian Int16 -> base64 (what realtimeInput.audio wants).
  function floatToB64PCM16(float32) {
    const len = float32.length;
    const buf = new ArrayBuffer(len * 2);
    const view = new DataView(buf);
    for (let i = 0; i < len; i++) {
      let s = float32[i];
      s = s < -1 ? -1 : (s > 1 ? 1 : s);
      view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
    return bytesToB64(new Uint8Array(buf));
  }

  // base64 -> Float32 [-1,1] from little-endian Int16 PCM (model audio out).
  function b64PCM16ToFloat(b64) {
    const bytes = b64ToBytes(b64);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const n = Math.floor(bytes.byteLength / 2);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true) / 0x8000;
    return out;
  }

  function bytesToB64(bytes) {
    let bin = '';
    const chunk = 0x8000;                 // avoid arg-count limits on big buffers
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // Linear-resample a Float32 buffer from srcRate -> dstRate (mono).
  function resample(input, srcRate, dstRate) {
    if (srcRate === dstRate) return input;
    const ratio = srcRate / dstRate;
    const outLen = Math.max(1, Math.round(input.length / ratio));
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const pos = i * ratio;
      const i0 = Math.floor(pos);
      const i1 = Math.min(i0 + 1, input.length - 1);
      const frac = pos - i0;
      out[i] = input[i0] * (1 - frac) + input[i1] * frac;   // linear interpolation
    }
    return out;
  }

  /* ====================== capability probe ====================== */

  /**
   * LiveCall.probe() -> Promise<boolean>
   * Asks GET /api/live/token whether a live token can be minted, AND checks the
   * browser can actually do realtime audio. Caches the result.
   */
  function probe() {
    if (!supportsLive()) { available = false; return Promise.resolve(false); }
    return fetch(TOKEN_URL)
      .then(function (r) { return r.ok ? r.json() : { available: false }; })
      .then(function (d) {
        available = !!(d && d.available);
        if (d && d.model) probedModel = d.model;
        return available;
      })
      .catch(function () { available = false; return false; });
  }

  /** LiveCall.isAvailable() -> boolean (only true once probe() confirmed it). */
  function isAvailable() { return available === true; }

  /* ====================== mic capture ====================== */

  // The AudioWorklet processor source — forwards raw mono frames to the main
  // thread, where we resample + encode + send. Loaded as a Blob URL so this
  // module stays a single self-contained file (no extra asset to deploy).
  const WORKLET_SRC = [
    'class MicProcessor extends AudioWorkletProcessor {',
    '  process(inputs) {',
    '    const ch = inputs[0] && inputs[0][0];',
    '    if (ch && ch.length) { this.port.postMessage(ch.slice(0)); }',
    '    return true;',
    '  }',
    '}',
    'registerProcessor("anaga-mic", MicProcessor);'
  ].join('\n');

  // Start streaming mic audio. Prefers AudioWorklet; falls back to
  // ScriptProcessorNode where AudioWorklet is unavailable.
  function startMicCapture(s) {
    const ctx = s.inCtx;
    const srcNode = ctx.createMediaStreamSource(s.micStream);
    s.micSource = srcNode;

    const onFrames = function (float32) {
      if (!s.alive || s.muted) return;
      // resample this device's rate down to 16 kHz, then encode + send.
      const down = resample(float32, ctx.sampleRate, IN_RATE);
      // buffer small frames into ~SEND_MS chunks to reduce WS overhead.
      s.micBuf.push(down);
      s.micBufLen += down.length;
      const need = Math.round(IN_RATE * SEND_MS / 1000);
      while (s.micBufLen >= need) {
        const chunk = new Float32Array(need);
        let off = 0;
        while (off < need && s.micBuf.length) {
          const head = s.micBuf[0];
          const take = Math.min(head.length, need - off);
          chunk.set(head.subarray(0, take), off);
          off += take;
          if (take === head.length) s.micBuf.shift();
          else s.micBuf[0] = head.subarray(take);
        }
        s.micBufLen -= need;
        sendAudioChunk(s, floatToB64PCM16(chunk));
      }
    };

    if (typeof ctx.audioWorklet !== 'undefined' && typeof AudioWorkletNode === 'function') {
      const blobUrl = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
      return ctx.audioWorklet.addModule(blobUrl)
        .then(function () {
          URL.revokeObjectURL(blobUrl);
          const node = new AudioWorkletNode(ctx, 'anaga-mic');
          node.port.onmessage = function (e) { onFrames(e.data); };
          srcNode.connect(node);
          // Worklet needs a graph sink to be pulled in some browsers; route to a
          // muted gain so nothing is actually audible.
          const sink = ctx.createGain(); sink.gain.value = 0;
          node.connect(sink); sink.connect(ctx.destination);
          s.micWorklet = node;
          s.micSink = sink;
        })
        .catch(function () {
          // Worklet failed (CSP, older browser) — degrade to ScriptProcessor.
          try { URL.revokeObjectURL(blobUrl); } catch (_) {}
          startScriptProcessor(s, srcNode, ctx, onFrames);
        });
    }

    startScriptProcessor(s, srcNode, ctx, onFrames);
    return Promise.resolve();
  }

  function startScriptProcessor(s, srcNode, ctx, onFrames) {
    // Deprecated but universally supported fallback.
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    proc.onaudioprocess = function (ev) { onFrames(ev.inputBuffer.getChannelData(0)); };
    srcNode.connect(proc);
    const sink = ctx.createGain(); sink.gain.value = 0;
    proc.connect(sink); sink.connect(ctx.destination);
    s.micProc = proc;
    s.micSink = sink;
  }

  function sendAudioChunk(s, b64) {
    if (!s.alive || !s.ws || s.ws.readyState !== WebSocket.OPEN || !s.setupDone) return;
    try {
      s.ws.send(JSON.stringify({
        realtimeInput: { audio: { data: b64, mimeType: 'audio/pcm;rate=' + IN_RATE } }
      }));
    } catch (_) { /* socket race — ignore, next chunk will retry */ }
  }

  /* ====================== gap-free playback ======================
     We schedule each chunk of model audio back-to-back on the output
     AudioContext clock so there are no clicks/gaps between chunks. On barge-in
     (serverContent.interrupted) we stop every queued source instantly. */

  function playChunk(s, float32) {
    const ctx = s.outCtx;
    if (!ctx) return;
    const buf = ctx.createBuffer(1, float32.length, OUT_RATE);
    buf.getChannelData(0).set(float32);
    const node = ctx.createBufferSource();
    node.buffer = buf;
    node.connect(ctx.destination);

    const now = ctx.currentTime;
    // Start where the previous chunk ends; if we've fallen behind, restart from now
    // (+ a tiny lead so the first sample isn't clipped).
    const startAt = Math.max(now + 0.02, s.playHead || 0);
    node.start(startAt);
    s.playHead = startAt + buf.duration;
    s.sources.push(node);
    node.onended = function () {
      const i = s.sources.indexOf(node);
      if (i >= 0) s.sources.splice(i, 1);
      // queue drained while a turn is still open -> back to "listening"
      if (s.alive && s.sources.length === 0 && s.speaking) {
        s.speaking = false;
        setStatus(s, 'listening');
      }
    };

    if (!s.speaking) { s.speaking = true; setStatus(s, 'speaking'); }
  }

  // Barge-in / interruption: drop everything queued so Anaga goes quiet at once.
  function flushPlayback(s) {
    while (s.sources.length) {
      const node = s.sources.pop();
      try { node.onended = null; node.stop(); } catch (_) {}
      try { node.disconnect(); } catch (_) {}
    }
    s.playHead = 0;
    if (s.speaking) { s.speaking = false; setStatus(s, 'listening'); }
  }

  /* ====================== status / callbacks ====================== */

  function setStatus(s, state) {
    if (s.lastState === state) return;
    s.lastState = state;
    safe(s.cb.onStatus, state);
  }
  function safe(fn, arg) { if (typeof fn === 'function') { try { fn(arg); } catch (_) {} } }

  /* ====================== server message handling ====================== */

  function handleServerMessage(s, raw) {
    let data;
    try { data = JSON.parse(raw); } catch (_) { return; }

    // 1) setup acknowledged -> we can stream mic audio now.
    if (data.setupComplete) {
      s.setupDone = true;
      setStatus(s, 'listening');
      return;
    }

    const sc = data.serverContent;
    if (!sc) return;

    // 2) barge-in: caller talked over Anaga -> stop her audio immediately.
    if (sc.interrupted) { flushPlayback(s); }

    // 3) model audio + any text parts.
    const parts = sc.modelTurn && sc.modelTurn.parts;
    if (Array.isArray(parts)) {
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        if (!p) continue;
        if (p.inlineData && typeof p.inlineData.data === 'string') {
          // Audio is the only modality we asked for, but guard on mimeType anyway.
          const mt = p.inlineData.mimeType || '';
          if (!mt || /audio|pcm/i.test(mt)) {
            try { playChunk(s, b64PCM16ToFloat(p.inlineData.data)); } catch (_) {}
          }
        } else if (typeof p.text === 'string' && p.text) {
          // Rare for native-audio, but surface any text the model emits.
          safe(s.cb.onAgentText, p.text);
        }
      }
    }

    // 4) transcripts (when enabled in setup). These can arrive alongside audio,
    //    so they're checked independently — not as else-if with the audio above.
    if (sc.inputTranscription && typeof sc.inputTranscription.text === 'string' && sc.inputTranscription.text) {
      safe(s.cb.onUserText, sc.inputTranscription.text);
    }
    if (sc.outputTranscription && typeof sc.outputTranscription.text === 'string' && sc.outputTranscription.text) {
      safe(s.cb.onAgentText, sc.outputTranscription.text);
    }
  }

  /* ====================== setup message ====================== */

  function modelResource(model) {
    return /^models\//.test(model) ? model : 'models/' + model;
  }

  function buildSetup(model, systemPrompt) {
    // generationConfig.responseModalities must match the token constraint (AUDIO).
    // We enable input+output transcription so the caller can show a live
    // transcript; native-audio models pick the spoken language automatically.
    return {
      setup: {
        model: modelResource(model),
        generationConfig: {
          responseModalities: ['AUDIO']
        },
        systemInstruction: { parts: [{ text: systemPrompt }] },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        // Automatic VAD is on by default; the server emits `interrupted` when the
        // caller talks over Anaga, which we honor in handleServerMessage (barge-in).
        realtimeInputConfig: {
          automaticActivityDetection: {},
          activityHandling: 'START_OF_ACTIVITY_INTERRUPTS'
        }
      }
    };
  }

  /* ====================== start / stop ====================== */

  /**
   * LiveCall.start(opts) -> Promise (resolves once connecting begins)
   * opts = {
   *   lang,                 // optional hint (e.g. "te-IN"); native-audio auto-detects anyway
   *   systemPrompt,         // override Anaga's persona
   *   onStatus(state),      // "connecting" | "listening" | "speaking" | "closed"
   *   onAgentText(t),       // Anaga's words (from output transcription)
   *   onUserText(t),        // caller's words (from input transcription)
   *   onError(err),         // any fatal error (call is torn down after)
   *   onClose()             // socket closed / call ended
   * }
   */
  function start(opts) {
    opts = opts || {};
    // Only one live call at a time.
    if (session && session.alive) { try { stop(); } catch (_) {} }

    if (!supportsLive()) {
      const e = new Error('live_unsupported');
      safe(opts.onError, e);
      return Promise.reject(e);
    }

    const AC = window.AudioContext || window.webkitAudioContext;

    const s = {
      alive: true,
      muted: false,
      setupDone: false,
      speaking: false,
      lastState: null,
      cb: {
        onStatus: opts.onStatus, onAgentText: opts.onAgentText, onUserText: opts.onUserText,
        onError: opts.onError, onClose: opts.onClose
      },
      ws: null,
      // capture
      inCtx: new AC({ sampleRate: IN_RATE }),    // hint; browser may ignore & we resample
      micStream: null, micSource: null, micWorklet: null, micProc: null, micSink: null,
      micBuf: [], micBufLen: 0,
      // playback
      outCtx: new AC({ sampleRate: OUT_RATE }),
      sources: [], playHead: 0,
    };
    session = s;

    const persona = (typeof opts.systemPrompt === 'string' && opts.systemPrompt.trim())
      ? opts.systemPrompt
      : DEFAULT_PERSONA;
    // Optional explicit-language nudge layered on top of the persona.
    const langHint = (typeof opts.lang === 'string' && opts.lang)
      ? '\n\nThe caller is likely speaking ' + opts.lang +
        ' — open in that language, but always follow the caller if they switch.'
      : '';
    const systemPrompt = persona + langHint;

    setStatus(s, 'connecting');

    // 1) mint an ephemeral token (server-side key never reaches us), 2) grab the
    // mic, in parallel; then 3) open the WS and 4) start capture.
    const tokenP = fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lang: opts.lang || '' })
    }).then(function (r) {
      if (!r.ok) throw new Error('token_' + r.status);
      return r.json();
    });

    const micP = navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false
    });

    return Promise.all([tokenP, micP])
      .then(function (results) {
        if (!s.alive) throw new Error('aborted');
        const tok = results[0];
        s.micStream = results[1];
        if (!tok || !tok.token) throw new Error('no_token');
        const model = tok.model || probedModel || '';

        // resume contexts (autoplay policies suspend them until a user gesture;
        // start() is called from a click, so this succeeds).
        try { if (s.outCtx.state === 'suspended') s.outCtx.resume(); } catch (_) {}
        try { if (s.inCtx.state === 'suspended') s.inCtx.resume(); } catch (_) {}

        openSocket(s, tok.token, model, systemPrompt);
        return startMicCapture(s);
      })
      .catch(function (err) {
        // Any failure (mint, mic permission, etc.) -> clean teardown + fail soft.
        teardown(s);
        safe(s.cb.onError, err instanceof Error ? err : new Error(String(err)));
        safe(s.cb.onClose);
      });
  }

  function openSocket(s, token, model, systemPrompt) {
    const url = WS_BASE + '?access_token=' + encodeURIComponent(token);
    let ws;
    try { ws = new WebSocket(url); } catch (e) { throw new Error('ws_open_failed'); }
    s.ws = ws;
    ws.binaryType = 'arraybuffer';

    // Guard: if setup is never acknowledged, give up rather than hang silently.
    s.setupWatchdog = setTimeout(function () {
      if (s.alive && !s.setupDone) {
        safe(s.cb.onError, new Error('live_setup_timeout'));
        stop();
      }
    }, 12000);

    ws.onopen = function () {
      if (!s.alive) return;
      try { ws.send(JSON.stringify(buildSetup(model, systemPrompt))); }
      catch (e) { safe(s.cb.onError, new Error('setup_send_failed')); stop(); }
    };

    ws.onmessage = function (ev) {
      if (!s.alive) return;
      const d = ev.data;
      if (typeof d === 'string') { handleServerMessage(s, d); }
      else if (d instanceof ArrayBuffer) { handleServerMessage(s, new TextDecoder().decode(d)); }
      else if (d && typeof d.text === 'function') { d.text().then(function (t) { handleServerMessage(s, t); }); } // Blob
    };

    ws.onerror = function () {
      if (!s.alive) return;
      safe(s.cb.onError, new Error('live_ws_error'));
      // onclose follows and does the teardown.
    };

    ws.onclose = function () {
      if (!s.alive) return;
      teardown(s);
      setStatus(s, 'closed');
      safe(s.cb.onClose);
    };
  }

  /** LiveCall.mute(on) — optional: stop sending mic audio without dropping the call. */
  function mute(on) { if (session) session.muted = !!on; }

  /** LiveCall.stop() — cleanly end the call: close WS, stop mic, stop audio. */
  function stop() {
    const s = session;
    if (!s) return;
    const wasAlive = s.alive;
    teardown(s);
    if (wasAlive) { setStatus(s, 'closed'); safe(s.cb.onClose); }
  }

  // Release every resource. Idempotent and never throws.
  function teardown(s) {
    if (!s) return;
    s.alive = false;
    if (s.setupWatchdog) { clearTimeout(s.setupWatchdog); s.setupWatchdog = null; }

    // socket
    if (s.ws) {
      try { s.ws.onopen = s.ws.onmessage = s.ws.onerror = s.ws.onclose = null; } catch (_) {}
      try { if (s.ws.readyState === WebSocket.OPEN || s.ws.readyState === WebSocket.CONNECTING) s.ws.close(); } catch (_) {}
      s.ws = null;
    }

    // playback
    try { flushPlayback(s); } catch (_) {}

    // mic graph
    try { if (s.micWorklet) { s.micWorklet.port.onmessage = null; s.micWorklet.disconnect(); } } catch (_) {}
    try { if (s.micProc) { s.micProc.onaudioprocess = null; s.micProc.disconnect(); } } catch (_) {}
    try { if (s.micSink) s.micSink.disconnect(); } catch (_) {}
    try { if (s.micSource) s.micSource.disconnect(); } catch (_) {}
    s.micWorklet = s.micProc = s.micSink = s.micSource = null;
    s.micBuf = []; s.micBufLen = 0;

    // mic tracks
    try { if (s.micStream) s.micStream.getTracks().forEach(function (t) { try { t.stop(); } catch (_) {} }); } catch (_) {}
    s.micStream = null;

    // audio contexts
    try { if (s.inCtx && s.inCtx.state !== 'closed') s.inCtx.close(); } catch (_) {}
    try { if (s.outCtx && s.outCtx.state !== 'closed') s.outCtx.close(); } catch (_) {}
    s.inCtx = s.outCtx = null;

    if (session === s) session = null;
  }

  // Best-effort cleanup if the tab is closed mid-call.
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', function () { try { stop(); } catch (_) {} });
  }

  /* ---- public API ---- */
  window.LiveCall = {
    probe: probe,
    isAvailable: isAvailable,
    start: start,
    stop: stop,
    mute: mute,
    DEFAULT_PERSONA: DEFAULT_PERSONA
  };
})();
