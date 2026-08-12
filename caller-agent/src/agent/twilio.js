// caller-agent/src/agent/twilio.js
//
// The phone leg. Twilio Media Streams on one side, the same bridge the browser
// uses on the other.
//
// ── WHY THIS FILE IS SMALL ────────────────────────────────────────────────
// Because the bridge is transport-agnostic, this is a CODEC and nothing else —
// exactly what caller-agent/src/media/server.js already does for Plivo and
// Exotel. Deepgram's own reference calls the shape a "protocol-agnostic
// server": a browser and a Twilio stream send the same audio through the same
// conversation, and only the envelope differs.
//
// ── AND WHY NOTHING TRANSCODES ────────────────────────────────────────────
// Twilio speaks 8 kHz G.711 mulaw. Deepgram's live socket ACCEPTS 8 kHz mulaw.
// Sarvam Bulbul can SYNTHESIZE 8 kHz mulaw. So the bytes Twilio sends go
// straight to the recogniser and the bytes Bulbul returns go straight back to
// the phone, base64 in and base64 out and nothing decoded in between.
//
// That is not only less code. Every conversion between mulaw and linear costs
// quality, and telephony audio starts with none to spare — resampling 8k up to
// 16k to satisfy a hardcoded constant would have made the recogniser's job
// harder for no reason at all.

import crypto from 'node:crypto';

export const TWILIO_FORMAT = { encoding: 'mulaw', sampleRate: 8000 };

/**
 * The TwiML that answers a call and opens the stream.
 *
 * `<Connect><Stream>` rather than `<Start><Stream>`: Start forks a copy of the
 * audio and lets the call continue down the rest of the TwiML, which is a
 * transcription setup. Connect hands the call TO us bidirectionally, which is
 * the only one of the two that can talk back.
 */
export function twiml(wsUrl) {
  return '<?xml version="1.0" encoding="UTF-8"?>'
    + '<Response><Connect>'
    + `<Stream url="${String(wsUrl).replace(/[<>&"]/g, (c) => (
      { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]))}" />`
    + '</Connect></Response>';
}

/**
 * Is this request really from Twilio?
 *
 * THIS ENDPOINT ANSWERS PHONE CALLS AND SPENDS MONEY. Without the check,
 * anyone who finds the URL can open a socket, burn Deepgram and Sarvam minutes,
 * and make our agent talk to them — and on this product an unverified caller
 * would also be one the compliance gate never saw.
 *
 * Twilio's scheme: HMAC-SHA1 over the full URL with every POST parameter
 * appended in key-sorted order, base64.
 * https://www.twilio.com/docs/usage/security#validating-signatures
 */
export function validSignature({ url, params, signature, token }) {
  if (!token || !signature) return false;
  let data = String(url);
  for (const k of Object.keys(params || {}).sort()) data += k + params[k];
  const mine = crypto.createHmac('sha1', token).update(Buffer.from(data, 'utf8')).digest('base64');
  const a = Buffer.from(mine);
  const b = Buffer.from(String(signature));
  // Constant time, and length-checked first because timingSafeEqual throws on
  // a mismatch rather than returning false.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Translate one Twilio message.
 *
 * @returns {{type:'start',streamSid:string}|{type:'audio',audio:Buffer}|{type:'stop'}|null}
 */
export function parseTwilio(raw) {
  let m;
  try { m = JSON.parse(String(raw)); } catch { return null; }
  if (!m || typeof m !== 'object') return null;

  if (m.event === 'start') {
    return { type: 'start', streamSid: String(m.start?.streamSid || m.streamSid || '') };
  }
  if (m.event === 'media') {
    // INBOUND ONLY. With both tracks streamed, the outbound one is our own
    // voice coming back — feeding that to the recogniser is the self-answer
    // loop this project has already shipped three times, and no echo guard is
    // needed if we simply never listen to ourselves.
    if (m.media?.track && m.media.track !== 'inbound') return null;
    const payload = m.media?.payload;
    if (!payload) return null;
    return { type: 'audio', audio: Buffer.from(payload, 'base64') };
  }
  if (m.event === 'stop') return { type: 'stop' };
  return null;                                    // 'connected', 'mark', pings
}

/** Her voice, wrapped for Twilio. */
export function mediaFrame(streamSid, audio) {
  return JSON.stringify({
    event: 'media',
    streamSid,
    media: { payload: Buffer.from(audio).toString('base64') },
  });
}

/**
 * Stop playback immediately — barge-in.
 *
 * Twilio buffers audio we have already sent, so cancelling on our side is not
 * enough: without this the prospect interrupts, our bridge stops sending, and
 * Twilio keeps playing several hundred milliseconds of a sentence they are
 * talking over.
 */
export function clearFrame(streamSid) {
  return JSON.stringify({ event: 'clear', streamSid });
}
