// api/live/token.js
//
// GET  /api/live/token  -> { available: boolean, model }     (capability probe; never throws)
// POST /api/live/token  -> { token, model, expiresAt }       | 503 { error: "live_unavailable" }
//
// Mints a SHORT-LIVED Gemini Live "ephemeral token" so the browser can open a
// realtime, full-duplex voice WebSocket DIRECTLY to Google — without ever seeing
// the raw GEMINI_API_KEY. The browser uses the returned token as the
// `access_token` query param on the v1alpha BidiGenerateContentConstrained WS
// (see web/assets/live-call.js). The key lives ONLY in server-side env.
//
// Mirrors the defensive style of api/tts.js: a GET probe that never errors, a
// POST that fails soft (503, no key/URL/stack ever leaked). Uses the global
// `fetch` from Node 18+ (Vercel) — no npm dependencies.
//
// ── How the ephemeral token is minted (verified against Google docs, 2026) ──
// Ephemeral tokens are created via the v1alpha REST method `auth_tokens.create`:
//
//   POST https://generativelanguage.googleapis.com/v1alpha/auth_tokens?key=GEMINI_API_KEY
//   Content-Type: application/json
//   {
//     "uses": 1,                                  // single Live connection
//     "expireTime": "<RFC3339, ~30 min out>",     // window to USE the connection
//     "newSessionExpireTime": "<RFC3339, ~2 min>",// window to START the session
//     "liveConnectConstraints": {                 // lock the token to one model
//       "model": "models/<live-model>",
//       "config": { "responseModalities": ["AUDIO"] }
//     }
//   }
//
// Response: { "name": "<ephemeral-token>", "expireTime": "...", ... }
// The browser then connects with: ...?access_token=<name>  (only on v1alpha).
// Docs: https://ai.google.dev/gemini-api/docs/ephemeral-tokens
//       https://ai.google.dev/gemini-api/docs/live-api

// Default Live model — a native-audio Flash model (low-latency, multilingual
// speech in/out, incl. Hindi & Telugu). Override with GEMINI_LIVE_MODEL.
// Verify the current id at https://ai.google.dev/gemini-api/docs/models.
const DEFAULT_LIVE_MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025';

// Ephemeral tokens are a v1alpha-only feature.
const AUTH_TOKENS_URL = 'https://generativelanguage.googleapis.com/v1alpha/auth_tokens';

const MINT_TIMEOUT_MS = 10000;

function liveModel() {
  const m = (process.env.GEMINI_LIVE_MODEL || '').trim();
  return m || DEFAULT_LIVE_MODEL;
}

// Capability gate — identical contract to api/_lib/tts.js#ttsAvailable.
function liveAvailable() {
  return !!process.env.GEMINI_API_KEY;
}

// The model field on the WS setup / token constraint wants the "models/" prefix.
function modelResource(model) {
  return /^models\//.test(model) ? model : `models/${model}`;
}

export default async function handler(req, res) {
  // ── Capability probe — lets the browser decide whether to offer a live call.
  // Never throws, never touches the network, never reveals the key itself.
  if (req.method === 'GET') {
    return res.status(200).json({
      available: liveAvailable(),
      model: liveModel(),
    });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    // Fail closed — browser falls back to its turn-based call demo.
    return res.status(503).json({ error: 'live_unavailable' });
  }

  const model = liveModel();
  const now = Date.now();
  // Window to USE the live connection once opened (Google default ~30 min).
  const expireMs = now + 30 * 60 * 1000;
  // Window to START the session with this token (kept short; Google default ~1 min).
  const newSessionMs = now + 2 * 60 * 1000;

  // Lock the token to AUDIO output on this one model so a leaked token can't be
  // repurposed (defense in depth — the token is short-lived and single-use too).
  const body = {
    uses: 1,
    expireTime: new Date(expireMs).toISOString(),
    newSessionExpireTime: new Date(newSessionMs).toISOString(),
    liveConnectConstraints: {
      model: modelResource(model),
      config: {
        responseModalities: ['AUDIO'],
      },
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MINT_TIMEOUT_MS);

  let resp;
  try {
    resp = await fetch(`${AUTH_TOKENS_URL}?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (_) {
    // Network error / abort (timeout). Never surface the URL (it carries the key).
    clearTimeout(timer);
    return res.status(503).json({ error: 'live_unavailable' });
  } finally {
    clearTimeout(timer);
  }

  if (!resp || !resp.ok) {
    // Read a little of the body for server-side logs only; never return it.
    try {
      if (resp) { const detail = (await resp.text()).slice(0, 200); if (detail) console.error('live_token_mint_failed', resp.status, detail); }
    } catch (_) { /* ignore */ }
    return res.status(503).json({ error: 'live_unavailable' });
  }

  let data;
  try {
    data = await resp.json();
  } catch (_) {
    return res.status(503).json({ error: 'live_unavailable' });
  }

  // The ephemeral token is returned as `name`. This is the ONLY secret we hand
  // to the browser — it is short-lived, single-use, and model-scoped.
  const token = data && typeof data.name === 'string' ? data.name : '';
  if (!token) {
    return res.status(503).json({ error: 'live_unavailable' });
  }

  // expireTime is the use-window; surface it so the client can refresh in time.
  const expiresAt = (data && typeof data.expireTime === 'string')
    ? data.expireTime
    : new Date(expireMs).toISOString();

  return res.status(200).json({ token, model, expiresAt });
}
