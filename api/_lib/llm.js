// api/_lib/llm.js
//
// Provider-abstracted LLM client. This is the ONE place in the backend where a
// vendor LLM API is referenced — the provider-abstraction boundary (see
// engineering/MULTI_AGENT_SPEC.md §1, principle 2: "No vendor hard-coded in
// business logic"). All business logic (prompts, turn/summary endpoints) calls
// `generate()` and never knows or cares which provider answered.
//
// Adding another provider (Anthropic / OpenAI / self-hosted Ollama / VLLM) is a
// matter of writing one more adapter below and wiring it into the switch in
// `generate()`. No caller (turn.js / summary.js / prompts.js) changes.
//
// Security: the API key is read from a server-side env var (GEMINI_API_KEY) and
// NEVER returned to the caller. On any failure we throw a generic Error; callers
// translate that into an HTTP 503 so the browser falls back to its on-device
// rule engine. We never leak the key, the upstream URL, or a stack trace.
//
// No npm dependencies: uses the global `fetch` available on Node 18+ (Vercel).

const DEFAULT_TIMEOUT_MS = 12000;

/**
 * Generate a completion from the configured LLM provider.
 *
 * @param {object}  opts
 * @param {string}  opts.system  - System instruction / ruleset.
 * @param {string}  opts.user    - The user-turn content / task.
 * @param {boolean} [opts.json]  - When true, ask for JSON and return a parsed object.
 * @returns {Promise<string|object>} string, or parsed object when json=true.
 * @throws {Error} when the provider is misconfigured or the upstream call fails.
 */
/**
 * THE FIRST CLAUSE, THE MOMENT THE MODEL HAS WRITTEN IT.
 *
 * The pipeline is three vendor calls in series — transcribe, think, speak —
 * and the third cannot begin until the second has finished. But the third only
 * needs the FIRST FEW WORDS to begin, and a model writing "Are you looking to
 * live in it, or to invest?" has those words long before it has the rest.
 *
 * So `say` is scanned as it streams and handed over as soon as its first phrase
 * is complete. Synthesis of that phrase then overlaps the remainder of the
 * generation instead of queueing behind it. Nothing about the answer changes;
 * it just stops being the case that every millisecond the model spends on the
 * back half of a sentence is a millisecond of silence on the call.
 *
 * The boundary MUST match shared/speech-split.js, because the caller renders
 * the remaining phrases itself and a disagreement repeats or drops one. It is
 * verified against the real splitter once the full text arrives, and a mismatch
 * simply falls back to synthesizing normally — a wrong guess costs the saving,
 * never the audio.
 */
const HEAD_CHARS = 36, MIN_HEAD = 12, MAX_CHARS = 140;
const SENTENCE_END = '.!?।॥';
const CLAUSE_END = ',;:—–';

/** The splitter's runt rule, which decides whether a sentence stands alone. */
function isRunt(s) {
  return s.split(/\s+/).filter(Boolean).length < 4 && s.length < 16;
}

export function firstClauseOf(saySoFar, done) {
  const s = String(saySoFar || '');
  let clause = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (clause < 0 && CLAUSE_END.includes(c) && i + 1 >= MIN_HEAD) clause = i;
    if (SENTENCE_END.includes(c)) {
      const cand = s.slice(0, i + 1).trim();
      // A RUNT IS NOT A PHRASE — it is merged into what follows.
      //
      // This is the case that made the optimisation miss in production: Anaga
      // opens turns with "That's right." and "సరే.", which are two words and
      // under sixteen characters, so the splitter folds them into the next
      // sentence. Stopping at the full stop guessed "That's right." while the
      // splitter wanted "That's right. Since you reached out," — the server
      // caught the mismatch and re-synthesized, so every one of those turns
      // paid the full LLM-then-TTS latency while looking perfectly fine.
      if (isRunt(cand)) continue;
      if (cand.length > MAX_CHARS) return null;   // the splitter re-cuts at 140
      // A short opening sentence is its own phrase; a long one is cut at the
      // clause, exactly as splitHead() does — INCLUDING the case where it
      // cannot cut. "नमस्ते, मैं वाक् से अनगा बोल रही हूँ।" is 37 characters
      // with its only comma at 7, and splitHead needs a head of at least
      // MIN_HEAD, so it gives up and keeps the sentence whole.
      if (cand.length <= HEAD_CHARS || clause < 0) return cand;
      return s.slice(0, clause + 1).trim();
    }
    // Past the budget with a boundary behind us. No non-runt sentence ended
    // inside the budget — the loop above would have returned — so whatever the
    // merged first phrase turns out to be, it is longer than HEAD_CHARS and
    // gets cut here. Nothing later in the line can change that.
    if (i + 1 > HEAD_CHARS && clause >= 0) return s.slice(0, clause + 1).trim();
  }
  // Nothing conclusive yet. Once the stream is over, whatever there is IS the
  // whole line, so the splitter's own answer applies.
  return done ? s.trim() || null : null;
}

/** Pull `say` out of a JSON object that is still being written. */
function partialSay(buffer) {
  const at = buffer.indexOf('"say"');
  if (at < 0) return null;
  const open = buffer.indexOf('"', buffer.indexOf(':', at) + 1);
  if (open < 0) return null;
  let out = '';
  for (let i = open + 1; i < buffer.length; i++) {
    const c = buffer[i];
    if (c === '\\') { i++; out += buffer[i] === 'n' ? ' ' : (buffer[i] || ''); continue; }
    if (c === '"') return { text: out, closed: true };
    out += c;
  }
  return { text: out, closed: false };
}

export async function generate({ system, user, json = false, onFirstClause } = {}) {
  if (typeof user !== 'string' || user.length === 0) {
    throw new Error('generate(): "user" must be a non-empty string');
  }

  // A CHAIN, like TTS_PROVIDER, and for the same reason. Gemini's free tier
  // returned 429 on every single turn for hours; the browser fell back to a
  // four-line canned script and the call stopped being a conversation. One
  // vendor's quota should not be able to do that.
  //
  // Sarvam is first: this product already pays for a Sarvam key for STT and
  // TTS, sarvam-105b-conversations is built for real-time voice agents, and it
  // is trained on the Indic and code-mixed text these calls are made of. It is
  // also Indian data residency for the conversation content, not only the audio
  // — see docs/COMPLIANCE.md.
  //
  // Every provider is inert without its own key, so the order changes nothing
  // on a deployment that has configured only one.
  const chain = String(process.env.LLM_PROVIDER || 'sarvam,gemini')
    .split(',').map((p) => p.trim().toLowerCase()).filter(Boolean)
    .filter(llmReady);
  if (!chain.length) throw new Error('no LLM provider is configured');

  const errors = [];
  for (const provider of chain) {
    try {
      const out = provider === 'sarvam'
        ? await generateSarvam({ system, user, json, onFirstClause })
        : await generateGemini({ system, user, json });
      // A FALLBACK IS NOT A SUCCESS. Which brain answered changes how she
      // sounds, and a silent switch is how "the premium voice is off" became a
      // week of guessing on the TTS side.
      if (errors.length) {
        console.error(JSON.stringify({
          event: 'llm_fell_back', served: provider, severity: 'high',
          failed: errors.map((e) => String(e).slice(0, 160)),
        }));
      }
      return withServingProvider(out, provider);
    } catch (err) {
      errors.push(`${provider}: ${err?.message || 'failed'}`);
      // Quota is not transient within a request; neither is a bad key. Both
      // are worth trying the next provider for, which is the whole point.
    }
  }
  const e = new Error('llm_unavailable');
  e.detail = errors.join(' | ');
  if (/\b429\b|quota/i.test(e.detail)) e.code = 'quota_exceeded';
  throw e;
}

/** True when a provider has the credential it needs. */
export function llmReady(provider) {
  if (provider === 'sarvam') return Boolean(process.env.SARVAM_API_KEY);
  if (provider === 'gemini') return Boolean(process.env.GEMINI_API_KEY);
  return false;
}

/** Which brains this deployment could actually use. */
export function llmStatus() {
  const chain = String(process.env.LLM_PROVIDER || 'sarvam,gemini')
    .split(',').map((p) => p.trim().toLowerCase()).filter(Boolean);
  return { chain, ready: chain.filter(llmReady) };
}

/**
 * Attach the provider that actually served an object completion without changing
 * the public JSON payload. API callers receive only their requested result;
 * trusted in-process callers such as the Cloud Run bridge can meter fallbacks.
 */
function withServingProvider(out, provider) {
  if (out && typeof out === 'object') {
    Object.defineProperty(out, '_provider', {
      value: provider,
      enumerable: false,
      configurable: true,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sarvam adapter — OpenAI-compatible chat completions.
// ---------------------------------------------------------------------------
//
// sarvam-105b-conversations is the documented choice for "real-time
// conversational and voice-agent workloads"; sarvam-105b is the bigger
// reasoning model and is slower per turn, which on a phone call is the wrong
// trade. SARVAM_LLM_MODEL pins either.
const SARVAM_CHAT_URL = 'https://api.sarvam.ai/v1/chat/completions';

async function generateSarvam({ system, user, json, onFirstClause }) {
  const key = process.env.SARVAM_API_KEY;
  if (!key) throw new Error('SARVAM_API_KEY is not configured');

  const messages = [];
  if (typeof system === 'string' && system.length) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: user });

  const body = {
    model: process.env.SARVAM_LLM_MODEL || 'sarvam-105b-conversations',
    messages,
    // Their default is 0.2, which on a sales call reads as a form being read
    // out. This is a conversation, not an extraction.
    temperature: Number(process.env.SARVAM_LLM_TEMPERATURE || 0.6),
    max_tokens: Number(process.env.SARVAM_LLM_MAX_TOKENS || 400),
  };
  // Reasoning is off by default: a phone call cannot afford a thinking pass,
  // and one short qualifying question does not need one.
  if (process.env.SARVAM_LLM_REASONING) body.reasoning_effort = process.env.SARVAM_LLM_REASONING;

  // Only when somebody is waiting on the first words. Streaming costs nothing
  // here, but it changes how the response is read, and the summary endpoint —
  // which nobody is listening to — has no use for it.
  const streaming = Boolean(onFirstClause) && process.env.SARVAM_LLM_STREAM !== '0';
  if (streaming) body.stream = true;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch(SARVAM_CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-subscription-key': key },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    throw new Error(`LLM request failed: ${err && err.name === 'AbortError' ? 'timeout' : 'network error'}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!resp || !resp.ok) {
    let detail = '';
    try { detail = (await resp.text()).slice(0, 200); } catch { /* ignore */ }
    throw new Error(`LLM upstream returned ${resp ? resp.status : 'no response'} for sarvam${detail ? `: ${detail}` : ''}`);
  }

  let text;
  if (streaming) {
    text = await readStream(resp, { json, onFirstClause });
  } else {
    let data;
    try { data = await resp.json(); } catch { throw new Error('LLM upstream returned malformed JSON'); }
    text = String(data?.choices?.[0]?.message?.content || '').trim();
  }

  if (!text) throw new Error('LLM upstream returned an empty completion');
  return json ? parseJsonLoose(text) : text;
}

/**
 * Read an OpenAI-style SSE completion, handing over the first speakable phrase
 * the moment it exists rather than when the whole answer does.
 *
 * The stream is still fully accumulated and parsed exactly as before, so the
 * ANSWER is unchanged in every case — this only moves when the caller learns
 * about the beginning of it. If anything about the early scan is wrong, the
 * caller checks it against the real splitter and discards it.
 */
async function readStream(resp, { json, onFirstClause }) {
  const reader = resp.body?.getReader?.();
  if (!reader) throw new Error('LLM upstream returned no stream');
  const dec = new TextDecoder();
  let sse = '', full = '', fired = false;

  const look = (done) => {
    if (fired || !onFirstClause) return;
    // A plain-text completion is its own text; a JSON one has to be dug out of
    // an object that is still being written.
    const said = json ? partialSay(full) : { text: full, closed: done };
    if (!said) return;
    const head = firstClauseOf(said.text, done || said.closed);
    if (!head) return;
    fired = true;
    // NEVER let a callback take the generation down with it. Starting a
    // synthesis early is an optimisation; the line still has to come back.
    try { onFirstClause(head); } catch { /* the caller renders it the slow way */ }
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    sse += dec.decode(value, { stream: true });
    // SSE frames are separated by a blank line; a chunk can split one in half.
    let cut;
    while ((cut = sse.indexOf('\n\n')) >= 0) {
      const frame = sse.slice(0, cut);
      sse = sse.slice(cut + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const d = JSON.parse(payload);
          full += d?.choices?.[0]?.delta?.content || '';
        } catch { /* a frame we cannot read is not a reason to fail the turn */ }
      }
      look(false);
    }
  }
  look(true);
  return full.trim();
}

// ---------------------------------------------------------------------------
// Gemini adapter (Google Generative Language API, v1beta generateContent).
// Verify the model name + endpoint against current Google docs before deploy.
// ---------------------------------------------------------------------------
async function generateGemini({ system, user, json }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    // Misconfiguration -> caller returns 503 -> browser falls back. Fail closed.
    throw new Error('GEMINI_API_KEY is not configured');
  }

  // Model names retire. A hard-coded default that Google has since removed
  // returns 404 on every call, which surfaced only as "Anaga sounds scripted" —
  // the endpoint 503s and the browser silently falls back to its rule engine.
  // GEMINI_MODEL still wins when set; otherwise try current names in order.
  const candidates = process.env.GEMINI_MODEL
    ? [process.env.GEMINI_MODEL]
    : ['gemini-2.0-flash', 'gemini-flash-latest', 'gemini-2.5-flash', 'gemini-1.5-flash'];

  let lastErr = null;
  for (const model of candidates) {
    try {
      return await callGemini(model, apiKey, { system, user, json });
    } catch (err) {
      lastErr = err;
      const msg = String(err && err.message);

      // 429 has two very different causes. A per-MINUTE rate limit clears in
      // seconds and is worth one retry; a per-DAY quota will not clear today
      // and retrying just burns the call's latency budget while the caller
      // waits on the phone. Retry once, briefly, then give up.
      if (/\b429\b/.test(msg)) {
        await new Promise((r) => setTimeout(r, 1200));
        try {
          return await callGemini(model, apiKey, { system, user, json });
        } catch (retryErr) {
          const e = new Error(String(retryErr && retryErr.message));
          e.code = 'quota_exceeded';
          throw e;
        }
      }

      // Only a missing/unsupported model is worth trying the next name for.
      // A bad key will fail identically for all of them.
      if (!/404|not found|not supported/i.test(msg)) throw err;
    }
  }
  throw lastErr || new Error('LLM: no usable model');
}

async function callGemini(model, apiKey, { system, user, json }) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const body = {
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: {},
  };
  if (typeof system === 'string' && system.length > 0) {
    body.systemInstruction = { parts: [{ text: system }] };
  }
  if (json) {
    body.generationConfig.responseMimeType = 'application/json';
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    // Network error / abort (timeout). Do not leak the URL (contains the key).
    throw new Error(`LLM request failed: ${err && err.name === 'AbortError' ? 'timeout' : 'network error'}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!resp || !resp.ok) {
    // Read a little of the body for server-side logging only; never surface it.
    let detail = '';
    try { detail = (await resp.text()).slice(0, 200); } catch { /* ignore */ }
    throw new Error(`LLM upstream returned ${resp ? resp.status : 'no response'} for model ${model}${detail ? `: ${detail}` : ''}`);
  }

  let data;
  try {
    data = await resp.json();
  } catch {
    throw new Error('LLM upstream returned malformed JSON');
  }

  const text = extractGeminiText(data);
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('LLM upstream returned an empty completion');
  }

  if (!json) return text;
  return parseJsonLoose(text);
}

// Pull the first text part out of the Gemini candidates structure.
function extractGeminiText(data) {
  const parts = data
    && data.candidates
    && data.candidates[0]
    && data.candidates[0].content
    && data.candidates[0].content.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('').trim();
}

// Parse JSON defensively: models sometimes wrap output in ```json fences.
function parseJsonLoose(text) {
  let s = text.trim();
  if (s.startsWith('```')) {
    // Strip a leading ```json / ``` fence and the trailing ``` fence.
    s = s.replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, '').trim();
  }
  try {
    return JSON.parse(s);
  } catch {
    // Last resort: grab the outermost {...} block.
    const first = s.indexOf('{');
    const last = s.lastIndexOf('}');
    if (first !== -1 && last !== -1 && last > first) {
      try { return JSON.parse(s.slice(first, last + 1)); } catch { /* fall through */ }
    }
    throw new Error('LLM returned non-JSON output when JSON was requested');
  }
}
