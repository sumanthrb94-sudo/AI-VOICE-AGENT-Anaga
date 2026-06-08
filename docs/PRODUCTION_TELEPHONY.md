# Anaga — Production IVR + WhatsApp (go-live guide)

**Goal:** you (or a sales-ops user) send a phone number to Anaga on WhatsApp →
within ~1 second Anaga places a real phone call to that lead, qualifies them in
**Telugu** (mirroring whatever language they reply in), books a site visit, and
WhatsApps the outcome back.

**Platform decision:** **Sarvam Samvaad** — India-native (Telugu-first STT/LLM/TTS),
**self-serve** (free credits, pay-per-use, pilot-to-production in <24h), and it
natively carries **voice + WhatsApp**. You already have a Sarvam API key from the
web demo, so you can start today. (Vapi / Retell remain wired as alternates via
`VOICE_PLATFORM` — see `api/_lib/voice-platform.js`.)

---

## 1. Two ways to run it — pick one

**Path A — all inside Samvaad (least code).** Build the Anaga agent in the Samvaad
dashboard, connect Exotel for telephony and Samvaad's native WhatsApp channel, and
drive outbound from Samvaad's own campaign/agent tools. You may not need any custom
code at all. Best if Samvaad's built-in WhatsApp intake fits your workflow.

**Path B — our thin Vercel glue triggers Samvaad (what ships in this repo).** Use
this for the *exact* "I WhatsApp you a number → you instantly call it" behaviour and
for triggering calls from your own CRM/dashboard:

```
WhatsApp (you send a number)
   → /api/whatsapp/webhook   (Meta Cloud API, X-Hub-Signature-256 verified)
   → /api/calls/outbound     (shared-secret guarded; also callable by curl/CRM)
   → Sarvam Samvaad outbound API   (agent = "Anaga", references SAMVAAD_AGENT_ID)
        → dials via your Exotel number → Anaga qualifies in Telugu
   → /api/voice/webhook      (end-of-call report) → WhatsApp the outcome back
```

Everything is **stateless Vercel functions** — nothing long-running to operate.
The "fraction of a second" is real: WhatsApp→call is a single sub-second API call.

---

## 2. What to procure

1. **Sarvam Samvaad** — sign in at **dashboard.sarvam.ai** (self-serve; reuse your
   `SARVAM_API_KEY`). Build the **Anaga** agent (see §4) and note its **agent id**
   and the **outbound-call API endpoint** from Samvaad's API docs.
2. **Exotel** — a **DLT-registered outbound number** + connectivity, connected to
   Samvaad as your telephony provider (Samvaad supports bring-your-own telephony).
   This becomes `SAMVAAD_FROM_NUMBER`.
3. **WhatsApp** — *Path A:* use Samvaad's native WhatsApp (configure in dashboard).
   *Path B:* **Meta WhatsApp Cloud API** (free to start) for the custom intake
   webhook → token + phone-number id + app secret. Swappable to a BSP (AiSensy) later.

---

## 3. Wire it up (Vercel env vars)

Set these in **Vercel → Project → Settings → Environment Variables** (server-side).
Full annotated list is in `.env.sample`.

```
# Voice platform (Samvaad)
VOICE_PLATFORM=samvaad
SARVAM_API_KEY=…                  # you already have this
SAMVAAD_AGENT_ID=…                # the Anaga agent id from the dashboard
SAMVAAD_OUTBOUND_URL=…            # copy the outbound endpoint verbatim from Samvaad's API docs
SAMVAAD_FROM_NUMBER=+91…          # your DLT-approved Exotel caller id (optional)

# Trigger guard + end-of-call webhook (Path B)
CALL_TRIGGER_SECRET=$(openssl rand -hex 32)
VOICE_WEBHOOK_SECRET=$(openssl rand -hex 32)

# WhatsApp (Path B — Meta Cloud API)
WHATSAPP_TOKEN=…
WHATSAPP_PHONE_NUMBER_ID=…
WHATSAPP_VERIFY_TOKEN=…           # any string you choose
WHATSAPP_APP_SECRET=…
```

> `SAMVAAD_OUTBOUND_URL` is read from env on purpose — I won't hardcode a guessed
> API path. Paste the exact endpoint from your Samvaad dashboard and the adapter
> in `api/_lib/voice-platform.js` (`callSamvaad`) is correct as-is. If the request
> body differs from `{ agent_id, to_number, from_number, metadata }`, that one
> function is the only place to adjust.

**Path B webhooks:** point Meta's webhook at
`https://<your-app>/api/whatsapp/webhook` (subscribe to **messages**, use your
`WHATSAPP_VERIFY_TOKEN`), and set Samvaad's end-of-call webhook to
`https://<your-app>/api/voice/webhook` with `VOICE_WEBHOOK_SECRET`.

---

## 4. Build the "Anaga" agent in Samvaad

In the Samvaad dashboard, create an agent and set:
- **Instructions / system prompt** = the contents of `SYL_RULES` (`api/_lib/prompts.js`).
- **First message** = the Telugu opening in `api/_lib/voice-platform.js` (`TELUGU_OPENING`).
- **Voice** = a **Sarvam female, Telugu-capable** voice; enable **language switching**
  so Anaga mirrors the caller (Telugu → Hindi/English).
- **Telephony** = your Exotel number. **Knowledge** = SYL Residences / Modcon facts.

The public face stays **Anaga by Modcon Builders** — no vendor names anywhere the
customer can see.

---

## 5. Try it

- **From WhatsApp (Path B):** message your business number `Ravi 9534869999`. Anaga
  replies "📞 Calling +919534869999 now…" and the phone rings within ~1s.
- **Directly (no WhatsApp):**
  ```bash
  curl -X POST https://<app>/api/calls/outbound \
    -H "Authorization: Bearer $CALL_TRIGGER_SECRET" \
    -H "Content-Type: application/json" \
    -d '{"to":"+919534869999","name":"Ravi","notify":"<your-wa-id>"}'
  ```

---

## 6. Compliance — non-negotiable for outbound calls in India

Outbound promotional/transactional voice calls are regulated (TRAI TCCCPR / DLT):

- **Consent + DLT:** only call numbers you have a lawful basis to call; register as a
  Principal Entity, register your **header/CLI** and content templates on DLT, dial
  from a DLT-approved series. Exotel guides this onboarding.
- **DND scrubbing:** scrub against the DND/NCPR registry before promotional dials.
- **AI disclosure:** Anaga's **first line discloses she's an AI** (already enforced) — keep it.
- **Opt-out:** "don't call / remove me" (any language) ends the call and suppresses the
  number — already in `SYL_RULES`; mirror it into your CRM suppression list.
- **Recording + retention:** if you record, disclose it and store in Indian-region
  storage with a retention policy.

The code fails *closed* (`CALL_TRIGGER_SECRET` required; webhooks signature-checked)
but it **cannot** verify your DLT/DND posture — that's a business launch gate.

---

## 7. Cost (validate against live pricing)

- **Sarvam Samvaad:** STT **₹30/hour**, TTS **₹15–30 / 10K chars**, translation
  **₹20 / 10K chars**, + LLM tokens. **₹1,000 free credits.** A 2–3 min Telugu
  qualification call is roughly **₹2–4** of speech — 2–3× cheaper than global voices.
- **Exotel:** per-minute outbound + number rental (Indian rates).
- **WhatsApp Cloud API (Path B):** free monthly service-conversation tier, then per-conversation.

Meter it and cap concurrency early, but a qualified site visit is worth far more
than a sub-₹10 call.

---

## 8. Swapping providers later

Everything vendor-specific sits behind two files: `api/_lib/voice-platform.js`
(Samvaad / Vapi / Retell) and `api/_lib/whatsapp.js` (Meta / BSP). No business
logic, prompt, or endpoint changes when you switch — same boundary as
`api/_lib/llm.js`.
