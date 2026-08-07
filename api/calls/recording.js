// api/calls/recording.js
//
// GET    /api/calls/recording?ref=s3://…  -> { url, expiresInSec }  (playback)
// DELETE /api/calls/recording?ref=s3://…  -> { ok }                 (DPDP erasure)
//
// Both require the operator key. This endpoint exists so that a recording
// reference stored in Firestore or a CRM note is USELESS on its own: playing a
// call back takes a credential, and every playback is logged.
//
// The alternative — putting a durable public URL in the CRM — would mean the
// recording is readable by every sales rep, every CRM integration, and every
// future export of that CRM, forever. A short-lived signed URL minted behind
// auth is the whole point.

import { requireMethod, authorize } from '../_lib/integrations/http.js';
import { limited, log, requestId } from '../_lib/guard.js';
import { record } from '../_lib/events.js';
import { playbackUrl, deleteRecording, recordingStatus, refToKey } from '../_lib/recording.js';

const DEFAULT_TTL = 300;

export default async function handler(req, res) {
  if (!requireMethod(req, res, ['GET', 'DELETE'])) return;

  const auth = authorize(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  if (limited(req, res, { bucket: 'recording', limit: Number(process.env.RATE_LIMIT_RECORDING || 60) })) return;

  const rid = requestId(req);
  const status = recordingStatus();
  if (!status.configured) return res.status(503).json({ error: 'recording_not_configured' });

  const ref = String(req.query?.ref || '').trim();
  if (!ref) return res.status(400).json({ error: 'ref_required' });
  // Validate before doing anything: refToKey also refuses a reference that
  // names a different bucket, which is what stops this becoming a presigning
  // oracle for any object anyone can name.
  if (!refToKey(ref)) return res.status(400).json({ error: 'invalid_ref' });

  if (req.method === 'DELETE') {
    const out = await deleteRecording(ref);
    // Erasure is a compliance action and must leave a DURABLE trace — of the
    // deletion, not of the audio. The DPDP right is to the recording, not to
    // the fact that a lawful call happened, and `docs/COMPLIANCE.md` asks for an
    // immutable per-call log. A `log()` line alone lives in whatever the
    // platform retains, which is not an audit trail we control.
    //
    // The reference is recorded rather than the phone number: it identifies the
    // call for an auditor without putting a number into another store.
    record('recording.erased', { ref, ok: out.ok, error: out.error || null });
    log('RECORDING_DELETED', { rid, ok: out.ok, error: out.error || null });
    return res.status(out.ok ? 200 : 502).json(out);
  }

  const ttl = Math.max(30, Math.min(Number(req.query?.ttl) || DEFAULT_TTL, 3600));
  const url = playbackUrl(ref, ttl);
  if (!url) return res.status(500).json({ error: 'presign_failed' });

  // The URL itself is a bearer credential for that object — never log it.
  log('RECORDING_PLAYBACK_ISSUED', { rid, ttlSec: ttl });
  return res.status(200).json({ url, expiresInSec: ttl });
}
