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
export async function generate({ system, user, json = false } = {}) {
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
        ? await generateSarvam({ system, user, json })
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
      return out;
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

// ---------------------------------------------------------------------------
// Sarvam adapter — OpenAI-compatible chat completions.
// ---------------------------------------------------------------------------
//
// sarvam-105b-conversations is the documented choice for "real-time
// conversational and voice-agent workloads"; sarvam-105b is the bigger
// reasoning model and is slower per turn, which on a phone call is the wrong
// trade. SARVAM_LLM_MODEL pins either.
const SARVAM_CHAT_URL = 'https://api.sarvam.ai/v1/chat/completions';

async function generateSarvam({ system, user, json }) {
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

  let data;
  try { data = await resp.json(); } catch { throw new Error('LLM upstream returned malformed JSON'); }

  const text = String(data?.choices?.[0]?.message?.content || '').trim();
  if (!text) throw new Error('LLM upstream returned an empty completion');
  return json ? parseJsonLoose(text) : text;
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
