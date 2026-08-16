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
import { unwrapFor } from '../../../shared/wav.js';

const PORT = Number(process.env.PORT || 8080);
const SAMPLE_RATE = 16000;

/**
 * Drop a RIFF header so what reaches the socket is samples.
 *
 * Scanned for the `data` chunk rather than assuming 44 bytes: a WAV with a LIST
 * or fact chunk has a longer header, and the extra bytes are then played as
 * audio — a click at the start of every phrase.
 */
// Header handling moved to shared/wav.js. The version that lived here threw
// away the format tag and the SAMPLE RATE, which are the two fields that decide
// whether the bytes will play correctly — so 24kHz audio on an 8kHz line was
// accepted silently and played three times too slow.

/** The opt-out triggers, from the flow. Ours, never the model's. */
const flow = loadFlow();
const TRIGGERS = flow.optOutTriggers.map((t) => String(t).toLowerCase());
function isOptOut(text) {
  const s = String(text).toLowerCase();
  return TRIGGERS.some((t) => s.includes(t));
}

const server = createAgentServer({
  async think(history, { lang, direction, onFirstClause }) {
    const { system, user } = turnPrompt(history, { lang, direction });
    // onFirstClause is what turns think-then-speak into think-while-speaking.
    // llm.js has streamed the opening phrase for a while and the HTTP path has
    // used it for a while; passing it here is what finally gives the STREAMING
    // path the same head start, and it was the larger half of the wait.
    const out = await generate({ system, user, json: true, onFirstClause });
    const say = typeof out?.say === 'string' ? out.say.trim() : '';
    if (!say) throw new Error('empty completion');
    return {
      say,
      end: out.end === true,
      disposition: TURN_DISPOSITIONS.includes(out.disposition) ? out.disposition : 'qualifying',
      // `_provider` is attached by the shared LLM adapter as a non-enumerable
      // field, so it never changes public API payloads. The bridge uses it only
      // for numeric, non-PII call-usage telemetry.
      provider: out._provider || 'unknown',
    };
  },

  async speak(text, lang, format, opts) {
    // THE TRANSPORT'S OWN FORMAT, asked for by name. A browser wants 16kHz
    // linear16; a phone wants 8kHz mulaw. Asking Bulbul for what the wire
    // already speaks means a call transcodes nowhere, and every conversion
    // skipped is quality kept — telephony audio starts with none to spare.
    const codec = format?.encoding === 'mulaw' ? 'mulaw' : 'linear16';
    const rate = Number(format?.sampleRate) || SAMPLE_RATE;
    // onChunk lets Sarvam's stream endpoint reach the wire AS IT GENERATES,
    // instead of after its last byte. It is only ever invoked for raw PCM or
    // mu-law — formats where a prefix of the stream is playable audio — so the
    // verification below still governs everything that is not.
    //
    // The chunks are the SAME BYTES as the buffer returned; `streamed` says
    // they have already gone out, so the bridge does not play the phrase twice.
    const out = await synth({
      text, lang, codec, sampleRate: rate,
      onChunk: typeof opts?.onChunk === 'function' ? opts.onChunk : undefined,
      // Chosen per call by whoever started it, already bounded in server.js.
      // Undefined falls through to the deployment default, so a call that
      // asks for nothing sounds exactly as it did.
      ...(opts?.voice ? { speaker: opts.voice } : {}),
      ...(opts?.pace ? { pace: opts.pace } : {}),
    });
    const buf = Buffer.from(out.audio, 'base64');
    const mime = String(out.mime || '');

    // TRUST THE MIME, NOT THE REQUEST. `codec` only reaches Sarvam's stream
    // endpoint; any other provider in the chain answers in its own format, and
    // the chain falls back silently by design. Sending those bytes on as raw
    // samples would be noise that sounds like a broken microphone rather than a
    // failed provider, so an unusable format is refused loudly instead.
    // VERIFY, DO NOT ASSUME. unwrapFor() reads the WAV header where there is
    // one and refuses anything that would play wrong on this wire — the wrong
    // codec, the wrong bit depth, stereo, or the wrong SAMPLE RATE. That last
    // one is the quiet killer: it does not sound like a failed provider, it
    // sounds like a worse agent.
    const audio = unwrapFor(buf, mime, { encoding: codec, sampleRate: rate });

    // The bridge accepts this object form in addition to a raw Buffer. It lets
    // cost telemetry attribute a fallback to the provider that actually spoke.
    return {
      audio,
      provider: out.provider || 'unknown',
      cached: out.cached === true,
      streamed: out.streamed === true,
    };
  },

  /**
   * An approved acknowledgement to say while the model is still thinking.
   *
   * Read from the flow, never generated: these are words a prospect hears, and
   * the one spoken before the model has decided anything is the one that must
   * commit to nothing. A random pick per turn because the same syllable four
   * times in a row is worse than the silence it replaces.
   *
   * Returns null when the flow has none for this language, which is the
   * correct degradation — an English "okay" dropped into a Telugu call is a
   * worse outcome than a pause.
   */
  backchannel(lang) {
    const lines = flow.backchannel?.[normalizeFlowLang(lang)] || [];
    if (!lines.length) return null;
    return lines[Math.floor(Math.random() * lines.length)];
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
