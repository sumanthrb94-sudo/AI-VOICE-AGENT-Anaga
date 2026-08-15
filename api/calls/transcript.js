// api/calls/transcript.js
//
// GET /api/calls/transcript?callId=…        -> one call, transcript and score
// GET /api/calls/transcript?limit=50        -> recent calls, WITHOUT transcripts
// GET /api/calls/recording?ref=s3://…       -> a short-lived playback URL
// DELETE /api/calls/recording?ref=s3://…    -> DPDP audio erasure
//
// Vercel Hobby permits 12 serverless functions. `vercel.json` rewrites the
// recording route here with `action=recording`, so the two protected call-read
// surfaces share one function without changing either public URL or its auth.

import { requireMethod, authorizeRead } from '../_lib/integrations/http.js';
import { limited, log, requestId } from '../_lib/guard.js';
import { getCall, recentCalls, storeBackend } from '../_lib/store.js';
import { callView } from '../_lib/callview.js';
import { record } from '../_lib/events.js';
import { playbackUrl, deleteRecording, recordingStatus, refToKey } from '../_lib/recording.js';

const MAX_LIMIT = 100;
const DEFAULT_TTL = 300;

export default async function handler(req, res) {
  if (String(req.query?.action || '').toLowerCase() === 'recording') {
    return recordingHandler(req, res);
  }
  return transcriptHandler(req, res);
}

async function transcriptHandler(req, res) {
  if (!requireMethod(req, res, 'GET')) return;

  // A signed-in human OR the machine key. Transcripts carry what a prospect
  // said, so the read is logged with WHO read it when a session was used.
  const auth = await authorizeRead(req, { role: 'viewer' });
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  if (limited(req, res, { bucket: 'transcript', limit: Number(process.env.RATE_LIMIT_TRANSCRIPT || 60) })) return;

  const rid = requestId(req);
  if (storeBackend() !== 'firestore') {
    return res.status(503).json({ error: 'store_not_configured', detail: 'wire FIREBASE_SERVICE_ACCOUNT' });
  }

  const callId = String(req.query?.callId || '').trim();
  if (callId) {
    const out = await getCall(callId);
    if (!out.ok) return res.status(502).json({ error: 'store_unavailable' });
    if (!out.found) return res.status(404).json({ error: 'call_not_found' });

    log('TRANSCRIPT_READ', { rid, callId, turns: Array.isArray(out.data?.transcript) ? out.data.transcript.length : 0 });
    return res.status(200).json({ ok: true, call: callView(out.data, { transcript: true }) });
  }

  const limit = Math.max(1, Math.min(Number(req.query?.limit) || 25, MAX_LIMIT));
  const out = await recentCalls(limit);
  if (!out.ok) return res.status(502).json({ error: 'store_unavailable' });

  return res.status(200).json({
    ok: true,
    calls: (out.docs || []).map((d) => callView(d, { transcript: false })),
    note: 'transcripts are omitted from the list — request one by callId',
  });
}

async function recordingHandler(req, res) {
  if (!requireMethod(req, res, ['GET', 'DELETE'])) return;

  // ASYMMETRIC ON PURPOSE. Playing a recording back is a read any operator may
  // do. DELETING one destroys the evidence that a call happened the way we say
  // it did — under docs/COMPLIANCE.md that artifact is the defence if a
  // complaint is ever raised — so it takes an owner, not merely a session.
  const auth = await authorizeRead(req, { role: req.method === 'DELETE' ? 'owner' : 'viewer' });
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  if (limited(req, res, { bucket: 'recording', limit: Number(process.env.RATE_LIMIT_RECORDING || 60) })) return;

  const rid = requestId(req);
  const status = recordingStatus();
  if (!status.configured) return res.status(503).json({ error: 'recording_not_configured' });

  const ref = String(req.query?.ref || '').trim();
  if (!ref) return res.status(400).json({ error: 'ref_required' });
  // refToKey rejects another bucket and every key shape other than our own,
  // preventing this endpoint from becoming a general-purpose presigning oracle.
  if (!refToKey(ref)) return res.status(400).json({ error: 'invalid_ref' });

  if (req.method === 'DELETE') {
    const out = await deleteRecording(ref);
    // Keep a durable audit event of the erasure, never the audio itself.
    record('recording.erased', { ref, ok: out.ok, error: out.error || null });
    log('RECORDING_DELETED', { rid, ok: out.ok, error: out.error || null });
    return res.status(out.ok ? 200 : 502).json(out);
  }

  const ttl = Math.max(30, Math.min(Number(req.query?.ttl) || DEFAULT_TTL, 3600));
  const url = playbackUrl(ref, ttl);
  if (!url) return res.status(500).json({ error: 'presign_failed' });

  // A signed URL is itself a bearer credential: do not include it in any log.
  log('RECORDING_PLAYBACK_ISSUED', { rid, ttlSec: ttl });
  return res.status(200).json({ url, expiresInSec: ttl });
}
