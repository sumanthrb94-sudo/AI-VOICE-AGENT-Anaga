// caller-agent/src/providers/telephony/plivo.js
//
// Plivo India adapter.
//
// ⚠️ VERIFICATION STATUS — read before you trust this in production.
// The call-control half (REST outbound dial, hangup, status) is implemented to
// Plivo's documented v1 API but has NOT been exercised against a live Plivo
// account, because no credentials exist in this repo or in CI. Treat it as
// reviewed-but-unverified: run the WP-1 spike (one real call) before launch.
//
// The MEDIA half — bidirectional audio streaming — is deliberately not faked.
// Plivo streams audio over a WebSocket that your server must host and answer
// with Plivo XML; that server is `mediaServerUrl` below and is the remaining
// build item for a real deployment (see LAUNCH.md). `say()`/`listen()` here
// delegate to whatever media transport is injected, so the session logic is
// identical for mock and real.
//
// Docs: https://www.plivo.com/docs/voice/api/call — verify field names, they move.

const PLIVO_API = 'https://api.plivo.com/v1/Account';

function authHeader() {
  const id = process.env.PLIVO_AUTH_ID || '';
  const token = process.env.PLIVO_AUTH_TOKEN || '';
  return 'Basic ' + Buffer.from(`${id}:${token}`).toString('base64');
}

async function plivo(path, { method = 'POST', body } = {}) {
  const id = process.env.PLIVO_AUTH_ID;
  if (!id) throw new Error('PLIVO_AUTH_ID not configured');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(`${PLIVO_API}/${id}${path}`, {
      method,
      headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text().catch(() => '');
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { _raw: text.slice(0, 300) }; }
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {object} opts
 * @param {object} [opts.media] injected media transport implementing say/listen.
 *        Required for a real conversation; without it the adapter can dial and
 *        hang up but cannot talk, and says so rather than pretending.
 */
export function createPlivoTelephony({ media = null, mediaServerUrl = process.env.MEDIA_SERVER_URL } = {}) {
  let callUuid = null;
  let live = false;

  return {
    id: 'plivo',

    async dial({ to, from, callId }) {
      if (!mediaServerUrl) {
        // Fail loudly rather than placing a call we cannot speak on.
        return { answered: false, reason: 'media_server_not_configured', callId };
      }

      const res = await plivo('/Call/', {
        body: {
          to: String(to).replace(/^\+/, ''),
          from: String(from).replace(/^\+/, ''),
          answer_url: mediaServerUrl,
          answer_method: 'POST',
          // Plivo will POST call lifecycle events here; the session uses them
          // to notice a callee hangup it did not initiate.
          hangup_url: process.env.TELEPHONY_STATUS_URL || undefined,
          ring_timeout: Number(process.env.DIAL_RING_TIMEOUT_SEC || 30),
        },
      });

      if (!res.ok) {
        const reason = res.status === 0 ? 'network_error' : `plivo_error_${res.status}`;
        return { answered: false, reason, callId };
      }

      callUuid = res.data?.request_uuid || res.data?.call_uuid || null;
      // Plivo's REST dial returns once the call is QUEUED, not answered. The
      // media server signals the actual answer; without it we cannot claim one.
      live = Boolean(media);
      return { answered: live, reason: live ? null : 'awaiting_media_server', callId, callUuid };
    },

    async say(text) {
      if (!live || !media) return false;
      return media.say(text);
    },

    async listen() {
      if (!live || !media) return { text: null, hangup: true, silent: false };
      return media.listen();
    },

    async hangup(reason = 'agent_ended') {
      live = false;
      if (callUuid) await plivo(`/Call/${callUuid}/`, { method: 'DELETE' }).catch(() => {});
      return { ended: reason };
    },
  };
}
