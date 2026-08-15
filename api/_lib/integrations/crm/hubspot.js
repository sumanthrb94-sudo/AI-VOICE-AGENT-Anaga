// api/_lib/integrations/crm/hubspot.js
//
// HubSpot adapter (private-app token). Contacts are keyed on the E.164 phone:
// search -> create or update, then attach the Anaga call as a Note.
//
// Auth: HUBSPOT_ACCESS_TOKEN (Private App). Required scopes:
//   crm.objects.contacts.read, crm.objects.contacts.write, crm.objects.notes.write
//
// Custom properties (create them once in HubSpot, or rename via env):
//   anaga_disposition (text) · anaga_intent_score (number) · anaga_last_call (datetime)
//   plus a DND checkbox named by CRM_DND_PROPERTY (default: anaga_dnd)
// Unknown properties make HubSpot reject the whole write, so a property write
// that 400s is retried once with only the standard fields.
//
// ⚠️ BREAKING, at the rename: these four defaults were vaak_disposition,
// vaak_intent_score, vaak_last_call and vaak_dnd. They name properties that
// live in SOMEBODY ELSE'S HubSpot, so this repo cannot rename them there —
// a portal that already has the vaak_* properties must either rename them in
// HubSpot or set CRM_DND_PROPERTY=vaak_dnd and keep the old names. Doing
// neither does not lose data loudly: the write 400s, the retry drops every
// custom property, and the call is recorded with no disposition and no score.


//
// ⚠️ Verify endpoints against current HubSpot docs (developers.hubspot.com).

import { fetchJson } from '../http.js';

export const id = 'hubspot';

const BASE = 'https://api.hubapi.com';
const NOTE_TO_CONTACT_ASSOCIATION = 202;   // HubSpot's note->contact association type id

export function configured() {
  return Boolean(process.env.HUBSPOT_ACCESS_TOKEN);
}

function headers() {
  return {
    Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

function dndProperty() {
  return process.env.CRM_DND_PROPERTY || 'anaga_dnd';
}

async function findContactByPhone(phone) {
  const res = await fetchJson(`${BASE}/crm/v3/objects/contacts/search`, {
    method: 'POST',
    headers: headers(),
    body: {
      filterGroups: [{ filters: [{ propertyName: 'phone', operator: 'EQ', value: phone }] }],
      properties: ['phone', 'firstname', 'lastname', 'email'],
      limit: 1,
    },
    timeoutMs: 8000,
  });
  if (!res.ok) return { ok: false, error: res.error, id: null };
  const hit = res.data?.results?.[0];
  return { ok: true, error: null, id: hit?.id || null };
}

function nameParts(lead) {
  const parts = String(lead.name || '').trim().split(/\s+/).filter(Boolean);
  return { first: parts[0] || '', last: parts.slice(1).join(' ') };
}

/**
 * Write properties, dropping the custom ones and retrying once if HubSpot
 * rejects an unknown property (400) — a missing custom property must not cost
 * us the lead record itself.
 */
async function writeContact(contactId, properties, standardKeys) {
  const url = contactId
    ? `${BASE}/crm/v3/objects/contacts/${contactId}`
    : `${BASE}/crm/v3/objects/contacts`;
  const method = contactId ? 'PATCH' : 'POST';

  let res = await fetchJson(url, { method, headers: headers(), body: { properties }, timeoutMs: 8000 });
  if (!res.ok && res.status === 400 && standardKeys) {
    const safe = {};
    for (const k of standardKeys) if (properties[k] != null) safe[k] = properties[k];
    res = await fetchJson(url, { method, headers: headers(), body: { properties: safe }, timeoutMs: 8000 });
  }
  return res;
}

export async function upsertLead(lead) {
  if (!configured()) return { ok: false, error: 'hubspot_token_not_configured', recordId: null };

  const found = await findContactByPhone(lead.phone);
  if (!found.ok) return { ok: false, error: found.error, recordId: null };

  const { first, last } = nameParts(lead);
  const properties = {
    phone: lead.phone,
    ...(first ? { firstname: first } : {}),
    ...(last ? { lastname: last } : {}),
    ...(lead.email ? { email: lead.email } : {}),
    ...(lead.city ? { city: lead.city } : {}),
    hs_lead_status: 'NEW',
    anaga_disposition: 'queued',
  };

  const res = await writeContact(found.id, properties, ['phone', 'firstname', 'lastname', 'email', 'city']);
  if (!res.ok) return { ok: false, error: res.error, recordId: found.id };
  return { ok: true, error: null, recordId: res.data?.id || found.id };
}

async function createNote(contactId, bodyText) {
  const res = await fetchJson(`${BASE}/crm/v3/objects/notes`, {
    method: 'POST',
    headers: headers(),
    body: {
      properties: {
        hs_note_body: bodyText,
        hs_timestamp: new Date().toISOString(),
      },
      associations: contactId ? [{
        to: { id: contactId },
        types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: NOTE_TO_CONTACT_ASSOCIATION }],
      }] : [],
    },
    timeoutMs: 8000,
  });
  return { ok: res.ok, error: res.error };
}

export async function logCall(lead, review, call, noteBody) {
  if (!configured()) return { ok: false, error: 'hubspot_token_not_configured' };

  const found = lead.crmRecordId
    ? { ok: true, id: lead.crmRecordId, error: null }
    : await findContactByPhone(lead.phone);
  if (!found.ok) return { ok: false, error: found.error };
  if (!found.id) {
    const created = await upsertLead(lead);
    if (!created.ok) return { ok: false, error: created.error };
    found.id = created.recordId;
  }

  const note = await createNote(found.id, noteBody);

  // Best-effort property roll-up; the note is the record of truth.
  await writeContact(found.id, {
    anaga_disposition: review?.disposition || 'undecided',
    anaga_intent_score: Number.isFinite(review?.score) ? review.score : 0,
    anaga_last_call: new Date().toISOString(),
    hs_lead_status: review?.disposition === 'booked' ? 'CONNECTED' : 'ATTEMPTED_TO_CONTACT',
  }, []);

  return { ok: note.ok, error: note.error };
}

export async function markOptOut(lead, reason) {
  if (!configured()) return { ok: false, error: 'hubspot_token_not_configured' };

  const found = lead.crmRecordId
    ? { ok: true, id: lead.crmRecordId, error: null }
    : await findContactByPhone(lead.phone);
  if (!found.ok) return { ok: false, error: found.error };
  if (!found.id) return { ok: false, error: 'contact_not_found' };

  const res = await writeContact(found.id, {
    [dndProperty()]: true,
    hs_lead_status: 'UNQUALIFIED',
    anaga_disposition: 'opt-out',
  }, []);
  if (!res.ok) return { ok: false, error: res.error };

  await createNote(found.id, `🚫 Opt-out recorded by Anaga (${reason || 'requested by prospect'}). Number added to the Modcon Builders do-not-call list. Do not dial again.`);
  return { ok: true, error: null };
}
