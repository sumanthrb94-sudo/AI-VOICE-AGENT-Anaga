# Anaga — Production IVR + WhatsApp (go-live guide)

**Goal:** you (or a sales-ops user) send a phone number to Anaga on WhatsApp →
within ~1 second Anaga places a real phone call to that lead, qualifies them in
**Telugu** (mirroring whatever language they reply in), books a site visit, and
WhatsApps the outcome back to you.

This is the operating manual for the orchestration that already ships in this
repo (`api/whatsapp/*`, `api/calls/*`, `api/voice/*`, `api/_lib/whatsapp.js`,
`api/_lib/voice-platform.js`). The code is deploy-ready; what remains is
**procuring three accounts and pasting their keys into Vercel**.

---

## 1. Architecture (why it's built this way)

```
WhatsApp (you send a number)
        │  Meta Cloud API webhook (signed)
        ▼
/api/whatsapp/webhook   ── parses number, fires the call, replies "calling now"
        │
        ▼
/api/calls/outbound  ──►  Managed voice platform (Vapi)  ──►  Exotel SIP number  ──►  the lead's phone
   (also callable                 │  runs Anaga: STT + LLM(SYL_RULES) + TTS, Telugu-first
    directly w/ a secret)         │
        ◄───────────────  /api/voice/webhook  (end-of-call report)
                                  │
                                  ▼
                        WhatsApp follow-up to you (outcome + next step)
```

**Three building blocks, each chosen to avoid hosting a 24×7 media server**
(which Vercel can't do):

| Block | Choice | Why |
|---|---|---|
| Voice agent on the line | **Vapi** (managed; swappable to Retell via `VOICE_PLATFORM`) | Runs the realtime STT↔LLM↔TTS loop and the phone media bridge for us. One REST call places an outbound call. Supports a custom system prompt (Anaga's `SYL_RULES`) and a custom first line (Telugu). |
| Phone number / PSTN in India | **Exotel** | Indian DLT/TRAI-compliant number. Connected to Vapi as a **BYO SIP trunk**, so Vapi dials *through* your Exotel number. |
| Lead intake + updates | **Meta WhatsApp Cloud API** | Official, free to start, no middleman. A signed webhook delivers your message; we reply on the same thread (inside the 24-hour window, so no template needed). Swappable to a BSP (AiSensy/Gupshup) later. |

The whole orchestration is **stateless Vercel functions** — nothing long-running
to operate. The "fraction of a second" is real: the WhatsApp→call path is a
single sub-second API call to Vapi.

---

## 2. What you must procure (you, not the code)

1. **Vapi account** → `VAPI_API_KEY`. Create/import a phone number → `VAPI_PHONE_NUMBER_ID`.
   Optionally build the assistant in the dashboard → `VAPI_ASSISTANT_ID` (recommended,
   so you can pick a Telugu-capable voice + transcriber visually).
2. **Exotel account** with a **DLT-registered outbound number** and a **SIP trunk**
   you connect to Vapi (Vapi → Phone Numbers → *Import / BYO SIP* → point at Exotel's
   SIP credentials). This number becomes `VAPI_PHONE_NUMBER_ID`.
3. **Meta WhatsApp Business** (Cloud API): a Meta Business account + a WhatsApp
   Business phone number (one **not** already on the consumer WhatsApp app). From
   the App dashboard you get `WHATSAPP_PHONE_NUMBER_ID`, a `WHATSAPP_TOKEN`
   (generate a **permanent System-User token**, not the 24-hour test token), and the
   App's `WHATSAPP_APP_SECRET`. You invent `WHATSAPP_VERIFY_TOKEN` yourself.

> You said you don't have WhatsApp yet — start with the **Meta Cloud API** directly
> (free, 1,000 service conversations/month, official). If onboarding friction is
> too high, **AiSensy** (built on the same Cloud API, ~₹999/mo) gives you a faster
> setup and the same webhook/send model; the adapter in `api/_lib/whatsapp.js` is
> isolated so switching is a small change.

---

## 3. Wire it up (Vercel env vars)

Set these in **Vercel → Project → Settings → Environment Variables** (server-side;
never in the browser). Full annotated list is in `.env.sample`.

```
# Voice platform
VOICE_PLATFORM=vapi
VAPI_API_KEY=…
VAPI_PHONE_NUMBER_ID=…            # your Exotel BYO-SIP number in Vapi
VAPI_ASSISTANT_ID=…              # optional but recommended
VOICE_WEBHOOK_URL=https://<app>/api/voice/webhook
VOICE_WEBHOOK_SECRET=$(openssl rand -hex 32)

# Trigger guard
CALL_TRIGGER_SECRET=$(openssl rand -hex 32)

# WhatsApp (Meta Cloud API)
WHATSAPP_TOKEN=…
WHATSAPP_PHONE_NUMBER_ID=…
WHATSAPP_VERIFY_TOKEN=…           # any string you choose
WHATSAPP_APP_SECRET=…
```

**If you set `VAPI_ASSISTANT_ID`,** configure the persona in Vapi: system prompt =
the contents of `SYL_RULES` (see `api/_lib/prompts.js`), first message = the Telugu
opening in `api/_lib/voice-platform.js`, a **female Telugu-capable** voice, and a
multilingual transcriber. **If you don't,** the code auto-builds that assistant
inline from those same two files (set `VOICE_TTS_*` / `VOICE_STT_*` for Telugu).

**Point Meta's webhook** at `https://<your-app>/api/whatsapp/webhook`, use your
`WHATSAPP_VERIFY_TOKEN` for the handshake, and subscribe to the **messages** field.

**Point Vapi's server URL** (end-of-call report) at
`https://<your-app>/api/voice/webhook` with `VOICE_WEBHOOK_SECRET` as the secret.

---

## 4. Try it

- **From WhatsApp:** message your business number `Ravi 9534869999`. Anaga replies
  "📞 Calling +919534869999 now…" and the phone rings within ~1s.
- **Directly (no WhatsApp):**
  ```bash
  curl -X POST https://<app>/api/calls/outbound \
    -H "Authorization: Bearer $CALL_TRIGGER_SECRET" \
    -H "Content-Type: application/json" \
    -d '{"to":"+919534869999","name":"Ravi","notify":"<your-wa-id>"}'
  ```

---

## 5. Compliance — non-negotiable for outbound calls in India

Outbound promotional/transactional voice calls are regulated (TRAI TCCCPR / DLT):

- **Consent + DLT:** only call numbers you have a lawful basis to call; register as a
  Principal Entity, register your **header/CLI** and content templates on DLT, and
  dial from a DLT-approved series. Exotel guides this onboarding.
- **DND scrubbing:** scrub against the DND/NCPR registry before dialing promotional calls.
- **AI disclosure:** Anaga's **first line discloses she's an AI** (already enforced in
  the persona/flow) — keep it.
- **Opt-out:** "don't call / remove me" (any language) ends the call and suppresses the
  number — already in `SYL_RULES`; mirror it into your CRM suppression list.
- **Recording + retention:** if you record, disclose it and store in Indian-region
  storage with a retention policy.

Treat §5 as a launch gate, not a nice-to-have. The code fails *closed*
(`CALL_TRIGGER_SECRET` required; webhooks signature-checked) but **cannot** verify
your DLT/DND posture — that's on the business.

---

## 6. Cost (rough, validate against live pricing)

- **Vapi:** ~$0.05–0.15 / min platform + the STT/LLM/TTS providers you choose.
- **Exotel:** per-minute outbound + number rental (Indian rates).
- **WhatsApp Cloud API:** service conversations have a free monthly tier; beyond that,
  per-conversation pricing.

A 2–3 min qualification call typically lands well under the value of a qualified
real-estate site visit — but meter it and cap concurrency early.

---

## 7. Swapping providers later

Everything vendor-specific is behind two files:
`api/_lib/voice-platform.js` (Vapi/Retell) and `api/_lib/whatsapp.js` (Meta/BSP).
No business logic, prompt, or endpoint changes when you switch — same boundary as
`api/_lib/llm.js`. Customers never see a vendor name; the public face stays
**Anaga by Modcon Builders**.
