// api/_lib/voice-platform.js
//
// Outbound-call adapter for the managed voice platform that runs Anaga on a REAL
// phone line (PSTN via an Exotel "bring-your-own" SIP number). Default provider is
// Vapi; swappable to Retell with VOICE_PLATFORM=retell. Business logic only ever
// calls triggerOutboundCall() and never knows which platform answered — the same
// provider-abstraction boundary as api/_lib/llm.js ("no vendor in business logic").
//
// ONE source of truth for the persona: SYL_RULES from api/_lib/prompts.js becomes
// the phone assistant's system prompt, and Anaga ALWAYS opens in Telugu, then
// mirrors the caller. Prefer configuring the assistant in the platform dashboard
// (set VAPI_ASSISTANT_ID) so you can pick a Telugu-capable voice/transcriber
// visually; the inline assistant below is a zero-config bootstrap so a call works
// the moment the keys are set.
//
// No npm deps: global fetch (Node 18+).

import { SYL_RULES } from './prompts.js';

// Anaga's opening line — ALWAYS Telugu (then she mirrors the caller). Mirrors
// caller-agent/flows/real-estate-qualify.flow.json (greet) and anaga.persona.json.
export const TELUGU_OPENING =
  'నమస్కారం! నేను అనగ, మోడ్‌కాన్ బిల్డర్స్ నుండి AI వాయిస్ అసిస్టెంట్. ' +
  'తుక్కుగూడలోని మా SYL రెసిడెన్సెస్ గురించి మాట్లాడటానికి కాల్ చేస్తున్నాను. ' +
  'ఇది AI వాయిస్ కాల్ అని తెలియజేస్తున్నాను. మీకు ఒక నిమిషం సమయం ఉందా?';

export function voicePlatform() {
  return (process.env.VOICE_PLATFORM || 'vapi').toLowerCase();
}

export function voicePlatformConfigured() {
  switch (voicePlatform()) {
    case 'vapi':   return !!(process.env.VAPI_API_KEY && process.env.VAPI_PHONE_NUMBER_ID);
    case 'retell': return !!(process.env.RETELL_API_KEY && process.env.RETELL_FROM_NUMBER);
    default:       return false;
  }
}

/**
 * Place an outbound call to `to` (E.164). `metadata` is round-tripped to the
 * end-of-call webhook so the result can be attributed (e.g. who to WhatsApp back).
 * Returns { ok, id, raw }. Throws on misconfig / upstream failure.
 */
export async function triggerOutboundCall({ to, metadata = {} } = {}) {
  if (!to) throw new Error('missing_to');
  switch (voicePlatform()) {
    case 'vapi':   return callVapi({ to, metadata });
    case 'retell': return callRetell({ to, metadata });
    default:       throw new Error('unsupported_voice_platform');
  }
}

// ---- Vapi (https://docs.vapi.ai) — verify fields against current docs --------
async function callVapi({ to, metadata }) {
  const apiKey = process.env.VAPI_API_KEY;
  const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID; // Exotel BYO-SIP number registered in Vapi
  if (!apiKey || !phoneNumberId) throw new Error('vapi_not_configured');

  const payload = { phoneNumberId, customer: { number: to }, metadata };
  // Prefer a dashboard-configured assistant; else send an inline bootstrap.
  if (process.env.VAPI_ASSISTANT_ID) payload.assistantId = process.env.VAPI_ASSISTANT_ID;
  else payload.assistant = buildVapiAssistant();

  const data = await postJSON('https://api.vapi.ai/call', apiKey, payload);
  return { ok: true, id: (data && data.id) || '', raw: data };
}

// Zero-config Anaga assistant (used only when VAPI_ASSISTANT_ID is unset).
// Provider / model / voice are env-driven; the defaults are conservative — VERIFY
// the ids against current Vapi docs and make sure the matching provider keys are
// set in your Vapi dashboard. For best Telugu quality, set a Telugu-capable
// transcriber + voice (e.g. Sarvam) via the VOICE_* envs or the dashboard.
function buildVapiAssistant() {
  const assistant = {
    firstMessage: TELUGU_OPENING,
    model: {
      provider: process.env.VOICE_LLM_PROVIDER || 'google',
      model: process.env.VOICE_LLM_MODEL || 'gemini-2.0-flash',
      messages: [{ role: 'system', content: SYL_RULES }],
    },
  };
  if (process.env.VOICE_TTS_PROVIDER && process.env.VOICE_TTS_VOICE_ID) {
    assistant.voice = {
      provider: process.env.VOICE_TTS_PROVIDER,
      voiceId: process.env.VOICE_TTS_VOICE_ID,
    };
  }
  if (process.env.VOICE_STT_PROVIDER) {
    assistant.transcriber = { provider: process.env.VOICE_STT_PROVIDER };
    if (process.env.VOICE_STT_LANGUAGE) assistant.transcriber.language = process.env.VOICE_STT_LANGUAGE;
  }
  // Surface our webhook secret to Vapi so the end-of-call report is authenticated.
  if (process.env.VOICE_WEBHOOK_URL) {
    assistant.server = { url: process.env.VOICE_WEBHOOK_URL };
    if (process.env.VOICE_WEBHOOK_SECRET) assistant.server.secret = process.env.VOICE_WEBHOOK_SECRET;
  }
  return assistant;
}

// ---- Retell (https://docs.retellai.com) — verify fields against current docs -
async function callRetell({ to, metadata }) {
  const apiKey = process.env.RETELL_API_KEY;
  const fromNumber = process.env.RETELL_FROM_NUMBER;
  if (!apiKey || !fromNumber) throw new Error('retell_not_configured');

  const payload = { from_number: fromNumber, to_number: to, metadata };
  if (process.env.RETELL_AGENT_ID) payload.override_agent_id = process.env.RETELL_AGENT_ID;

  const data = await postJSON('https://api.retellai.com/v2/create-phone-call', apiKey, payload);
  return { ok: true, id: (data && data.call_id) || '', raw: data };
}

async function postJSON(url, bearer, payload) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
  } catch (err) {
    throw new Error(`voice_platform_request_failed: ${err && err.name === 'AbortError' ? 'timeout' : 'network'}`);
  } finally { clearTimeout(t); }

  if (!resp.ok) {
    let d = ''; try { d = (await resp.text()).slice(0, 300); } catch (_) {}
    throw new Error(`voice_platform_${resp.status}${d ? ': ' + d : ''}`);
  }
  return resp.json().catch(() => ({}));
}
