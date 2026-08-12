// caller-agent/src/agent/main.js
//
// The live-call service. This is the Cloud Run entry point.
//
//   PORT=8080 node --experimental-detect-module caller-agent/src/agent/main.js
//
// It wires the transport-agnostic bridge to the SAME brain, voice and flow the
// HTTP path uses — api/_lib/* are plain ES modules with nothing Vercel-specific
// in them, which is why they can be imported here rather than duplicated. Two
// copies of a qualification prompt drift, and the one that drifts is the one
// nobody is reading.
//
// Deployed to asia-south1 so it sits beside Sarvam and Deepgram; see
// docs/ARCHITECTURE.md. The Vercel functions keep the webhook, CRM, console and
// health surface — only the call leg lives here.

import { createAgentServer } from './server.js';
import { generate } from '../../../api/_lib/llm.js';
import { synth } from '../../../api/_lib/tts.js';
import { turnPrompt, TURN_DISPOSITIONS } from '../../../api/_lib/prompts.js';
import { loadFlow, loadDirection, fillTemplate, normalizeFlowLang } from '../../../api/_lib/flow.js';

const PORT = Number(process.env.PORT || 8080);
const SAMPLE_RATE = 16000;

/**
 * Drop a RIFF header so what reaches the socket is samples.
 *
 * Scanned for the `data` chunk rather than assuming 44 bytes: a WAV with a LIST
 * or fact chunk has a longer header, and the extra bytes are then played as
 * audio — a click at the start of every phrase.
 */
function stripWavHeader(buf) {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF') return buf;
  let at = 12;
  while (at + 8 <= buf.length) {
    const id = buf.toString('ascii', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    if (id === 'data') return buf.subarray(at + 8, Math.min(buf.length, at + 8 + size));
    at += 8 + size + (size % 2);
  }
  return buf;
}

/** The opt-out triggers, from the flow. Ours, never the model's. */
const flow = loadFlow();
const TRIGGERS = flow.optOutTriggers.map((t) => String(t).toLowerCase());
function isOptOut(text) {
  const s = String(text).toLowerCase();
  return TRIGGERS.some((t) => s.includes(t));
}

const server = createAgentServer({
  async think(history, { lang, direction }) {
    const { system, user } = turnPrompt(history, { lang, direction });
    const out = await generate({ system, user, json: true });
    const say = typeof out?.say === 'string' ? out.say.trim() : '';
    if (!say) throw new Error('empty completion');
    return {
      say,
      end: out.end === true,
      disposition: TURN_DISPOSITIONS.includes(out.disposition) ? out.disposition : 'qualifying',
    };
  },

  async speak(text, lang, format) {
    // THE TRANSPORT'S OWN FORMAT, asked for by name. A browser wants 16kHz
    // linear16; a phone wants 8kHz mulaw. Asking Bulbul for what the wire
    // already speaks means a call transcodes nowhere, and every conversion
    // skipped is quality kept — telephony audio starts with none to spare.
    const codec = format?.encoding === 'mulaw' ? 'mulaw' : 'linear16';
    const rate = Number(format?.sampleRate) || SAMPLE_RATE;
    const out = await synth({ text, lang, codec, sampleRate: rate });
    const buf = Buffer.from(out.audio, 'base64');
    const mime = String(out.mime || '');

    // TRUST THE MIME, NOT THE REQUEST. `codec` only reaches Sarvam's stream
    // endpoint; any other provider in the chain answers in its own format, and
    // the chain falls back silently by design. Sending those bytes on as raw
    // samples would be noise that sounds like a broken microphone rather than a
    // failed provider, so an unusable format is refused loudly instead.
    if (codec === 'mulaw') {
      if (/mulaw|ulaw|pcmu|basic/.test(mime)) return buf;
      throw new Error(`voice returned ${mime || 'an unknown format'}, which is not mulaw`);
    }
    if (/wav/.test(mime)) return stripWavHeader(buf);
    if (/l16|linear16|pcm|octet-stream/.test(mime)) return buf;
    throw new Error(`voice returned ${mime || 'an unknown format'}, which is not PCM`);
  },

  async greeting(lang, direction) {
    // APPROVED WORDING, read from the flow. Never a generation: it is the
    // sentence that makes the call legal, and it is also the most
    // latency-sensitive moment of the call.
    const l = normalizeFlowLang(lang);
    const dir = loadDirection(direction, flow);
    return fillTemplate(dir.greet?.[l] || dir.greet?.['en-IN'] || '', flow);
  },

  isOptOut,
});

server.listen(PORT, () => {
  console.log(JSON.stringify({
    event: 'agent_listening', port: PORT,
    region: process.env.CLOUD_RUN_REGION || process.env.REGION || 'unknown',
    stt: Boolean(process.env.DEEPGRAM_API_KEY),
    flow: { id: flow.id, version: flow.version },
  }));
});
