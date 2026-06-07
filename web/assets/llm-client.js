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
  const DEFAULT_MODEL = "gemini-2.5-flash";

  const getKey   = () => (localStorage.getItem(KEY_LS) || "").trim();
  const getModel = () => (localStorage.getItem(MODEL_LS) || "").trim() || DEFAULT_MODEL;
  const hasKey   = () => getKey().length > 0;
  const setKey   = (k) => { k ? localStorage.setItem(KEY_LS, k.trim()) : localStorage.removeItem(KEY_LS); };
  const setModel = (m) => { m && m.trim() ? localStorage.setItem(MODEL_LS, m.trim()) : localStorage.removeItem(MODEL_LS); };

  /* ---- the "Syl rules" Anaga must follow (mirrors api/_lib/prompts.js) ---- */
  const SYL_RULES = [
    "You are Anaga — a warm, sharp, genuinely conversational female AI voice agent for Modcon",
    "Builders (a real-estate developer), calling about its residential project 'Agartha'",
    "(brochure & details at agartha.in). Sound like a real person on a phone call, not a script.",
    "PROJECT: 'Agartha' by Modcon Builders — a ~4.5-acre integrated community in Tukkuguda, South",
    "Hyderabad, on the 200ft Srisailam Highway off ORR Exit-14 (5 min Fab City; 10-15 min RGI Airport,",
    "Aga Khan Academy, Statue of Equality; ~30-45 min Financial District). It has SYL Residences",
    "(low-density biophilic villaments; 22,000 sft clubhouse — infinity pool, gym, yoga, sauna,",
    "co-working, banquet) and a G+4 commercial hub (retail, co-working, healthcare, business-stay).",
    "Contact +91 95348 69999, info@modconbuilders.com; details at agartha.in. For exact prices,",
    "unit sizes, floor plans, RERA or possession you don't have, point them to agartha.in / WhatsApp",
    "/ the site visit — never invent specifics.",
    "LANGUAGE: reply in the SAME language and script the caller just used — English, Hindi",
    "(Devanagari), Telugu (Telugu script), or natural code-mixing. If they switch, you switch too.",
    "CONVERSE, DON'T INTERROGATE: actually listen and respond to what they say. If they ask a",
    "question (price, location, size, possession, loan/EMI, amenities, anything), ANSWER it directly",
    "and honestly FIRST, then continue. Briefly acknowledge their words so it feels human.",
    "RULES: (1) In your first turn, disclose you are an AI from Modcon Builders and check it's a good time;",
    "don't qualify until they agree (if busy, offer to call later and end).",
    "(2) Conversationally learn purpose (live-in vs investment), budget, configuration (BHK/villa),",
    "and timeline — weave them in, don't fire a checklist, and never re-ask what they answered.",
    "(3) When they're warm, offer a site visit this weekend; if they agree, book it (Sat or Sun).",
    "(4) If they want out ('not interested', 'remove me', 'don't call', or the Hindi/Telugu",
    "equivalent), acknowledge, say you'll add them to the do-not-call list, and end immediately.",
    "(5) You qualify and BOOK; humans close — never claim to close or set a final price, and don't",
    "invent specific facts you weren't given (offer to confirm exact details on the visit/WhatsApp).",
    "(6) Keep each turn short and natural — this is a live call. End after booking, callback, opt-out, or busy."
  ].join(" ");

  const transcript = (history) =>
    history.map(m => `${m.role === "agent" ? "Anaga" : "Customer"}: ${m.text}`).join("\n");

  function turnPrompt(history) {
    return {
      system: SYL_RULES + "\nReturn ONLY JSON: {\"say\": string (in the caller's language, answering" +
        " their question first if they asked one), \"end\": boolean, \"disposition\": one of " +
        "[\"qualifying\",\"booked\",\"callback\",\"not-interested\",\"opt-out\",\"busy\"]}.",
      user: "Conversation so far:\n" + transcript(history) + "\n\nGenerate Anaga's next line as JSON."
    };
  }
  function summaryPrompt(history) {
    return {
      system: "You are a sales-ops analyst reviewing a Modcon Builders call by the AI agent Anaga. " +
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

  /* Pull a COMPLETED "say" string out of a partial JSON stream, or null if the
     closing quote hasn't arrived yet. Lets us start speaking the line the moment
     it's ready, before "end"/"disposition" finish generating. */
  function extractSayComplete(raw) {
    const m = raw.match(/"say"\s*:\s*"/);
    if (!m) return null;
    let out = "";
    for (let i = m.index + m[0].length; i < raw.length; i++) {
      const c = raw[i];
      if (c === "\\") {
        const n = raw[i + 1];
        if (n === undefined) return null;                 // escape split across chunks
        out += ({ n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\", "/": "/" }[n] || n);
        i++; continue;
      }
      if (c === '"') return out;                          // closing quote → complete
      out += c;
    }
    return null;                                          // not closed yet
  }

  /* Streaming turn (BYOK): reads Gemini's SSE tokens and fires onText(say) as
     soon as the spoken line is complete, then resolves with the full turn.
     Falls back to the non-streaming turn() on any hiccup. */
  async function turnStream({ history, onText }) {
    const key = getKey(), model = getModel();
    if (!key) throw new Error("no key");
    const { system, user } = turnPrompt(history);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(key)}`;
    const body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.6 }
    };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    let res;
    try {
      res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctrl.signal });
    } catch (e) { clearTimeout(timer); return turn({ history }); }
    if (!res.ok || !res.body || !res.body.getReader) { clearTimeout(timer); return turn({ history }); }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let raw = "", buf = "", sayEmitted = false;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (!line || !line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          let j; try { j = JSON.parse(payload); } catch (_) { continue; }
          const parts = (((j.candidates || [])[0] || {}).content || {}).parts || [];
          for (const p of parts) if (p && typeof p.text === "string") raw += p.text;
          if (!sayEmitted && onText) {
            const s = extractSayComplete(raw);
            if (s != null) { sayEmitted = true; try { onText(s); } catch (_) {} }
          }
        }
      }
    } catch (e) { /* stream broke — finalize with whatever we have */ }
    finally { clearTimeout(timer); }

    let parsed = null;
    try {
      parsed = JSON.parse(raw.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim());
    } catch (_) {
      const a = raw.indexOf("{"), b = raw.lastIndexOf("}");
      if (a >= 0 && b > a) { try { parsed = JSON.parse(raw.slice(a, b + 1)); } catch (_) {} }
    }
    if (!parsed) {
      const say = extractSayComplete(raw);
      if (say != null) return { say, end: false, disposition: "qualifying" };
      return turn({ history });
    }
    return {
      say: String(parsed.say || extractSayComplete(raw) || "Sorry, could you say that again?"),
      end: !!parsed.end,
      disposition: parsed.disposition || "qualifying"
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

  window.AnagaBrain = { getKey, setKey, getModel, setModel, hasKey, turn, turnStream, summary, test, DEFAULT_MODEL };
})();
