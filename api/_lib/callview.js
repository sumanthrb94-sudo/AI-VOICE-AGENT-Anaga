// api/_lib/callview.js
//
// The one place a stored call is shaped for the wire.
//
// Two endpoints hand out call records — /api/calls/transcript and the operator
// console — and they must not be able to disagree about what is safe to emit.
// A masking rule that holds on one path and not the other is the same class of
// bug as a compliance gate that holds on one path and not the other.
//
// Two things this guarantees, whatever the stored document happens to contain:
// the phone number goes out masked, and audio is never reachable from here —
// only the opaque s3:// reference is, and turning that into something playable
// takes a separate authenticated call to /api/calls/recording that logs itself.

import { maskPhone } from './integrations/lead.js';

/**
 * @param {object} d                stored call document
 * @param {object} [opts]
 * @param {boolean} [opts.transcript]  include the conversation
 */
export function callView(d, { transcript = false } = {}) {
  if (!d || typeof d !== 'object') return null;
  const lead = d.lead && typeof d.lead === 'object' ? d.lead : {};

  const out = {
    callId: d.callId || null,
    at: d.at || null,
    startedAt: d.startedAt || null,
    durationSec: d.durationSec ?? null,
    disposition: d.disposition || null,
    optOut: d.optOut === true,

    // Lead potency, with the arithmetic that produced it.
    score: d.score ?? null,
    band: d.band || null,
    scoring: d.scoring || null,
    qualification: d.qualification || null,

    summary: d.summary || null,
    nextAction: d.nextAction || null,
    comment: d.comment || null,
    reviewedBy: d.reviewedBy || null,
    turns: d.turns ?? (Array.isArray(d.transcript) ? d.transcript.length : null),

    // Opaque, never playable. Refuse anything that is not an s3:// reference
    // rather than passing it through — an older record or another writer must
    // not be able to smuggle a URL into a response through this field.
    recordingRef: typeof d.recordingRef === 'string' && d.recordingRef.startsWith('s3://')
      ? d.recordingRef
      : null,

    lead: {
      // Masked by the writer; masked again here, because the cost of doing it
      // twice is nothing and the cost of missing it once is a phone book.
      phoneMasked: lead.phoneMasked || (lead.phone ? maskPhone(lead.phone) : null),
      name: lead.name || null,
      source: lead.source || null,
      sourceId: lead.sourceId || null,
      crmRecordId: lead.crmRecordId || null,
    },
  };

  if (transcript) {
    out.transcript = (Array.isArray(d.transcript) ? d.transcript : [])
      .filter((t) => t && typeof t === 'object' && typeof t.text === 'string')
      .map((t) => ({ role: t.role === 'agent' ? 'agent' : 'user', text: t.text }));
  }
  return out;
}
