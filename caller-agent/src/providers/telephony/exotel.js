// caller-agent/src/providers/telephony/exotel.js
//
// Exotel adapter — the second India telephony option named in
// engineering/MULTI_AGENT_SPEC.md §1. Same interface as plivo.js and mock.js.
//
// ⚠️ VERIFICATION STATUS: same as the Plivo adapter — implemented to Exotel's
// documented v1 API, NOT exercised against a live account (no credentials in
// this repo or CI). Run the WP-1 spike before launch.
//
// Exotel's Connect API is form-encoded, not JSON, and the subdomain is
// region-specific (api.exotel.com vs api.in.exotel.com). Both are configurable
// rather than hard-coded, because getting either wrong fails silently-ish.
//
// Docs: https://developer.exotel.com/api/make-a-call — verify before deploy.

function authHeader() {
  const sid = process.env.EXOTEL_SID || '';
  const token = process.env.EXOTEL_TOKEN || '';
  const key = process.env.EXOTEL_API_KEY || sid;
  return 'Basic ' + Buffer.from(`${key}:${token}`).toString('base64');
}

function baseUrl() {
  const host = process.env.EXOTEL_SUBDOMAIN || 'api.in.exotel.com';
  const sid = process.env.EXOTEL_SID || '';
  return `https://${host}/v1/Accounts/${sid}`;
}

async function exotel(path, form) {
  if (!process.env.EXOTEL_SID) throw new Error('EXOTEL_SID not configured');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(`${baseUrl()}${path}`, {
      method: 'POST',
      headers: {
        Authorization: authHeader(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(form).toString(),
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

export function createExotelTelephony({ media = null, mediaServerUrl = process.env.MEDIA_SERVER_URL } = {}) {
  let callSid = null;
  let live = false;

  return {
    id: 'exotel',

    async dial({ to, from, callId }) {
      if (!mediaServerUrl) {
        return { answered: false, reason: 'media_server_not_configured', callId };
      }

      const res = await exotel('/Calls/connect.json', {
        From: from,
        To: to,
        CallerId: process.env.OUTBOUND_CALLER_ID || from,
        Url: mediaServerUrl,
        TimeLimit: String(Number(process.env.CALL_MAX_SECONDS || 300)),
        TimeOut: String(Number(process.env.DIAL_RING_TIMEOUT_SEC || 30)),
        StatusCallback: process.env.TELEPHONY_STATUS_URL || '',
      });

      if (!res.ok) {
        const reason = res.status === 0 ? 'network_error' : `exotel_error_${res.status}`;
        return { answered: false, reason, callId };
      }

      callSid = res.data?.Call?.Sid || null;
      live = Boolean(media);
      return { answered: live, reason: live ? null : 'awaiting_media_server', callId, callSid };
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
      if (callSid) {
        await exotel(`/Calls/${callSid}.json`, { Status: 'completed' }).catch(() => {});
      }
      return { ended: reason };
    },
  };
}
