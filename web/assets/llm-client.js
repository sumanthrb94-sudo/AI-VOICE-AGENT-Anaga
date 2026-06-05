/* ===================================================================
   Anaga BYOK brain — optional browser-side Google Gemini client.
   Lets you paste your own Gemini API key in the UI and "connect" without
   any backend. The key is stored ONLY in this browser (localStorage) and
   sent directly to Google's API from your browser.

   ⚠️  Browser-side keys are visible to anyone using THIS browser/profile
   and travel in client requests — use this for personal demos/testing.
   For a public production site, leave this empty and set GEMINI_API_KEY
   as a server env var on Vercel instead (see /api).

   Priority used by the call demo: BYOK key (here) → server /api → offline rules.
   =================================================================== */
(function () {
  const KEY_LS   = "vaak_gemini_key";
  const MODEL_LS = "vaak_gemini_model";
  const DEFAULT_MODEL = "gemini-2.0-flash";

  const getKey   = () => (localStorage.getItem(KEY_LS) || "").trim();
  const getModel = () => (localStorage.getItem(MODEL_LS) || "").trim() || DEFAULT_MODEL;
  const hasKey   = () => getKey().length > 0;
  const setKey   = (k) => { k ? localStorage.setItem(KEY_LS, k.trim()) : localStorage.removeItem(KEY_LS); };
  const setModel = (m) => { m && m.trim() ? localStorage.setItem(MODEL_LS, m.trim()) : localStorage.removeItem(MODEL_LS); };

  /* ---- the "Syl rules" Anaga must follow (mirrors api/_lib/prompts.js) ---- */
  const SYL_RULES = [
    "You are Anaga, a warm, concise female AI voice agent for Vaak, calling about the",
    "'Skyline Villaments' project in Hyderabad. Speak natural, friendly Indian English; code-mixing is fine.",
    "RULES: (1) At the very start, disclose you are an AI and ask for consent to continue.",
    "(2) Qualify IN ORDER: purpose (live-in vs investment) → budget → configuration (BHK) → timeline.",
    "(3) Then offer a site visit; if they agree, book it (ask Saturday or Sunday).",
    "(4) If they want to opt out ('not interested', 'remove me', 'do not call'), acknowledge,",
    "say you'll add them to the do-not-call list, and end immediately.",
    "(5) NEVER claim to close the deal — you qualify and book; humans close.",
    "(6) One short question per turn, max ~40 words. End the call after booking, callback, opt-out, or if they're busy."
  ].join(" ");

  const transcript = (history) =>
    history.map(m => `${m.role === "agent" ? "Anaga" : "Customer"}: ${m.text}`).join("\n");

  function turnPrompt(history) {
    return {
      system: SYL_RULES + "\nReturn ONLY JSON: {\"say\": string, \"end\": boolean, \"disposition\": one of " +
        "[\"qualifying\",\"booked\",\"callback\",\"not-interested\",\"opt-out\",\"busy\"]}.",
      user: "Conversation so far:\n" + transcript(history) + "\n\nGenerate Anaga's next line as JSON."
    };
  }
  function summaryPrompt(history) {
    return {
      system: "You are a sales-ops analyst reviewing a Vaak call by the AI agent Anaga. " +
        "Return ONLY JSON: {\"interested\": boolean, \"score\": 0-100 integer, \"disposition\": " +
        "[\"booked\",\"callback\",\"not-interested\",\"opt-out\",\"undecided\"], \"summary\": string, " +
        "\"nextAction\": string, \"comment\": string}. 'comment' is a short internal note from the sales team's side.",
      user: "Full transcript:\n" + transcript(history) + "\n\nWrite the call review as JSON."
    };
  }

  /* ---- direct Gemini call from the browser ---- */
  async function gemini({ system, user, json }, key, model) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
    const body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: json ? { responseMimeType: "application/json", temperature: 0.6 } : { temperature: 0.7 }
    };
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    let res;
    try {
      res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctrl.signal });
    } finally { clearTimeout(t); }
    if (!res.ok) {
      let msg = "HTTP " + res.status;
      try { const e = await res.json(); if (e.error && e.error.message) msg = e.error.message; } catch (_) {}
      throw new Error(msg);
    }
    const data = await res.json();
    const text = (((data.candidates || [])[0] || {}).content || {}).parts?.map(p => p.text).join("") || "";
    if (!json) return text;
    const cleaned = text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    return JSON.parse(cleaned);
  }

  function clamp(n, lo, hi) { n = Number(n); return isNaN(n) ? lo : Math.max(lo, Math.min(hi, n)); }

  async function turn({ history }) {
    const d = await gemini(turnPrompt(history), getKey(), getModel());
    return {
      say: String(d.say || "Sorry, could you say that again?"),
      end: !!d.end,
      disposition: d.disposition || "qualifying"
    };
  }
  async function summary({ history }) {
    const d = await gemini(summaryPrompt(history), getKey(), getModel());
    return {
      interested: !!d.interested,
      score: clamp(d.score, 0, 100),
      disposition: d.disposition || "undecided",
      summary: String(d.summary || ""),
      nextAction: String(d.nextAction || ""),
      comment: String(d.comment || ""),
      _byok: true
    };
  }

  /* quick validation ping used by the "Connect" button */
  async function test(key, model) {
    await gemini({ system: "Reply with the single word: ok", user: "ping", json: false }, key, model || DEFAULT_MODEL);
    return true;
  }

  window.AnagaBrain = { getKey, setKey, getModel, setModel, hasKey, turn, summary, test, DEFAULT_MODEL };
})();
