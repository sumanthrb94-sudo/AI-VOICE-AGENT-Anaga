/* ===================================================================
   Vaak — Bulbul v3 Telugu voice sampler.

   A thin wrapper over one thing: Sarvam Bulbul speaking Telugu. Everything
   else that used to be on this page — the language pills, the live call demo,
   the on-device speech fallback, the seven invented presets — is gone. Each of
   them was a place the audio could come from somewhere other than Bulbul, and
   every one of those places produced a bug that took a session to find.

   THREE RULES THIS FILE KEEPS:

   1. NOTHING PLAYS UNTIL A TAP. No preview on selection, no autoplay, no
      priming utterance you can hear. A page that speaks on its own is how the
      handset's own voice got mistaken for ours for two days.

   2. ONE UNLOCKED <audio> ELEMENT, REUSED. Browsers only let audio start
      inside a user gesture, and a fresh Audio() built after an await is not
      unlocked — it is rejected, silently. The element is unlocked on the first
      tap and every clip afterwards plays through that same element.

   3. LATENCY IS SHOWN, NOT CLAIMED. Each card displays its own measured
      time-to-first-audio. "It feels slow" and "it is 1.4s" are different
      conversations, and only one of them can be fixed.

   4. BOTH SIDES OF THE CONVERSATION ARE WRITTEN DOWN AS THEY HAPPEN. What was
      heard and what was said are the only evidence of whether the agent is
      working; without them "it said something wrong" cannot be checked.
   =================================================================== */
(function () {
  "use strict";

  var LANG = "te-IN";
  // Long enough to judge prosody, short enough that synthesis is quick — the
  // sample IS the latency test, so a paragraph would measure the wrong thing.
  var SAMPLE = "నమస్కారం, నేను అనగా. మీరు అడిగిన ఇంటి గురించి మాట్లాడటానికి కాల్ చేశాను.";

  var $ = function (id) { return document.getElementById(id); };
  var statusEl = $("status"), grid = $("voices"), modelEl = $("model");
  var paceEl = $("pace"), pitchEl = $("pitch"), paceV = $("paceV"), pitchV = $("pitchV");
  var logEl = $("log"), talkBtn = $("talk"), talkState = $("talkstate");
  var sayForm = $("sayform"), sayInput = $("saytxt");

  function say(msg, isErr) {
    statusEl.textContent = msg;
    statusEl.className = isErr ? "err" : "";
  }

  /* ---------------- audio: one element, unlocked once ---------------- */
  var el = null, unlocked = false, playing = null;
  // 44-byte WAV header + one silent sample. Never fetched, cannot fail.
  var SILENT = "data:audio/wav;base64,UklGRiUAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQEAAAAA";

  function element() {
    if (!el) { el = new Audio(); el.preload = "auto"; }
    return el;
  }
  /* Must run INSIDE the tap handler, before any await. */
  function unlock() {
    var a = element();
    if (unlocked) return;
    try {
      a.muted = true; a.src = SILENT;
      var p = a.play();
      if (p && p.then) {
        p.then(function () {
          try { a.pause(); a.currentTime = 0; } catch (e) {}
          a.muted = false; unlocked = true;
        }, function () { a.muted = false; });
      } else { a.muted = false; unlocked = true; }
    } catch (e) { /* play() below reports it properly */ }
  }

  /* ---------------- cache ----------------
     Keyed on everything that changes the audio. A second tap on the same voice
     at the same settings is instant, which is most of what "fast" means when
     somebody is comparing voices one after another. */
  var cache = Object.create(null);
  function key(id, text) { return id + "|" + paceEl.value + "|" + pitchEl.value + "|" + text; }

  function fetchVoice(id, text) {
    text = text || SAMPLE;
    var k = key(id, text);
    if (cache[k]) return Promise.resolve(cache[k]);
    // A long conversation would otherwise hold every line ever spoken as base64.
    if (Object.keys(cache).length > 60) cache = Object.create(null);
    return fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: text, lang: LANG, speaker: id,
        pace: Number(paceEl.value), pitch: Number(pitchEl.value)
      })
    }).then(function (r) {
      if (!r.ok) throw new Error("http_" + r.status);
      return r.json();
    }).then(function (d) {
      if (!d || !d.audio) throw new Error(d && d.error ? d.error : "no_audio");
      cache[k] = "data:" + (d.mime || "audio/mpeg") + ";base64," + d.audio;
      return cache[k];
    });
  }

  /* ---------------- selection ----------------
     Tapping a voice does two things: it plays the sample, and it makes that
     voice Anaga's. There is no second "use this one" control, because a
     selection you cannot hear is how every voice sounded female for a week. */
  var selected = null;
  function select(card, id) {
    if (selected && selected.card !== card) selected.card.setAttribute("aria-pressed", "false");
    card.setAttribute("aria-pressed", "true");
    selected = { card: card, id: id };
  }

  /* ---------------- play ---------------- */
  function play(card, id) {
    if (playing && playing !== card) reset(playing);
    var a = element();
    select(card, id);

    if (card.dataset.state === "playing") { try { a.pause(); } catch (e) {} reset(card); return; }

    unlock();                       // inside the gesture — this is the point
    card.dataset.state = "loading";
    playing = card;
    var t0 = performance.now();

    fetchVoice(id).then(function (src) {
      if (playing !== card) return;             // they tapped something else
      a.onended = function () { reset(card); };
      // Superseded, not broken: swapping src aborts the previous load and fires
      // an error on it. Reporting that as "audio error" on the card you just
      // left is how tapping quickly through 37 voices paints the grid red.
      a.onerror = function () { if (playing === card) fail(card, "audio error"); };
      a.src = src;
      return a.play().then(function () {
        var ms = Math.round(performance.now() - t0);
        card.dataset.state = "playing";
        // The measured number, on their device, for this voice.
        card.querySelector("em").textContent = ms + " ms";
      });
    }).catch(function (err) {
      if (playing !== card) return;             // superseded — say nothing
      // NotAllowedError is the autoplay policy, not a broken voice, and it is
      // fixed by a tap rather than by retrying or switching provider.
      fail(card, err && err.name === "NotAllowedError"
        ? "tap again to allow audio"
        : (err && err.message) || "failed");
    });
  }

  function reset(card) {
    card.dataset.state = "";
    if (playing === card) playing = null;
  }
  function fail(card, msg) {
    reset(card);
    card.querySelector("em").textContent = msg;
    say(msg, true);
  }

  /* ---------------- render ---------------- */
  function render(voices, model) {
    grid.textContent = "";
    voices.forEach(function (v) {
      var b = document.createElement("button");
      b.className = "v";
      b.type = "button";
      b.dataset.voice = v.id;
      b.setAttribute("aria-label", "Play " + v.name);

      var p = document.createElement("span");
      p.className = "play";
      p.textContent = "▶";
      b.appendChild(p);

      var n = document.createElement("span");
      n.className = "n";
      var nm = document.createElement("b");
      nm.textContent = v.name;               // textContent: vendor-supplied
      var sub = document.createElement("em");
      sub.textContent = "tap";
      n.appendChild(nm); n.appendChild(sub);
      b.appendChild(n);

      b.addEventListener("click", function () { play(b, v.id); });
      b.setAttribute("aria-pressed", "false");
      grid.appendChild(b);
      // First card is Anaga's voice until you pick another. Selecting is not
      // playing: this makes no sound and no request.
      if (!selected) select(b, v.id);
    });
    modelEl.textContent = model || "Bulbul";
    say(voices.length + " voices · Telugu");
  }

  /* =====================================================================
     LIVE TRANSCRIPT — both sides, written down as they happen.

     Every line is written BEFORE it is spoken. If synthesis fails, or the
     phone is on silent, or the brain 503s, you still see exactly what was
     heard and what was answered. That is the whole point: "it said something
     wrong" is not checkable against audio nobody kept.

     HALF-DUPLEX, ALWAYS. The mic is aborted before Anaga speaks and reopened
     only after she stops. An open mic on a phone speaker hears her and
     answers her — that is not hypothetical, it is what happened.
     ===================================================================== */

  var history = [];       // [{ role: "agent"|"user", text }]
  var draftEl = null;     // the interim-recognition bubble, if any
  var thinking = false;   // a turn is in flight
  var speaking = false;   // Anaga has the floor
  var ended = false;      // booked / opted out — the conversation is over
  // A sticky note that survives the transient "thinking…"/"listening…" states.
  // Without it the reason a turn fell back was overwritten the moment Anaga
  // finished speaking, and a brain that is down looked exactly like one that
  // is merely scripted — the same confusion that cost two days on the server.
  var note = "";

  function state(msg) { talkState.textContent = msg || note; }

  function bubble(role, text, isDraft) {
    var d = document.createElement("div");
    d.className = "ln " + (role === "agent" ? "her" : "you") + (isDraft ? " draft" : "");
    var who = document.createElement("small");
    who.textContent = role === "agent" ? "అనగా" : "మీరు";
    d.appendChild(who);
    d.appendChild(document.createTextNode(text));   // never innerHTML: this is speech
    // Interim text is rewritten on every syllable; announcing each revision
    // makes the live region unusable with a screen reader.
    if (isDraft) d.setAttribute("aria-hidden", "true");
    logEl.appendChild(d);
    logEl.scrollTop = logEl.scrollHeight;
    return d;
  }

  function setDraft(text) {
    if (!text) return clearDraft();
    if (!draftEl) draftEl = bubble("user", text, true);
    else { draftEl.lastChild.nodeValue = text; logEl.scrollTop = logEl.scrollHeight; }
  }
  function clearDraft() {
    if (draftEl && draftEl.parentNode) draftEl.parentNode.removeChild(draftEl);
    draftEl = null;
  }

  /* An opt-out is honoured by US, not by the brain. Whatever the model answers,
     the conversation stops here — the model's disposition does not get a vote.
     On a real call this is also where the number joins the suppression list
     before anything else happens (docs/COMPLIANCE.md). */
  var OPT_OUT = [
    "ఆసక్తి లేదు", "కాల్ చేయవద్దు", "కాల్ చేయకండి", "ఫోన్ చేయవద్దు",
    "నాకు వద్దు", "డిస్టర్బ్ చేయకండి",
    "not interested", "do not call", "don't call", "dont call",
    "remove me", "stop calling", "unsubscribe"
  ];
  function isOptOut(text) {
    var t = String(text).toLowerCase();
    for (var i = 0; i < OPT_OUT.length; i++) if (t.indexOf(OPT_OUT[i]) !== -1) return true;
    return false;
  }

  /* The brain is paid, rate-limited and occasionally 503s. When it is down the
     transcript must still show what Anaga said, so this is a deliberately dumb
     stand-in — not a second brain anyone has to keep in sync with prompts.js. */
  var FALLBACK = [
    "మీరు ఉండటానికా, లేక పెట్టుబడి కోసమా చూస్తున్నారు?",
    "మీ బడ్జెట్ ఎంత వరకు ఉంది?",
    "ఎన్ని బెడ్‌రూమ్‌లు కావాలి — 2 BHK నా, 3 BHK నా?",
    "ఎప్పటిలోగా తీసుకోవాలని అనుకుంటున్నారు?",
    "ఒకసారి సైట్ విజిట్ పెట్టుకుందామా — శనివారం లేక ఆదివారం?"
  ];
  function agentTurns() {
    var n = 0;
    for (var i = 0; i < history.length; i++) if (history[i].role === "agent") n++;
    return n;
  }
  function fallbackLine() {
    return FALLBACK[Math.min(agentTurns(), FALLBACK.length - 1)];
  }

  function ask(text) {
    if (!text || ended) return;
    clearDraft();
    history.push({ role: "user", text: text });
    bubble("user", text);

    if (isOptOut(text)) {
      reply("సరే, అర్థమైంది. మిమ్మల్ని డు-నాట్-కాల్ జాబితాలో చేరుస్తాను. ధన్యవాదాలు.", true);
      return;
    }

    thinking = true;
    state("ఆలోచిస్తోంది…");
    fetch("/api/anaga/turn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ history: history })
    }).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (d && d.say) { note = ""; return reply(d.say, d.end === true); }
        degraded();
      })
      .catch(degraded);
  }

  // Say WHY, out loud. A brain that is 503-ing on every call and a brain that
  // is merely scripted look identical from the outside otherwise.
  function degraded() {
    note = "బ్రెయిన్ అందుబాటులో లేదు";
    state(note);
    reply(fallbackLine(), false);
  }

  function reply(text, isEnd) {
    thinking = false;
    history.push({ role: "agent", text: text });
    bubble("agent", text);            // written first, spoken second
    if (isEnd) ended = true;
    speak(text).then(function () {
      speaking = false;
      if (ended) { stopListening(); state("కాల్ ముగిసింది"); return; }
      state("");
      if (wanted) listen();
    });
  }

  /* Speak through the SAME unlocked element the samples use — a fresh Audio()
     built after an await is not unlocked, and is rejected silently. */
  function speak(text) {
    if (!selected) return Promise.resolve();
    var a = element(), card = selected.card;
    pauseListening();
    if (playing && playing !== card) reset(playing);
    playing = card;
    card.dataset.state = "loading";

    return fetchVoice(selected.id, text).then(function (src) {
      return new Promise(function (done) {
        a.onended = function () { reset(card); done(); };
        a.onerror = function () {
          if (playing !== card) return done();   // superseded, not broken
          reset(card); state("ఆడియో రాలేదు"); done();
        };
        a.src = src;
        Promise.resolve(a.play()).then(
          function () { if (playing === card) card.dataset.state = "playing"; },
          function () {
            if (playing === card) { reset(card); state("వినడానికి ఒకసారి నొక్కండి"); }
            done();
          }
        );
      });
    }).catch(function (e) {
      reset(card);
      state((e && e.message) || "సింథసిస్ విఫలమైంది");
    });
  }

  /* ---------------- listening ---------------- */
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var recog = null, wanted = false;

  function listen() {
    if (!SR || ended || recog) return;
    recog = new SR();
    recog.lang = LANG;
    recog.interimResults = true;      // the "live" half of a live transcript
    recog.maxAlternatives = 1;
    recog.continuous = false;         // one utterance, then hand the floor over

    recog.onresult = function (ev) {
      var interim = "", final = "";
      for (var i = ev.resultIndex; i < ev.results.length; i++) {
        var r = ev.results[i];
        if (r.isFinal) final += r[0].transcript; else interim += r[0].transcript;
      }
      if (final.trim()) ask(final.trim());
      else setDraft(interim);
    };
    recog.onerror = function (ev) {
      if (ev.error === "not-allowed" || ev.error === "service-not-allowed") {
        stopListening();
        state("మైక్ అనుమతి లేదు — టైప్ చేయండి");
      } else if (ev.error === "no-speech") {
        state("వినిపించలేదు");
      }
    };
    recog.onend = function () {
      recog = null;
      clearDraft();
      // Chrome ends recognition after each utterance and after silence. Reopen
      // it for as long as the button says we are listening — but never while
      // Anaga is speaking or thinking.
      if (wanted && !thinking && !speaking && !ended) listen();
      else if (!wanted) state("");
    };

    try { recog.start(); state("వింటున్నాను…"); }
    catch (e) { recog = null; }       // already started; onend will re-arm
  }

  function pauseListening() {
    speaking = true;
    if (recog) { try { recog.abort(); } catch (e) {} recog = null; }
  }
  function stopListening() {
    wanted = false;
    talkBtn.setAttribute("aria-pressed", "false");
    talkBtn.textContent = "🎙 మాట్లాడండి";
    if (recog) { try { recog.stop(); } catch (e) {} }
    clearDraft();
  }
  function talkReady() {
    if (SR) return;
    // Firefox and most desktops have no Web Speech recogniser at all. Typing is
    // not a lesser path here — the transcript is what was asked for.
    talkBtn.disabled = true;
    talkBtn.title = "This browser has no speech recogniser";
    state("ఈ బ్రౌజర్‌లో మైక్ లేదు — టైప్ చేయండి");
  }

  talkBtn.addEventListener("click", function () {
    unlock();                          // inside the gesture, as always
    if (wanted) return stopListening();
    wanted = true;
    talkBtn.setAttribute("aria-pressed", "true");
    talkBtn.textContent = "⏹ ఆపండి";
    listen();
  });

  sayForm.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var t = sayInput.value.trim();
    if (!t || thinking) return;
    unlock();                          // this submit is the gesture
    sayInput.value = "";
    ask(t);
  });

  /* ---------------- boot ---------------- */
  [[paceEl, paceV], [pitchEl, pitchV]].forEach(function (pair) {
    pair[0].addEventListener("input", function () { pair[1].textContent = pair[0].value; });
  });

  // Independent of whether voices load: typing must still produce a transcript.
  talkReady();

  fetch("/api/tts")
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (!d) throw new Error("probe failed");
      if (!d.voices || !d.voices.length) {
        // Explicit: "no voices" and "no Sarvam key" look identical otherwise.
        throw new Error(d.available
          ? "Sarvam is not configured on this deployment (SARVAM_API_KEY)"
          : "no voice provider is configured");
      }
      render(d.voices, d.model);
    })
    .catch(function (e) { say(e.message || "could not load voices", true); });
})();
