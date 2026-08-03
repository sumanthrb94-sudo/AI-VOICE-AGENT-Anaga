// caller-agent/src/brain.js
//
// The caller agent's client for the Vaak API: next-turn generation and outcome
// reporting. Keeps HTTP concerns out of session.js so the session can be tested
// against a fake brain with no network.
//
// Endpoints (shared/call-api-contract.md, shared/integrations-contract.md):
//   POST {base}/api/anaga/turn      -> { say, end, disposition }
//   POST {base}/api/calls/outcome   -> { ok, review, ... }
//
// Turn generation is on the critical path of a live call: a slow response is
// dead air on someone's phone. It is timed out hard and retried at most once,
// because a second of silence is recoverable and eight seconds is not.

const TURN_TIMEOUT_MS = Number(process.env.BRAIN_TURN_TIMEOUT_MS || 6000);
const OUTCOME_TIMEOUT_MS = Number(process.env.BRAIN_OUTCOME_TIMEOUT_MS || 15000);
const OUTCOME_RETRIES = Number(process.env.BRAIN_OUTCOME_RETRIES || 3);

async function postJson(url, body, { timeoutMs, auth = null } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text().catch(() => '');
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* leave null */ }
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

export function createBrain({
  baseUrl = process.env.VAAK_API_BASE_URL || process.env.PUBLIC_BASE_URL || '',
  apiKey = process.env.INTEGRATIONS_API_KEY || '',
  log = () => {},
} = {}) {
  if (!baseUrl) throw new Error('VAAK_API_BASE_URL (or PUBLIC_BASE_URL) is required');
  const base = baseUrl.replace(/\/+$/, '');

  return {
    /**
     * Anaga's next line. Throws on failure so the session can close the call
     * politely rather than sit silent — see session.js `brain_error`.
     */
    async nextTurn(history, lead) {
      const body = {
        lang: lead?.lang || 'en-IN',
        history: history.map((t) => ({ role: t.role, text: t.text })),
      };

      let last = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await postJson(`${base}/api/anaga/turn`, body, { timeoutMs: TURN_TIMEOUT_MS });
          if (res.ok && res.data?.say) return res.data;
          last = new Error(`turn_failed_${res.status}`);
          // 503 = the API's own "LLM unavailable". Retrying immediately will
          // not help; fail fast so the session closes the call gracefully.
          if (res.status === 503) break;
        } catch (err) {
          last = err;
        }
      }
      throw last || new Error('turn_failed');
    },

    /**
     * Report the finished call. Retried with backoff: this is what writes the
     * opt-out to the suppression list, so giving up quietly is not acceptable.
     * Returns { ok:false } only after every attempt failed — the caller logs it
     * loudly and the call result records it.
     */
    async reportOutcome(payload) {
      let delay = 400;
      let last = null;

      for (let attempt = 0; attempt < OUTCOME_RETRIES; attempt++) {
        try {
          const res = await postJson(`${base}/api/calls/outcome`, payload, {
            timeoutMs: OUTCOME_TIMEOUT_MS,
            auth: apiKey,
          });
          if (res.ok) return res.data || { ok: true };
          last = new Error(`outcome_failed_${res.status}`);
          // 4xx will not become a 2xx on retry — stop wasting the window.
          if (res.status >= 400 && res.status < 500) break;
        } catch (err) {
          last = err;
        }
        if (attempt < OUTCOME_RETRIES - 1) {
          await new Promise((r) => setTimeout(r, delay));
          delay *= 2;
        }
      }

      log('outcome_unreported', {
        disposition: payload?.call?.disposition,
        error: String(last && last.message),
      });
      return { ok: false, error: String(last && last.message) };
    },
  };
}
