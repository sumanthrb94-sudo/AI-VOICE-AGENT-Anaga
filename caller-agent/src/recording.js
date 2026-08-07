// caller-agent/src/recording.js
//
// Uploads a finished call's audio to the recording store.
//
// The agent runs on our own host, so it talks to S3 directly rather than
// shipping tens of megabytes of audio through a serverless function that has a
// 30-second budget and a payload cap. The signing, the Indian-region gate and
// the key format all come from api/_lib/recording.js — one implementation, so
// the residency rule cannot hold on one path and not the other.
//
// Returns { ok, ref, error } and NEVER throws. A recording we failed to store
// must not take the opt-out down with it.

import { putRecording, recordingStatus } from '../../api/_lib/recording.js';

/**
 * @param {object}  opts
 * @param {string}  opts.callId
 * @param {Buffer}  opts.audio      WAV bytes for the whole call
 * @param {string} [opts.startedAt] ISO — keys are dated by call start, not by
 *                                  upload time, so a call that ends past
 *                                  midnight files under the day it happened.
 */
export async function storeRecording({ callId, audio, startedAt } = {}) {
  const status = recordingStatus();
  if (!status.configured) return { ok: false, ref: null, error: 'recording_not_configured' };

  const at = startedAt ? new Date(startedAt) : new Date();
  return putRecording({
    callId,
    audio,
    contentType: 'audio/wav',
    at: Number.isNaN(at.getTime()) ? new Date() : at,
  });
}

export { recordingStatus };
