// shared/call-usage.js
//
// Provider-neutral, non-PII call metering. This answers three operational
// questions after every call without logging audio or transcript content:
//
//   1. Which provider actually served each stage?
//   2. How many vendor-billable units did that stage consume?
//   3. What is the current estimated call cost using rates the deployment owner
//      explicitly configured?
//
// Do NOT hard-code public price sheets here. Vendor prices, commitments, taxes,
// and foreign-exchange rates change. An omitted rate yields an "unpriced" unit,
// which is safer than a fabricated INR total.

const finite = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

const rounded = (value, places = 6) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const factor = 10 ** places;
  return Math.round(n * factor) / factor;
};

const providerKey = (provider) => String(provider || 'unknown')
  .trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_');

function rate(env, stage, provider, unit) {
  const value = env[`CALL_COST_${stage}_${providerKey(provider)}_PER_${unit}`];
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function bucket(map, provider) {
  const key = String(provider || 'unknown').trim().toLowerCase() || 'unknown';
  if (!map[key]) map[key] = { provider: key, audioMs: 0, chars: 0, inputChars: 0, outputChars: 0, turns: 0, cacheHits: 0 };
  return map[key];
}

/**
 * Convert a raw audio frame to milliseconds without decoding or retaining it.
 * linear16 is 16-bit PCM; common phone codecs are one byte per sample.
 */
export function audioDurationMs(bytes, { sampleRate = 16000, encoding = 'linear16', channels = 1 } = {}) {
  const size = finite(bytes);
  const rateHz = finite(sampleRate);
  const channelCount = Math.max(1, finite(channels, 1));
  if (!size || !rateHz) return 0;
  const normalized = String(encoding || 'linear16').toLowerCase();
  const bytesPerSample = /^(mulaw|ulaw|pcmu|alaw|pcma)$/.test(normalized) ? 1 : 2;
  return (size / (rateHz * bytesPerSample * channelCount)) * 1000;
}

/**
 * Build one call-scoped ledger. It remains in memory for a single live call;
 * callers may emit its safe numeric snapshot to logs, a queue, or the outcome
 * endpoint. It never holds audio, phone numbers, prompts, or transcript text.
 */
export function createCallUsageLedger({ env = process.env, now = () => Date.now() } = {}) {
  const startedAtMs = now();
  const stages = { stt: {}, tts: {}, llm: {} };
  let closedAtMs = null;

  function recordSTT({ provider, audioMs, cached = false } = {}) {
    const row = bucket(stages.stt, provider);
    row.audioMs += finite(audioMs);
    row.turns++;
    if (cached) row.cacheHits++;
  }

  function recordTTS({ provider, chars, audioMs, cached = false } = {}) {
    const row = bucket(stages.tts, provider);
    row.chars += finite(chars);
    row.audioMs += finite(audioMs);
    row.turns++;
    if (cached) row.cacheHits++;
  }

  function recordLLM({ provider, inputChars, outputChars } = {}) {
    const row = bucket(stages.llm, provider);
    row.inputChars += finite(inputChars);
    row.outputChars += finite(outputChars);
    row.turns++;
  }

  function pricedRows(stage, rows) {
    const output = [];
    for (const row of Object.values(rows)) {
      let unit = null;
      let quantity = 0;
      if (stage === 'STT') { unit = 'MINUTE'; quantity = row.audioMs / 60000; }
      if (stage === 'TTS') { unit = '1K_CHARS'; quantity = row.chars / 1000; }
      if (stage === 'LLM') {
        // Character counts are deliberately a fallback estimate. Replace this
        // with vendor-reported token usage when an adapter exposes it.
        unit = '1K_CHARS'; quantity = (row.inputChars + row.outputChars) / 1000;
      }
      const configuredRate = rate(env, stage, row.provider, unit);
      output.push({
        ...row,
        audioMs: rounded(row.audioMs, 3),
        billableUnits: rounded(quantity),
        unit,
        ratePerUnit: configuredRate,
        estimatedCost: configuredRate === null ? null : rounded(quantity * configuredRate),
      });
    }
    return output;
  }

  function snapshot({ endedAtMs = closedAtMs || now() } = {}) {
    const stt = pricedRows('STT', stages.stt);
    const tts = pricedRows('TTS', stages.tts);
    const llm = pricedRows('LLM', stages.llm);
    const durationMs = Math.max(0, finite(endedAtMs) - startedAtMs);
    const telephonyMinutes = durationMs / 60000;
    const telephonyRate = rate(env, 'TELEPHONY', 'OUTBOUND', 'MINUTE');
    const telephony = {
      durationMs: rounded(durationMs, 3),
      billableUnits: rounded(telephonyMinutes),
      unit: 'MINUTE',
      ratePerUnit: telephonyRate,
      estimatedCost: telephonyRate === null ? null : rounded(telephonyMinutes * telephonyRate),
    };
    const rows = [...stt, ...tts, ...llm, telephony];
    const priced = rows.filter((row) => row.estimatedCost !== null);
    const unpriced = rows.filter((row) => row.estimatedCost === null && row.billableUnits > 0)
      .map((row) => `${row.provider || 'outbound'}:${row.unit}`);

    return {
      version: 1,
      currency: String(env.CALL_COST_CURRENCY || 'INR').toUpperCase(),
      durationMs: rounded(durationMs, 3),
      stages: { stt, tts, llm, telephony },
      estimate: {
        amount: rounded(priced.reduce((sum, row) => sum + row.estimatedCost, 0)),
        complete: unpriced.length === 0,
        unpriced,
      },
    };
  }

  function close(at = now()) {
    if (closedAtMs === null) closedAtMs = finite(at, now());
    return snapshot({ endedAtMs: closedAtMs });
  }

  return { recordSTT, recordTTS, recordLLM, snapshot, close };
}

/**
 * A public-health-safe configuration status. Rates themselves are commercial
 * inputs, so readiness exposes only their presence, never their values.
 */
export function callUsageStatus({ env = process.env } = {}) {
  const keys = [
    'CALL_COST_STT_SARVAM_PER_MINUTE',
    'CALL_COST_STT_DEEPGRAM_PER_MINUTE',
    'CALL_COST_TTS_SARVAM_PER_1K_CHARS',
    'CALL_COST_TTS_GOOGLE_PER_1K_CHARS',
    'CALL_COST_TTS_INDICF5_PER_1K_CHARS',
    'CALL_COST_LLM_SARVAM_PER_1K_CHARS',
    'CALL_COST_LLM_GEMINI_PER_1K_CHARS',
    'CALL_COST_TELEPHONY_OUTBOUND_PER_MINUTE',
  ];
  const configured = keys.filter((key) => Number.isFinite(Number(env[key])) && String(env[key]).trim() !== '');
  return {
    currency: String(env.CALL_COST_CURRENCY || 'INR').toUpperCase(),
    configuredRates: configured,
    missingRates: keys.filter((key) => !configured.includes(key)),
    complete: configured.length === keys.length,
  };
}

/** A safe shape for accepting call usage from a remote caller-agent. */
export function sanitizeCallUsage(value) {
  if (!value || typeof value !== 'object') return null;
  const stages = value.stages && typeof value.stages === 'object' ? value.stages : {};
  const safeRows = (rows, fields) => Array.isArray(rows)
    ? rows.slice(0, 12).map((row) => {
      const out = { provider: String(row?.provider || 'unknown').slice(0, 48) };
      for (const field of fields) out[field] = finite(row?.[field]);
      if (typeof row?.unit === 'string') out.unit = row.unit.slice(0, 24);
      if (row?.ratePerUnit === null || Number.isFinite(Number(row?.ratePerUnit))) out.ratePerUnit = row.ratePerUnit === null ? null : finite(row.ratePerUnit);
      if (row?.estimatedCost === null || Number.isFinite(Number(row?.estimatedCost))) out.estimatedCost = row.estimatedCost === null ? null : finite(row.estimatedCost);
      return out;
    }) : [];

  const telephony = stages.telephony && typeof stages.telephony === 'object'
    ? {
      durationMs: finite(stages.telephony.durationMs),
      billableUnits: finite(stages.telephony.billableUnits),
      unit: String(stages.telephony.unit || 'MINUTE').slice(0, 24),
      ratePerUnit: stages.telephony.ratePerUnit === null ? null : finite(stages.telephony.ratePerUnit),
      estimatedCost: stages.telephony.estimatedCost === null ? null : finite(stages.telephony.estimatedCost),
    }
    : null;

  return {
    version: finite(value.version, 1),
    currency: String(value.currency || 'INR').toUpperCase().slice(0, 8),
    durationMs: finite(value.durationMs),
    stages: {
      stt: safeRows(stages.stt, ['audioMs', 'turns', 'cacheHits', 'billableUnits']),
      tts: safeRows(stages.tts, ['audioMs', 'chars', 'turns', 'cacheHits', 'billableUnits']),
      llm: safeRows(stages.llm, ['inputChars', 'outputChars', 'turns', 'billableUnits']),
      telephony,
    },
    estimate: {
      amount: value.estimate?.amount === null ? null : finite(value.estimate?.amount),
      complete: value.estimate?.complete === true,
      unpriced: Array.isArray(value.estimate?.unpriced)
        ? value.estimate.unpriced.slice(0, 24).map((item) => String(item).slice(0, 72))
        : [],
    },
  };
}
