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
  function key(id) { return id + "|" + paceEl.value + "|" + pitchEl.value; }

  function fetchVoice(id) {
    var k = key(id);
    if (cache[k]) return Promise.resolve(cache[k]);
    return fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: SAMPLE, lang: LANG, speaker: id,
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

  /* ---------------- play ---------------- */
  function play(card, id) {
    if (playing && playing !== card) reset(playing);
    var a = element();

    if (card.dataset.state === "playing") { try { a.pause(); } catch (e) {} reset(card); return; }

    unlock();                       // inside the gesture — this is the point
    card.dataset.state = "loading";
    playing = card;
    var t0 = performance.now();

    fetchVoice(id).then(function (src) {
      if (playing !== card) return;             // they tapped something else
      a.onended = function () { reset(card); };
      a.onerror = function () { fail(card, "audio error"); };
      a.src = src;
      return a.play().then(function () {
        var ms = Math.round(performance.now() - t0);
        card.dataset.state = "playing";
        // The measured number, on their device, for this voice.
        card.querySelector("em").textContent = ms + " ms";
      });
    }).catch(function (err) {
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
      grid.appendChild(b);
    });
    modelEl.textContent = model || "Bulbul";
    say(voices.length + " voices · Telugu");
  }

  /* ---------------- boot ---------------- */
  [[paceEl, paceV], [pitchEl, pitchV]].forEach(function (pair) {
    pair[0].addEventListener("input", function () { pair[1].textContent = pair[0].value; });
  });

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
