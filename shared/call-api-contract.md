# Anaga live-call API contract (shared)

The browser handles STT (SpeechRecognition) + TTS (speechSynthesis). The **brain** —
next-turn script generation and the post-call review — runs server-side via a
provider-abstracted LLM (default: Google Gemini), so no API key ever ships to the client.
If the endpoints are unavailable (no key / offline / error), the client falls back to the
on-device rule engine and a heuristic review. **Fail soft, never break the demo.**

## POST `/api/anaga/turn`
Generate Anaga's next spoken line from the conversation so far ("Syl rules" script generation).

**Request**
```json
{
  "lang": "en-IN",
  "history": [ { "role": "agent" | "user", "text": "..." } ]
}
```
- `history` is the full transcript in order; Anaga (`agent`) always speaks first.

**Response 200**
```json
{
  "say": "Anaga's next line (<= 40 words, one question at a time)",
  "end": false,
  "disposition": "qualifying" | "booked" | "callback" | "not-interested" | "opt-out" | "busy"
}
```

**Response 503** `{ "error": "llm_unavailable" }` — client switches to the local rule engine.

## POST `/api/anaga/summary`
Summarize the finished call and write the internal "is the lead interested?" comment.

**Request**
```json
{ "history": [ { "role": "agent" | "user", "text": "..." } ] }
```

**Response 200**
```json
{
  "interested": true,
  "score": 87,
  "band": "hot" | "warm" | "cool" | "cold",
  "disposition": "booked" | "callback" | "not-interested" | "opt-out" | "undecided",
  "qualification": { "purpose": "end-use", "budget": "in-range", "config": "match", "timeline": "immediate" },
  "scoring": {
    "band": "hot", "coverage": 100, "answered": 4, "of": 4, "cappedBy": null,
    "fields": [ { "id": "budget", "label": "Budget range", "bucket": "in-range", "worth": 90, "weight": 30, "points": 27, "answered": true } ],
    "explain": "87/100 (hot), 4 of 4 questions answered. …"
  },
  "summary": "2-3 sentence recap of the call",
  "nextAction": "short next step for the human closer",
  "comment": "CRM-style internal note written from our side"
}
```
- `score` is 0–100 lead intent, and **the model does not produce it**. The model only puts each
  qualification answer in one of the buckets the flow defines; the number is computed from the
  weights in `caller-agent/flows/*.flow.json` by `api/_lib/scoring.js`. Two reviews of the same
  call therefore give the same score, and `scoring.explain` says how it was reached.
- `coverage` is how much of the qualification actually got done. A 70 off four answers and a 70
  off one are not the same lead.
- `cappedBy` is set when the outcome limited the score — an opt-out scores 0 however well the
  prospect qualified beforehand.
- **Response 503** `{ "error": "llm_unavailable" }` — client renders a local heuristic review.

## GET `/api/calls/transcript`
Read back a finished call. Requires `Authorization: Bearer INTEGRATIONS_API_KEY`.

| Query | Returns |
|---|---|
| `?callId=…` | one call, including `transcript` |
| `?limit=50` | recent calls, **without** transcripts |

- Written by `POST /api/calls/outcome`; a call reported there is readable here.
- Phone numbers are masked. The link back to the person is `crmRecordId` / `sourceId`.
- `recordingRef` is an opaque `s3://` reference — audio is fetched from `/api/calls/recording`,
  which mints a short-lived signed URL and logs every playback.
- The list view omits transcripts on purpose: one request returning fifty conversations is an
  exfiltration shape, and callers arrive with a call id from the CRM note anyway.

## Rules (both endpoints)
- POST + JSON only; validate input; never echo secrets.
- LLM provider is abstracted (`LLM_PROVIDER`, default `gemini`); no vendor lock in business logic.
- Anaga must: disclose she's an AI, get consent, qualify in order (purpose → budget →
  configuration → timeline), offer a site visit, honor opt-out immediately, and never claim to
  *close* the deal — she qualifies and books; humans close.
