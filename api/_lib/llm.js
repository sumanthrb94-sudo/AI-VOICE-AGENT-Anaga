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

  const provider = (process.env.LLM_PROVIDER || 'gemini').toLowerCase();

  switch (provider) {
    case 'gemini':
      return generateGemini({ system, user, json });
    // Future providers slot in here behind the same interface, e.g.:
    //   case 'anthropic': return generateAnthropic({ system, user, json });
    //   case 'openai':    return generateOpenAI({ system, user, json });
    //   case 'ollama':    return generateOllama({ system, user, json });   // self-hosted
    //   case 'vllm':      return generateVllm({ system, user, json });      // self-hosted
    default:
      throw new Error(`Unsupported LLM_PROVIDER: ${provider}`);
  }
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

  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
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
    throw new Error(`LLM upstream returned ${resp ? resp.status : 'no response'}${detail ? `: ${detail}` : ''}`);
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
