// api/calls/transcript.js
//
// GET /api/calls/transcript?callId=…        -> one call, transcript and score
// GET /api/calls/transcript?limit=50        -> recent calls, WITHOUT transcripts
//
// Requires the operator key. This is the read side of the call record that
// /api/calls/outcome writes.
//
// It exists because the transcript had nowhere to go. `recordCall` was in
// store.js and was called by nothing, so a finished call left a summary event
// and the conversation itself was discarded when the request returned. Three
// things need it: a closer working the lead wants to read what was actually
// said, docs/COMPLIANCE.md wants a call to be evidenceable, and a disputed
// opt-out is settled by the transcript or it is not settled at all.
//
// The list view deliberately omits transcripts. A single request that returns
// fifty conversations is a data-exfiltration shape, and paging through calls to
// find one is not what anybody actually does — they arrive with a call id from
// the CRM note.
//
// Phone numbers are masked at rest by the writer and masked again here on the
// way out, because two independent guards is the right number for the field
// that turns this collection into a phone book.

import { requireMethod, authorize } from '../_lib/integrations/http.js';
import { limited, log, requestId } from '../_lib/guard.js';
import { maskPhone } from '../_lib/integrations/lead.js';
import { getCall, recentCalls, storeBackend } from '../_lib/store.js';

const MAX_LIMIT = 100;

export default async function handler(req, res) {
  if (!requireMethod(req, res, 'GET')) return;

  const auth = authorize(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  if (limited(req, res, { bucket: 'transcript', limit: Number(process.env.RATE_LIMIT_TRANSCRIPT || 60) })) return;

  const rid = requestId(req);
  if (storeBackend() !== 'firestore') {
    // Be explicit rather than returning an empty list. "No calls" and "no
    // database" look identical to a caller and mean opposite things.
    return res.status(503).json({ error: 'store_not_configured', detail: 'wire FIREBASE_SERVICE_ACCOUNT' });
  }

  const callId = String(req.query?.callId || '').trim();

  if (callId) {
    const out = await getCall(callId);
    if (!out.ok) return res.status(502).json({ error: 'store_unavailable' });
    if (!out.found) return res.status(404).json({ error: 'call_not_found' });

    // Reading a transcript is reading what a member of the public said on a
    // recorded call. It is logged for the same reason playback is.
    log('TRANSCRIPT_READ', { rid, callId, turns: Array.isArray(out.data?.transcript) ? out.data.transcript.length : 0 });
    return res.status(200).json({ ok: true, call: safeCall(out.data, { transcript: true }) });
  }

  const limit = Math.max(1, Math.min(Number(req.query?.limit) || 25, MAX_LIMIT));
  const out = await recentCalls(limit);
  if (!out.ok) return res.status(502).json({ error: 'store_unavailable' });

  return res.status(200).json({
    ok: true,
    calls: (out.docs || []).map((d) => safeCall(d, { transcript: false })),
    note: 'transcripts are omitted from the list — request one by callId',
  });
}

/** Shape a stored call for the wire. Never emits an unmasked number. */
function safeCall(d, { transcript }) {
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
    // An opaque s3:// reference, never a playable URL. Audio is fetched from
    // /api/calls/recording, which mints a short-lived signed URL and logs it.
    recordingRef: typeof d.recordingRef === 'string' ? d.recordingRef : null,
    lead: {
      // Masked by the writer; masked again here in case an older record, or a
      // record written by something else, got in with a full number.
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
