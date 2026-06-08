// api/_lib/voice-platform.js
//
// Outbound-call adapter for the managed voice platform that runs Anaga on a REAL
// phone line. DEFAULT provider is Sarvam Samvaad — India-native (Telugu-first
// STT/LLM/TTS), self-serve, and it natively carries voice + WhatsApp; Vapi and
// Retell remain available via VOICE_PLATFORM. Business logic only ever calls
// triggerOutboundCall() and never knows which platform answered — the same
// provider-abstraction boundary as api/_lib/llm.js ("no vendor in business logic").
//
// ONE source of truth for the persona: SYL_RULES from api/_lib/prompts.js. For
// Samvaad you paste SYL_RULES + the Telugu opening into the agent you build in
// the Samvaad dashboard (the call references it by SAMVAAD_AGENT_ID). For Vapi,
// SYL_RULES is sent inline (or set VAPI_ASSISTANT_ID). Anaga ALWAYS opens in
// Telugu, then mirrors the caller.
//
// No npm deps: global fetch (Node 18+).

import { rulesFor } from './prompts.js';

// Anaga's opening lines — ALWAYS Telugu (then she mirrors the caller). Mirror
// caller-agent/flows/*.flow.json and anaga.persona.json. OUTBOUND = we called the
// lead; INBOUND = the customer called Modcon and Anaga answers as a receptionist.
export const TELUGU_OPENING =
  'నమస్కారం! నేను అనగ, మోడ్‌కాన్ బిల్డర్స్ నుండి AI వాయిస్ అసిస్టెంట్. ' +
  'తుక్కుగూడలోని మా SYL రెసిడెన్సెస్ గురించి మాట్లాడటానికి కాల్ చేస్తున్నాను. ' +
  'ఇది AI వాయిస్ కాల్ అని తెలియజేస్తున్నాను. మీకు ఒక నిమిషం సమయం ఉందా?';

export const TELUGU_INBOUND_OPENING =
  'నమస్కారం! మీరు మోడ్‌కాన్ బిల్డర్స్‌కి కాల్ చేశారు. నేను అనగ, ఒక AI అసిస్టెంట్‌ని. ' +
  'నేను మీకు ఎలా సహాయం చేయగలను?';

// The opening line for a direction.
function openingFor(direction) {
  return direction === 'inbound' ? TELUGU_INBOUND_OPENING : TELUGU_OPENING;
}

export function voicePlatform() {
  return (process.env.VOICE_PLATFORM || 'samvaad').toLowerCase();
}

export function voicePlatformConfigured() {
  switch (voicePlatform()) {
    case 'samvaad': return !!(process.env.SARVAM_API_KEY && process.env.SAMVAAD_OUTBOUND_URL && process.env.SAMVAAD_AGENT_ID);
    case 'vapi':    return !!(process.env.VAPI_API_KEY && process.env.VAPI_PHONE_NUMBER_ID);
    case 'retell':  return !!(process.env.RETELL_API_KEY && process.env.RETELL_FROM_NUMBER);
    default:        return false;
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
    case 'samvaad': return callSamvaad({ to, metadata });
    case 'vapi':    return callVapi({ to, metadata });
    case 'retell':  return callRetell({ to, metadata });
    default:        throw new Error('unsupported_voice_platform');
  }
}

// ---- Sarvam Samvaad (https://docs.sarvam.ai) — India-native, self-serve ------
// Samvaad is a dashboard platform: you BUILD the Anaga agent there (paste
// SYL_RULES as the instructions + the Telugu TELUGU_OPENING as the first line,
// pick a Sarvam Telugu FEMALE voice, enable language-switching, connect your
// telephony e.g. Exotel and/or WhatsApp). The call then references that agent by
// SAMVAAD_AGENT_ID. Sarvam's auth header is `api-subscription-key`. The exact
// outbound endpoint + body live in YOUR Samvaad dashboard's API docs, so the URL
// is taken from env (SAMVAAD_OUTBOUND_URL) — nothing here is a guessed path.
async function callSamvaad({ to, metadata }) {
  const apiKey = process.env.SARVAM_API_KEY;
  const url = process.env.SAMVAAD_OUTBOUND_URL;   // from dashboard.sarvam.ai (Samvaad → API)
  const agentId = process.env.SAMVAAD_AGENT_ID;   // the Anaga agent you built in Samvaad
  if (!apiKey || !url || !agentId) throw new Error('samvaad_not_configured');

  const payload = { agent_id: agentId, to_number: to, metadata };
  if (process.env.SAMVAAD_FROM_NUMBER) payload.from_number = process.env.SAMVAAD_FROM_NUMBER;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'api-subscription-key': apiKey, 'Content-Type': 'application/json' },
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
  const data = await resp.json().catch(() => ({}));
  return { ok: true, id: data.call_id || data.id || '', raw: data };
}

// ---- Vapi (https://docs.vapi.ai) — verify fields against current docs --------
async function callVapi({ to, metadata }) {
  const apiKey = process.env.VAPI_API_KEY;
  const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID; // Exotel BYO-SIP number registered in Vapi
  if (!apiKey || !phoneNumberId) throw new Error('vapi_not_configured');

  const payload = { phoneNumberId, customer: { number: to }, metadata };
  // Outbound dialer → the outbound agent. Prefer a dashboard-configured assistant;
  // else send an inline bootstrap. (Inbound is handled by the platform answering a
  // call; configure that agent in the dashboard with buildAssistant('inbound').)
  if (process.env.VAPI_ASSISTANT_ID) payload.assistantId = process.env.VAPI_ASSISTANT_ID;
  else payload.assistant = buildVapiAssistant('outbound');

  const data = await postJSON('https://api.vapi.ai/call', apiKey, payload);
  return { ok: true, id: (data && data.id) || '', raw: data };
}

// Zero-config Anaga assistant (used only when VAPI_ASSISTANT_ID is unset).
// Provider / model / voice are env-driven; the defaults are conservative — VERIFY
// the ids against current Vapi docs and make sure the matching provider keys are
// set in your Vapi dashboard. For best Telugu quality, set a Telugu-capable
// transcriber + voice (e.g. Sarvam) via the VOICE_* envs or the dashboard.
export function buildVapiAssistant(direction = 'outbound') {
  const assistant = {
    firstMessage: openingFor(direction),
    model: {
      provider: process.env.VOICE_LLM_PROVIDER || 'google',
      model: process.env.VOICE_LLM_MODEL || 'gemini-2.0-flash',
      messages: [{ role: 'system', content: rulesFor(direction) }],
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
