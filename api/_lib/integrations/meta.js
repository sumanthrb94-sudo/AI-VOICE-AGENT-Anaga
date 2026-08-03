// api/_lib/integrations/meta.js
//
// Meta (Facebook / Instagram) Lead Ads adapter — the ONLY file that knows the
// Graph API exists. It does three things:
//
//   1. answers Meta's webhook verification handshake (GET hub.challenge),
//   2. verifies the X-Hub-Signature-256 HMAC on every POST (fails CLOSED),
//   3. turns a `leadgen` change into a normalized Lead (api/_lib/integrations/lead.js).
//
// Meta's webhook does NOT contain the answers — only a `leadgen_id`. The full
// record must be pulled from the Graph API with a Page access token, so a lead
// that arrives while the token is missing/expired is a hard failure, not a
// silent drop: we return an error and let the endpoint 200 the webhook (Meta
// retries are noisy) while reporting the failure in the response body + logs.
//
// ⚠️ Verify the Graph API version + field names against current Meta docs
// (developers.facebook.com/docs/marketing-api/guides/lead-ads) — they move.

import { fetchJson, hmacSha256Hex, safeEqual } from './http.js';
import { normalizeLead } from './lead.js';

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v21.0';
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

export function metaConfigured() {
  return Boolean(process.env.META_APP_SECRET && process.env.META_PAGE_ACCESS_TOKEN);
}

/** Which pieces are wired — for /api/integrations/health. Never returns values. */
export function metaStatus() {
  return {
    appSecret: Boolean(process.env.META_APP_SECRET),
    verifyToken: Boolean(process.env.META_VERIFY_TOKEN),
    pageAccessToken: Boolean(process.env.META_PAGE_ACCESS_TOKEN),
    graphVersion: GRAPH_VERSION,
  };
}

// ---------------------------------------------------------------------------
// 1. Webhook verification handshake (GET)
// ---------------------------------------------------------------------------

/**
 * Meta calls GET ?hub.mode=subscribe&hub.verify_token=…&hub.challenge=… once,
 * when you save the callback URL.
 * @returns {{ok:boolean, challenge?:string, status:number, error?:string}}
 */
export function verifyChallenge(query = {}) {
  const expected = process.env.META_VERIFY_TOKEN;
  if (!expected) return { ok: false, status: 503, error: 'verify_token_not_configured' };

  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];

  if (mode !== 'subscribe' || !safeEqual(token, expected)) {
    return { ok: false, status: 403, error: 'verification_failed' };
  }
  return { ok: true, status: 200, challenge: String(challenge == null ? '' : challenge) };
}

// ---------------------------------------------------------------------------
// 2. Payload signature (POST) — fails CLOSED
// ---------------------------------------------------------------------------

/**
 * Verify X-Hub-Signature-256: "sha256=<hex hmac of the raw body with the app secret>".
 * An unsigned, mis-signed, or unconfigured request is rejected — anyone who
 * learns the URL could otherwise inject leads and make us dial strangers.
 */
export function verifySignature(rawBody, signatureHeader) {
  const secret = process.env.META_APP_SECRET;
  if (!secret) return { ok: false, error: 'app_secret_not_configured' };

  const header = String(signatureHeader || '');
  if (!header.startsWith('sha256=')) return { ok: false, error: 'missing_signature' };

  const expected = hmacSha256Hex(secret, rawBody || '');
  if (!safeEqual(header.slice(7), expected)) return { ok: false, error: 'bad_signature' };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 3. leadgen change -> Lead
// ---------------------------------------------------------------------------

/**
 * Flatten the webhook envelope into the leadgen changes it carries.
 * Shape: { object: "page", entry: [ { id, time, changes: [ { field:"leadgen", value:{…} } ] } ] }
 * @returns {Array<{leadgenId:string, pageId:string|null, formId:string|null, adId:string|null, createdTime:string|null}>}
 */
export function parseLeadgenChanges(body) {
  if (!body || !Array.isArray(body.entry)) return [];
  const out = [];
  for (const entry of body.entry) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      if (change?.field !== 'leadgen') continue;
      const v = change.value || {};
      if (!v.leadgen_id) continue;
      out.push({
        leadgenId: String(v.leadgen_id),
        pageId: v.page_id ? String(v.page_id) : (entry?.id ? String(entry.id) : null),
        formId: v.form_id ? String(v.form_id) : null,
        adId: v.ad_id ? String(v.ad_id) : null,
        adgroupId: v.adgroup_id ? String(v.adgroup_id) : null,
        createdTime: v.created_time
          ? new Date(Number(v.created_time) * 1000).toISOString()
          : null,
      });
    }
  }
  return out;
}

/**
 * Pull the full lead record from the Graph API.
 * GET /{leadgen_id}?fields=id,created_time,field_data,ad_id,form_id,campaign_name,platform
 */
export async function fetchLeadgen(leadgenId) {
  const token = process.env.META_PAGE_ACCESS_TOKEN;
  if (!token) return { ok: false, error: 'page_access_token_not_configured', data: null };

  const fields = 'id,created_time,field_data,ad_id,ad_name,form_id,campaign_id,campaign_name,platform';
  const url = `${GRAPH}/${encodeURIComponent(leadgenId)}?fields=${fields}&access_token=${encodeURIComponent(token)}`;

  const res = await fetchJson(url, { timeoutMs: 8000 });
  if (!res.ok) {
    // Graph errors are logged server-side only; the token is in the URL.
    const code = res.data?.error?.code;
    return {
      ok: false,
      error: res.status === 0 ? res.error : `graph_error_${res.status}${code ? `_${code}` : ''}`,
      data: null,
    };
  }
  return { ok: true, error: null, data: res.data };
}

/**
 * Map a Graph lead record onto a normalized Lead.
 *
 * `field_data` is `[{ name, values: [...] }]` where `name` is whatever the form
 * builder named the question — so we match a set of known aliases and keep the
 * rest as `_extra` for the CRM note rather than guessing.
 */
export function leadFromGraph(record, change = {}) {
  const flat = { _extra: {} };

  for (const f of Array.isArray(record?.field_data) ? record.field_data : []) {
    const key = String(f?.name || '').toLowerCase().trim();
    const value = Array.isArray(f?.values) ? String(f.values[0] ?? '').trim() : '';
    if (!key || !value) continue;

    if (/(^|_)(phone|mobile|whatsapp)/.test(key)) flat.phone = flat.phone || value;
    else if (key.includes('email')) flat.email = flat.email || value;
    else if (key === 'full_name' || key === 'name') flat.name = flat.name || value;
    else if (key === 'first_name') flat.first_name = value;
    else if (key === 'last_name') flat.last_name = value;
    else if (key.includes('city') || key.includes('location')) flat.city = flat.city || value;
    else if (key.includes('budget')) flat.budget = flat.budget || value;
    else if (key.includes('bhk') || key.includes('configuration')) flat.configuration = flat.configuration || value;
    else if (key.includes('timeline') || key.includes('when')) flat.timeline = flat.timeline || value;
    else if (key.includes('purpose') || key.includes('investment')) flat.purpose = flat.purpose || value;
    else flat._extra[key] = value;
  }

  const submittedAt = record?.created_time
    ? new Date(record.created_time).toISOString()
    : (change.createdTime || null);

  return normalizeLead(flat, {
    source: 'meta_lead_ads',
    sourceId: String(record?.id || change.leadgenId || ''),
    receivedAt: new Date().toISOString(),
    campaign: {
      id: record?.campaign_id || null,
      name: record?.campaign_name || record?.ad_name || null,
      adId: record?.ad_id || change.adId || null,
      formId: record?.form_id || change.formId || null,
      pageId: change.pageId || null,
      platform: record?.platform || 'facebook',
    },
    consent: {
      // Submitting a Lead Ad form IS the consent event, and its timestamp is
      // what the compliance gate ages out (see LEAD_CONSENT_WINDOW_DAYS).
      granted: true,
      basis: 'lead_form',
      at: submittedAt,
    },
  });
}
