// api/_lib/integrations/lead.js
//
// The canonical Lead shape — the single normalized object every source
// (Meta Lead Ads, a CRM push, a CSV upload, a landing page) is converted into
// before it touches the compliance gate, the dial queue, or the CRM writeback.
//
// Business logic downstream NEVER sees a vendor payload; it sees a Lead. That
// is the same provider-abstraction boundary MULTI_AGENT_SPEC §1 principle 2
// draws around STT/LLM/TTS — applied to lead sources.

// ---------------------------------------------------------------------------
// Phone normalization (India-first, E.164 out)
// ---------------------------------------------------------------------------

/**
 * Normalize a phone number to E.164. India-first: bare 10-digit mobiles get
 * +91; 0-prefixed and 91-prefixed forms are cleaned. Non-Indian numbers are
 * accepted only if already in a plausible international form.
 *
 * @returns {string|null} E.164 (e.g. "+919876543210") or null if unusable.
 */
export function normalizePhone(input) {
  if (input == null) return null;
  let s = String(input).trim();
  if (!s) return null;

  const hadPlus = s.startsWith('+');
  s = s.replace(/[^\d]/g, '');
  if (!s) return null;

  // 00-prefixed international dialling
  if (!hadPlus && s.startsWith('00')) s = s.slice(2);

  const defaultCc = (process.env.DEFAULT_COUNTRY_CODE || '91').replace(/\D/g, '') || '91';

  if (defaultCc === '91') {
    if (s.length === 10 && /^[6-9]/.test(s)) return `+91${s}`;          // 9876543210
    if (s.length === 11 && s.startsWith('0')) {
      const rest = s.slice(1);
      if (/^[6-9]\d{9}$/.test(rest)) return `+91${rest}`;                // 09876543210
    }
    if (s.length === 12 && s.startsWith('91') && /^[6-9]/.test(s.slice(2))) {
      return `+91${s.slice(2)}`;                                        // 919876543210
    }
  } else if (s.length === 10) {
    return `+${defaultCc}${s}`;
  }

  // Already international (8–15 digits per E.164).
  if (s.length >= 8 && s.length <= 15) return `+${s}`;
  return null;
}

/** Mask a phone for logs / non-privileged responses: +9198XXXXXX10 */
export function maskPhone(phone) {
  const s = String(phone || '');
  if (s.length < 7) return '***';
  return `${s.slice(0, 5)}${'X'.repeat(Math.max(0, s.length - 7))}${s.slice(-2)}`;
}

// ---------------------------------------------------------------------------
// Lead construction
// ---------------------------------------------------------------------------

const QUALIFY_KEYS = ['purpose', 'budget', 'configuration', 'timeline'];

/**
 * Build a normalized Lead from a loosely-shaped source object.
 *
 * @param {object} raw    source fields (already flattened by the source adapter)
 * @param {object} ctx    { source, sourceId, campaign, consent, receivedAt }
 * @returns {object} Lead
 */
export function normalizeLead(raw = {}, ctx = {}) {
  const pick = (...keys) => {
    for (const k of keys) {
      const v = raw[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
      if (typeof v === 'number') return String(v);
    }
    return '';
  };

  const phone = normalizePhone(pick('phone', 'phone_number', 'mobile', 'mobileNumber', 'contact'));
  const name = pick('name', 'full_name', 'fullName', 'first_name', 'firstName') ||
    [pick('first_name', 'firstName'), pick('last_name', 'lastName')].filter(Boolean).join(' ').trim();

  const known = {};
  for (const k of QUALIFY_KEYS) {
    const v = pick(k, k.toLowerCase(), `${k}_answer`);
    if (v) known[k] = v;
  }

  return {
    // identity
    id: ctx.sourceId ? `${ctx.source || 'unknown'}:${ctx.sourceId}` : null,
    source: ctx.source || 'unknown',          // meta_lead_ads | crm | api | csv
    sourceId: ctx.sourceId || null,           // leadgen_id, CRM record id, …
    receivedAt: ctx.receivedAt || new Date().toISOString(),

    // contact
    name: name || '',
    phone,                                    // E.164 or null
    email: pick('email', 'email_address'),
    city: pick('city', 'location', 'town'),
    lang: pick('lang', 'language', 'preferred_language') || null,

    // anything the form already answered — Anaga skips what it already knows
    known,

    // attribution
    campaign: {
      id: ctx.campaign?.id || pick('campaign_id') || null,
      name: ctx.campaign?.name || pick('campaign_name') || null,
      adId: ctx.campaign?.adId || pick('ad_id') || null,
      formId: ctx.campaign?.formId || pick('form_id') || null,
      pageId: ctx.campaign?.pageId || pick('page_id') || null,
      platform: ctx.campaign?.platform || pick('platform') || null,
    },

    // consent provenance — the compliance gate reads this, so it must be honest
    consent: {
      granted: ctx.consent?.granted === true,
      // "lead_form" = the person submitted a Meta/landing-page form asking to be
      // contacted. "crm" = the CRM asserts consent. "none" = no basis to dial.
      basis: ctx.consent?.basis || 'none',
      at: ctx.consent?.at || null,            // ISO timestamp of the submission
    },

    // free-form extras kept for the CRM note; never used for logic
    extra: raw._extra && typeof raw._extra === 'object' ? raw._extra : {},
  };
}

/**
 * Validate a Lead is dial-shaped. This is a data check, NOT the compliance
 * gate — see api/_lib/compliance.js for legality.
 * @returns {{ok:boolean, error?:string}}
 */
export function validateLead(lead) {
  if (!lead || typeof lead !== 'object') return { ok: false, error: 'invalid_lead' };
  if (!lead.phone) return { ok: false, error: 'phone_required' };
  if (!/^\+\d{8,15}$/.test(lead.phone)) return { ok: false, error: 'phone_not_e164' };
  return { ok: true };
}

/** Compact, PII-masked view of a Lead for logs and API responses. */
export function leadSummary(lead) {
  return {
    id: lead.id,
    source: lead.source,
    name: lead.name || null,
    phone: maskPhone(lead.phone),
    campaign: lead.campaign?.name || lead.campaign?.id || null,
    consentBasis: lead.consent?.basis || 'none',
  };
}
