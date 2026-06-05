/* ===================================================================
   TranslateKit — on-device translation using Chrome's built-in
   Translator API (Chrome 138+). No API key, no network call to any
   translation service: the model runs locally in the browser.

   Used by the call demo to let Anaga reply in the caller's language
   without any LLM:  user speech (xx) → English → rule engine → English
   reply → xx → spoken. Two passes ("two translates") around the brain.

   Falls back silently (returns null) when the API isn't present, so the
   call still works in English on other browsers.
   =================================================================== */
(function () {
  const G = typeof self !== "undefined" ? self : window;
  const hasNew    = "Translator" in G;                                   // Chrome 138+ stable
  const hasLegacy = !hasNew && G.translation && typeof G.translation.createTranslator === "function"; // older trial

  const cache = {};        // "src>tgt" -> Promise<translator|null>
  const readyBase = {};    // base lang -> bool (both directions created)

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
    } catch (e) { /* fall through */ }
    return null;
  }

  function get(src, tgt) {
    const k = src + ">" + tgt;
    if (!(k in cache)) cache[k] = make(src, tgt);
    return cache[k];
  }

  async function tr(text, src, tgt) {
    if (!text) return null;
    const t = await get(src, tgt);
    if (!t) return null;
    try { return await t.translate(text); } catch (e) { return null; }
  }

  G.TranslateKit = {
    available: () => hasNew || hasLegacy,
    /* pre-create both directions (en <-> base); resolves to whether it's usable */
    async prep(base) {
      const [a, b] = await Promise.all([get(base, "en"), get("en", base)]);
      readyBase[base] = !!(a && b);
      return readyBase[base];
    },
    ready: (base) => !!readyBase[base],
    in:  (text, base) => tr(text, base, "en"),   // caller language -> English (for the rule engine)
    out: (text, base) => tr(text, "en", base)    // English -> caller language (for speaking)
  };
})();
