/* ===================================================================
   TranslateKit — translation for the call demo, with two paths.

   1. ON-DEVICE — Chrome's built-in Translator API (Chrome 138+). The model
      runs locally: no network call, no key, and the caller's speech never
      leaves the machine. Always preferred when present.
   2. GOOGLE — POST /api/translate, which is Google translation server-side
      (Cloud Translation when the project has it enabled, otherwise the free
      endpoint). Works in EVERY browser.

   Path 2 is why this file exists in its current shape. On-device translation
   is the better option and it covered maybe a third of real visitors — Safari,
   Firefox and every older Chrome silently dropped the call back to English
   with a notice telling the user to go install a different browser. A
   multilingual product cannot ship "works in one browser" as its language
   story.

   Used by the call demo so Anaga can reply in the caller's language without an
   LLM:  user speech (xx) → English → rule engine → English reply → xx → spoken.
   Two passes around the brain.

   Fails soft everywhere: every entry point returns null rather than throwing,
   and the call continues in English.

   NOT FOR THE DISCLOSURE. The AI disclosure is a regulatory statement with
   versioned per-language wording in caller-agent/flows/anaga.persona.json.
   It is never machine-translated. See api/_lib/translate.js.
   =================================================================== */
(function () {
  const G = typeof self !== "undefined" ? self : window;
  const hasNew    = "Translator" in G;                                   // Chrome 138+ stable
  const hasLegacy = !hasNew && G.translation && typeof G.translation.createTranslator === "function"; // older trial
  const hasDetect = "LanguageDetector" in G;                             // on-device language detection (Chrome 138+)
  const onDevice  = hasNew || hasLegacy;

  const cache = {};        // "src>tgt" -> Promise<translator|null>
  const readyBase = {};    // base lang -> bool (both directions available, either path)

  async function make(src, tgt) {
    if (src === tgt) return null;
    try {
      if (hasNew) {
        const avail = await G.Translator.availability({ sourceLanguage: src, targetLanguage: tgt });
        if (avail === "unavailable") return null;
        return await G.Translator.create({ sourceLanguage: src, targetLanguage: tgt });
      }
      if (hasLegacy) {
        return await G.translation.createTranslator({ sourceLanguage: src, targetLanguage: tgt });
      }
    } catch (e) { /* fall through to the server path */ }
    return null;
  }

  function get(src, tgt) {
    const k = src + ">" + tgt;
    if (!(k in cache)) cache[k] = make(src, tgt);
    return cache[k];
  }

  /* ---- path 2: Google, server-side ---- */
  let serverOk = null;             // null = unprobed, true, false
  let probeP = null;
  const serverCache = {};          // "src>tgt|text" -> translated

  function probeServer() {
    if (probeP) return probeP;
    probeP = fetch("/api/translate")
      .then(r => (r.ok ? r.json() : null))
      .then(d => { serverOk = !!(d && d.available); return serverOk; })
      .catch(() => { serverOk = false; return false; });
    return probeP;
  }
  probeServer();

  async function viaServer(text, src, tgt) {
    if (serverOk === false) return null;
    if (serverOk === null) { await probeServer(); if (!serverOk) return null; }

    const key = src + ">" + tgt + "|" + text;
    if (serverCache[key]) return serverCache[key];

    try {
      const res = await fetch("/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text, to: tgt, from: src })
      });
      if (!res.ok) return null;
      const d = await res.json();
      // provider "none" means the server gave the text back untranslated — a
      // rate limit or a disabled API. Report that as a miss so the caller can
      // fall back honestly instead of speaking English it believes is Hindi.
      if (!d || !d.text || d.provider === "none") return null;
      serverCache[key] = d.text;
      return d.text;
    } catch (e) { return null; }
  }

  async function tr(text, src, tgt) {
    if (!text || src === tgt) return null;
    const t = await get(src, tgt);
    if (t) {
      try { return await t.translate(text); } catch (e) { /* try the server */ }
    }
    return viaServer(text, src, tgt);
  }

  /* ---- on-device language detection (the "auto" in auto-convert) ---- */
  let detectorP = undefined;   // Promise<detector|null>
  function getDetector() {
    if (detectorP === undefined) {
      detectorP = (async () => {
        if (!hasDetect) return null;
        try {
          const avail = await G.LanguageDetector.availability();
          if (avail === "unavailable") return null;
          return await G.LanguageDetector.create();
        } catch (e) { return null; }
      })();
    }
    return detectorP;
  }

  /* returns a base language code ("en","hi","te"…) or null if unsure */
  async function detect(text) {
    if (!text || text.trim().length < 3) return null;   // too short to be reliable
    const d = await getDetector();
    if (d) {
      try {
        const results = await d.detect(text);
        const top = results && results.length ? results[0] : null;
        if (top && top.detectedLanguage !== "und" &&
            !(typeof top.confidence === "number" && top.confidence < 0.45)) {
          return String(top.detectedLanguage).split("-")[0];
        }
      } catch (e) { /* fall through to the server */ }
    }
    // Server fallback: ask Google to translate FROM auto and report what it
    // saw. Costs one call, and it is the only way auto-language works outside
    // Chrome — which is where most of the demo's traffic actually is.
    if (serverOk === null) await probeServer();
    if (!serverOk) return null;
    try {
      const res = await fetch("/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text, to: "en", from: "auto" })
      });
      if (!res.ok) return null;
      const j = await res.json();
      const from = j && j.from ? String(j.from).split("-")[0] : null;
      return from && from !== "auto" ? from : null;
    } catch (e) { return null; }
  }

  G.TranslateKit = {
    /* True when EITHER path can translate. Sync, so an unprobed server counts
       as usable — prep() is what actually confirms it. */
    available: () => onDevice || serverOk !== false,
    onDevice: () => onDevice,
    /* Which path a call would take, for the UI to report honestly. */
    mode: () => (onDevice ? "on-device" : serverOk ? "google" : serverOk === null ? "checking" : "none"),
    /* Detection works on-device OR through the server, so this is no longer
       "is this Chrome". */
    hasDetector: () => hasDetect || serverOk !== false,
    hasOnDeviceDetector: () => hasDetect,
    detect,
    /* Confirm both directions (en <-> base) really work before a call starts. */
    async prep(base) {
      if (base === "en") { readyBase.en = true; return true; }
      const [a, b] = await Promise.all([get(base, "en"), get("en", base)]);
      if (a && b) { readyBase[base] = true; return true; }
      // No on-device pair — verify the server can actually do it rather than
      // assuming. A probe that says "available" is not a translation.
      const probe = await viaServer("hello", "en", base);
      readyBase[base] = !!probe;
      return readyBase[base];
    },
    ready: (base) => !!readyBase[base],
    in:  (text, base) => tr(text, base, "en"),   // caller language -> English (for the rule engine)
    out: (text, base) => tr(text, "en", base)    // English -> caller language (for speaking)
  };
})();
