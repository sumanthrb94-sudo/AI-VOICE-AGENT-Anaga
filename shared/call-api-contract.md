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
  "score": 0,
  "disposition": "booked" | "callback" | "not-interested" | "opt-out" | "undecided",
  "summary": "2-3 sentence recap of the call",
  "nextAction": "short next step for the human closer",
  "comment": "CRM-style internal note written from our side"
}
```
- `score` is 0–100 lead intent.
- **Response 503** `{ "error": "llm_unavailable" }` — client renders a local heuristic review.

## Rules (both endpoints)
- POST + JSON only; validate input; never echo secrets.
- LLM provider is abstracted (`LLM_PROVIDER`, default `gemini`); no vendor lock in business logic.
- Anaga must: disclose she's an AI, get consent, qualify in order (purpose → budget →
  configuration → timeline), offer a site visit, honor opt-out immediately, and never claim to
  *close* the deal — she qualifies and books; humans close.
