// api/anaga/turn.js
//
// POST /api/anaga/turn — generate Anaga's next spoken line from the transcript
// so far. Provider-abstracted via api/_lib/llm.js; prompts from _lib/prompts.js.
// See shared/call-api-contract.md for the request/response contract.
//
// Failure mode: any LLM error -> HTTP 503 { error: "llm_unavailable" } so the
// browser falls back to its on-device rule engine ("fail soft, never break the
// demo"). Bad input -> 400 (never a 500). Secrets/stack traces are never leaked.

//
// ── THIS ENDPOINT SPENDS MONEY AND IS PUBLIC ──────────────────────────────
// The browser demo calls it with no credential, so it cannot require one — but
// it was also unmetered, which means anyone (or a crawler) could bill the
// Gemini/Sarvam account one request at a time from a URL that is indexed.
// The account's quota being exhausted mid-session is exactly what an unmetered
// paid endpoint on a public URL looks like.
//
// The limiter in guard.js is a per-instance dampener, NOT a hard cap — Vercel
// scales out and each instance counts separately. It raises the cost of a naive
// loop; it does not stop a distributed one. For a real ceiling put Vercel WAF or
// Cloudflare in front, or require a key and drop the anonymous demo.

import { generate } from '../_lib/llm.js';
import { limited } from '../_lib/guard.js';
import { turnPrompt, TURN_DISPOSITIONS } from '../_lib/prompts.js';
import { LANGS, loadFlow, loadDirection, fillTemplate, normalizeFlowLang } from '../_lib/flow.js';
import { synth, ttsAvailable } from '../_lib/tts.js';
import { transcribe, sttAvailable } from '../_lib/stt.js';
import { splitForSpeech } from '../../shared/speech-split.js';

export default async function handler(req, res) {
  // GET -> the APPROVED OPENING for this direction and language.
  //
  // It is reviewed, versioned wording in caller-agent/flows — it was never a
  // thing to generate. Asking the model for it cost an LLM round trip at the
  // most latency-sensitive moment of the call, spent money on a sentence we
  // already had, and let a paraphrase of the reviewed disclosure reach a real
  // prospect. Serving it from the flow is faster, cheaper and more compliant,
  // and it lets a caller pre-synthesize the line before the call starts.
  //
  // No LLM, so no metering: this is a static read of a JSON file.
  if (req.method === 'GET') {
    const lang = normalizeFlowLang(req.query?.lang);
    const flow = loadFlow();

    // ?backchannel=1 — the acknowledgements, rendered, in ONE request.
    //
    // The caller used to fetch these one at a time from /api/tts, which put
    // four requests per call into a bucket capped at sixty. That is fine for
    // one person on one line and wrong behind a carrier NAT, where several
    // prospects share an address and the fourth one gets rate limited into
    // silence. They are the same handful of strings for every call ever made,
    // so they are rendered together and served together; the synth cache means
    // everybody after the first gets them without touching a vendor.
    //
    // Metered, unlike the plain opening: that one is a static read of a JSON
    // file, this one can spend money.
    if (String(req.query?.backchannel || '') === '1') {
      if (limited(req, res, { bucket: 'backchannel', limit: Number(process.env.RATE_LIMIT_BACKCHANNEL || 20) })) return;
      const lines = flow.backchannel[lang] || [];
      const rendered = (await Promise.all(lines.map(async (text) => {
        // Never throws: she simply stays quiet through the gap, which is the
        // behaviour this feature replaced, not a new failure.
        try {
          const out = await synth({ text, lang, timeoutMs: Number(process.env.BACKCHANNEL_TIMEOUT_MS || 6000) });
          return { text, audio: out.audio, mime: out.mime };
        } catch { return null; }
      }))).filter(Boolean);
      return res.status(200).json({ lang, lines: rendered });
    }
    const dir = loadDirection(req.query?.direction, flow);
    const greet = dir.greet?.[lang] || dir.greet?.['en-IN'] || '';
    const say = fillTemplate(greet, flow);
    return res.status(200).json({
      say,
      ...(String(req.query?.voice || '') === '1' ? { speak: await firstPhrase(say, lang) } : {}),
      end: false,
      disposition: 'qualifying',
      lang,
      direction: dir.id,
      // WHAT SHE SAYS WHILE SHE IS THINKING. Served rather than hardcoded in
      // the browser for the same reason the greeting is: these are words a
      // prospect hears, so they are versioned flow data. The caller renders and
      // caches them itself — they are the same four strings on every call, so
      // synthesizing them here would put four vendor round trips in front of
      // the one line that has to be fast.
      backchannel: flow.backchannel[lang] || [],
      source: 'flow',                 // NOT a generation — say so
      flow: { id: flow.id, version: flow.version },
    });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  // Metered before any paid provider is touched.
  if (limited(req, res, { bucket: 'anaga_turn', limit: Number(process.env.RATE_LIMIT_TURN || 30) })) return;

  // Parse body robustly: Vercel may hand us a parsed object or a raw string.
  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = body.length ? JSON.parse(body) : {};
    } catch {
      return res.status(400).json({ error: 'invalid_json' });
    }
  }
  if (body == null || typeof body !== 'object') {
    return res.status(400).json({ error: 'invalid_body' });
  }

  // ── AUDIO IN ────────────────────────────────────────────────────────────
  // The browser can send the prospect's utterance instead of its transcript,
  // and get back the transcript, the reply AND the reply's first phrase as
  // audio — one request for the whole turn.
  //
  // This is what lets the browser stop using the Web Speech API, which cannot
  // do echo cancellation and so transcribed Anaga's own voice off the speaker
  // and answered it. Capturing through getUserMedia with echoCancellation
  // removes her audio BEFORE anything sees it; that stream has to be sent
  // somewhere to become words, and this is where.
  // WHERE THE TURN GOES. Three vendor calls run in series and only one of them
  // was timed, so "she is slow" could not be pointed at anything. Every leg is
  // measured now and logged together at the end — a per-leg number is the only
  // way to tell a slow model from a slow region from a long first phrase.
  const turnStart = Date.now();
  let sttMs = 0, llmMs = 0, ttsMs = 0;

  let heard = null;
  if (typeof body.audio === 'string' && body.audio.length) {
    if (!sttAvailable()) return res.status(503).json({ error: 'stt_unavailable' });
    try {
      const audio = Buffer.from(body.audio, 'base64');
      // DON'T PAY TO TRANSCRIBE A DOOR CLOSING — but measure the right thing.
      //
      // This floor was on BYTE LENGTH, and byte length is not duration. Opus
      // with DTX encodes near-silence to almost nothing, so a long quiet clip
      // is small and a short loud one is large: the floor measured how much
      // SOUND there was, not how long somebody spoke. A 400 ms "అవును" — the
      // single most consequential word in a qualifying call — lands under a
      // kilobyte and was being dropped without ever reaching Saaras.
      //
      // Duration is what the endpointer actually measured (web/assets/mic.js
      // MIN_SPEECH_MS), so that is what this checks. The byte check stays only
      // as "is this a container at all", which is a header's worth.
      const spokenMs = Number(body.ms);
      const tooShort = (Number.isFinite(spokenMs) && spokenMs > 0
          && spokenMs < Number(process.env.STT_MIN_MS || 300))
        || audio.length < Number(process.env.STT_MIN_BYTES || 256);
      if (tooShort) {
        return res.status(200).json({ heard: '', say: null, ignored: 'too_short' });
      }
      const t0 = Date.now();
      const out = await transcribe({ audio, mime: body.mime, lang: body.lang });
      sttMs = Date.now() - t0;
      heard = out.text;
      console.log(JSON.stringify({
        event: 'stt_ok', provider: out.provider, chars: heard.length,
        bytes: audio.length, detected: out.lang, ms: sttMs,
        // Bytes per second of speech. The recorder's bitrate is the upload cost
        // on a mobile uplink and nobody was watching it.
        kbps: body.ms ? Math.round((audio.length * 8) / Number(body.ms)) : undefined,
      }));
    } catch (err) {
      console.error(JSON.stringify({
        event: 'stt_failed',
        reason: String(err?.message || 'stt_error'),
        detail: err?.detail ? String(err.detail).slice(0, 400) : undefined,
      }));
      return res.status(503).json({ error: 'stt_unavailable' });
    }
    // Nothing intelligible. Say so rather than answering an empty string —
    // the model will happily invent a reply to silence.
    if (!heard) return res.status(200).json({ heard: '', say: null, ignored: 'no_speech' });
  }

  const history = body.history;
  // AN EMPTY HISTORY IS THE OPENING TURN, not a bad request.
  //
  // This used to 400, which meant Anaga could not speak first — on an outbound
  // call, the one thing she must do. Every caller had to invent her opening
  // line locally to get a non-empty array, which is exactly the hardcoded
  // script the flow files exist to replace, and the prompt in prompts.js has
  // always said "if the conversation has not started yet, produce the approved
  // opening". The guard contradicted the prompt it guarded.
  if (!Array.isArray(history)) {
    return res.status(400).json({ error: 'history_required' });
  }
  // Each turn must look like { role, text }.
  const valid = history.every(
    (t) => t && typeof t === 'object' && typeof t.text === 'string' &&
      (t.role === 'agent' || t.role === 'user')
  );
  if (!valid) {
    return res.status(400).json({ error: 'invalid_history' });
  }

  // Language and direction are DATA about the call, not free text: an unknown
  // value resolves to the safe default (English, outbound) rather than being
  // passed through to the prompt, because everything here ends up inside a
  // model instruction and the caller is anonymous.
  const lang = LANGS.includes(body.lang) ? body.lang : 'en-IN';
  const direction = body.direction === 'inbound' ? 'inbound' : 'outbound';

  // A transcribed utterance is just a user turn. The caller sends the history
  // WITHOUT it (it did not know the words yet), so it is appended here.
  const full = heard ? history.concat([{ role: 'user', text: heard }]) : history;

  const { system, user } = turnPrompt(full, { lang, direction });

  // START SPEAKING BEFORE THE MODEL HAS FINISHED THINKING.
  //
  // Synthesis needs the first few words, not the whole line, and a model
  // writing "Are you looking to live in it, or to invest?" has those words well
  // before it has the rest. Handing the opening phrase to Bulbul the moment it
  // appears overlaps the two slowest legs of the turn instead of queueing one
  // behind the other. The answer is identical either way — only the moment the
  // audio starts rendering changes.
  const wantVoice = String(req.query?.voice || '') === '1';
  let early = null, earlyText = null;

  let out;
  const llmStart = Date.now();
  try {
    out = await generate({
      system,
      user,
      json: true,
      onFirstClause: wantVoice && ttsAvailable() ? (head) => {
        earlyText = head;
        early = firstPhrase(head, lang);        // never throws — see below
      } : undefined,
    });
    llmMs = Date.now() - llmStart;
  } catch (err) {
    llmMs = Date.now() - llmStart;
    // LOG the reason. This used to be swallowed entirely, so a brain that was
    // 503-ing on every single call looked identical to one that was merely
    // unconfigured — and the only symptom was Anaga sounding like a script.
    // The message never contains the key (llm.js strips it).
    console.error(JSON.stringify({
      at: new Date().toISOString(), svc: 'anaga-api', event: 'llm_call_failed',
      endpoint: 'turn', model: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
      reason: String((err && err.message) || 'unknown'),
    }));
    // Distinguish "out of quota" from "down". The browser falls back to the
    // rule engine either way, but a founder staring at a scripted-sounding
    // Anaga deserves to know it is a billing problem, not a broken agent.
    const quota = err && (err.code === 'quota_exceeded' || /\b429\b|quota/i.test(String(err.message)));
    return res.status(503).json({
      error: 'llm_unavailable',
      reason: quota ? 'quota_exceeded' : 'upstream_error',
    });
  }

  if (out == null || typeof out !== 'object') {
    return res.status(503).json({ error: 'llm_unavailable' });
  }

  // Coerce / validate fields against the contract.
  const say = typeof out.say === 'string' ? out.say.trim() : '';
  if (!say) {
    return res.status(503).json({ error: 'llm_unavailable' });
  }
  const end = out.end === true;
  const disposition = TURN_DISPOSITIONS.includes(out.disposition)
    ? out.disposition
    : 'qualifying';

  // ONE ROUND TRIP, NOT TWO. The browser used to answer the turn, then make a
  // second request from the phone to synthesize it — a whole extra
  // handset-to-server hop on a mobile network, after the slowest part of the
  // call had already finished. Rendering the first phrase here starts it the
  // instant the model answers, and ships it in the reply that was going out
  // anyway. ?voice=1 so a caller that does its own audio is unaffected.
  const ttsStart = Date.now();
  // THE EARLY GUESS ONLY COUNTS IF IT MATCHES. The browser splits the full line
  // itself and renders phrases 1..n, so a head it does not agree with would
  // repeat or drop a phrase. Checked against the real splitter; a mismatch just
  // costs the head start, never the audio.
  const wanted = wantVoice ? splitForSpeech(say)[0] : null;
  let speak = null;
  if (wantVoice) {
    speak = (early && earlyText === wanted) ? await early : await firstPhrase(say, lang);
    if (early && earlyText !== wanted) {
      // Worth knowing about: it means the early scan and the splitter disagree,
      // and every turn is paying full LLM-then-TTS latency while looking fine.
      console.warn(JSON.stringify({
        event: 'early_phrase_missed', guessed: earlyText, wanted,
      }));
    }
  }
  ttsMs = Date.now() - ttsStart;

  // THE BUDGET, per leg, on every turn. Server time only — the endpointer's
  // silence window and the two network hops to the handset sit outside this and
  // are the rest of what the prospect actually waits through.
  console.log(JSON.stringify({
    event: 'turn_ok', region: process.env.VERCEL_REGION || 'unknown',
    sttMs, llmMs, ttsMs, totalMs: Date.now() - turnStart,
    // The first phrase is the only thing on the critical path; synthesis time
    // tracks its LENGTH almost linearly, so the number to watch is this one.
    firstPhraseChars: speak?.text?.length, sayChars: say.length,
  }));

  return res.status(200).json({
    say, end, disposition, lang, direction,
    ...(heard !== null ? { heard } : {}),
    ...(speak ? { speak } : {}),
  });
}

/**
 * Render just the FIRST phrase. The rest is synthesized by the caller while
 * this one plays — prerendering the whole line here would hold the response
 * open for the slowest part of it and save nothing after the first word.
 *
 * Never throws: audio is an optimisation, and a turn that arrives without it
 * is a turn the caller can still speak and still show.
 */
async function firstPhrase(text, lang) {
  if (!ttsAvailable()) return null;
  try {
    const first = splitForSpeech(text)[0];
    if (!first) return null;
    // A PERSON IS WAITING ON THIS ONE. Past ~4s the fallback voice, arriving
    // now, beats the good voice arriving eventually — and beyond that the whole
    // turn risks the function's own 30s limit.
    const out = await synth({
      text: first, lang, timeoutMs: Number(process.env.FIRST_PHRASE_TIMEOUT_MS || 4500),
    });

    // A FALLBACK IS NOT A SUCCESS, AND THIS PATH WAS THE ONE THAT NEVER SAID SO.
    //
    // synth() attaches `fellBackFrom` when the chain's first choice failed, and
    // /api/tts logs it at ERROR — but that endpoint is barely used. THIS is the
    // path every ?voice=1 turn takes, and it discarded the field entirely, with
    // a bare `catch { return null; }` below that logged nothing at all.
    //
    // So an expired or throttled Sarvam key produced: a 200, the free Google
    // Translate voice, and zero log lines. Anaga's voice quietly changed in
    // production and the only symptom was somebody saying she sounded off.
    // stt.js and llm.js both log their fallbacks; this now matches them.
    if (out.fellBackFrom) {
      console.error(JSON.stringify({
        at: new Date().toISOString(), svc: 'anaga-api', event: 'tts_fell_back',
        severity: 'high', endpoint: 'turn', lang,
        from: out.fellBackFrom, served: out.provider || 'unknown', voice: out.voice,
      }));
    }
    return {
      text: first, audio: out.audio, mime: out.mime, voice: out.voice, ms: out.ms,
      // Carried to the client so the call screen can report the voice that
      // ACTUALLY spoke, rather than the providers that merely have env vars set.
      provider: out.provider || null,
      fellBackFrom: out.fellBackFrom || null,
    };
  } catch (err) {
    // Was `catch { return null; }`. Silence here meant a voice that never
    // rendered looked identical to a turn that did not ask for one.
    console.error(JSON.stringify({
      at: new Date().toISOString(), svc: 'anaga-api', event: 'first_phrase_failed',
      endpoint: 'turn', lang, reason: String(err?.message || 'unknown'),
    }));
    return null;
  }
}
