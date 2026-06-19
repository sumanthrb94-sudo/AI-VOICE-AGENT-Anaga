# Anaga — Agent Build Plan (Modcon → multi-builder)

> Derived from the "Outpero Agent Architecture" blueprint, **re-tooled for Anaga's
> reality**: a real-estate vertical, a Google + Sarvam stack (not OpenAI/Vapi/Twilio),
> and mapped to what already exists in this repo. Modcon Builders is customer #1
> and the case study; the same agents are then resold to other builders.

## The pattern (same as the blueprint)
`TRIGGER → ORCHESTRATE → AI (Gemini) → BUSINESS LOGIC → ACTION → MEMORY`
- **Realtime voice audio** lives on the voice platform (Samvaad), NOT on n8n/Vercel.
- **n8n + our Vercel `/api`** are the orchestration/control plane (trigger + post-process).

## Stack — our choices vs the blueprint's defaults
| Layer | Blueprint default | **Anaga uses** | Why |
|---|---|---|---|
| Orchestration | n8n / Make | **n8n + Vercel `/api`** | n8n = visual glue; our endpoints already do the control plane |
| AI voice (Telugu) | Vapi / Bland | **Sarvam Samvaad** | Telugu-first STT/LLM/TTS; India-native |
| Telephony | Twilio | **Exotel / Samvaad telephony**, + **WhatsApp Calling** for warm leads | Twilio is weak/pricey in India; WhatsApp calling dodges PSTN/DLT |
| WhatsApp | Wati | **Meta Cloud API / BSP (AiSensy/Interakt/Wati)** | messaging intake + follow-up (+ calling later) |
| LLM | OpenAI GPT‑4o | **Google Gemini** | founder decision: Google-only; good multilingual |
| CRM / memory | Airtable | **Google Sheet → Supabase → Zoho/LeadSquared** | Sheet = instant "Excel"; CRM later |
| Calendar | Google Calendar | **Google Calendar** | site-visit booking |
| Payments | Razorpay | **(later)** token/booking payment only | not core to lead-gen |
| Hosting | Vercel | **Vercel (control) + Samvaad (media)** | already deployed |

## Agents — prioritized for real estate (not all 8)
Build the ones that move site visits; skip cart/invoice for now.

| # | Agent | Status in repo | Pending |
|---|---|---|---|
| 1 | **Outbound voice** (speed-to-lead: call new leads in seconds) | ✅ scaffold — `voice-platform.js` `triggerOutboundCall` + `/api/calls/outbound` + outbound persona/Telugu opening | Samvaad account/keys + Exotel number + **DLT** |
| 2 | **Inbound voice** (answer the Modcon number 24/7) | ✅ inbound persona + `/api/voice/webhook` | forward number → Samvaad inbound agent |
| 3 | **WhatsApp automation** (send a number → call; reply/follow-up) | ✅ `/api/whatsapp/webhook` + `whatsapp.js` | WhatsApp Business API/BSP + approved templates |
| 4 | **Lead qualification + scoring** | ◐ `/api/anaga/summary` returns interested/score/disposition/summary/nextAction | add BANT scoring + routing (hot/warm/cold) + **persist** |
| 5 | **Site-visit booking** | ◐ persona books Sat/Sun (no real calendar) | Google Calendar API + confirmation + reminders |
| 6 | **Follow-up sequence** (multi-touch nurture) | ⨯ | n8n sequence engine + WhatsApp templates + retry logic |
| 7 | **Memory / CRM logging** ("Excel CRM fillings") | ⨯ not persisted | Sheet/Supabase write on hang-up → CRM later |
| — | Cart abandonment / invoice reminders | N/A for builders now | revisit for booking-token payments |

## Roadmap (phased)
**Phase 0 — DONE:** Anaga brain (Gemini Live), web tap-to-talk demo, SYL/MODCON ONE/Agartha data, outbound/inbound/commercial modes, premium UI, telephony + WhatsApp scaffolding, noise-robust VAD.

**Phase 1 — The core loop (lead → call → log → follow-up).**
- Samvaad account + Exotel number + DLT (you procure) → wire keys (15 min).
- Lead intake (website form / Meta lead-ad / 99acres / WhatsApp) → **n8n** (or `/api/calls/outbound`).
- Anaga calls in seconds → end-of-call → **log a row to Google Sheet/Supabase** (agent #7) → **WhatsApp follow-up** (agent #3).
- Outcome: every lead is auto-called, qualified, and logged. *This is the sellable MVP.*

**Phase 2 — Inbound + booking + scoring.**
- Forward Modcon's number → Samvaad inbound agent (#2).
- Google Calendar booking + reminders (#5).
- BANT scoring + hot/warm/cold routing + sales notification (#4).

**Phase 3 — Nurture + reporting + CRM.**
- Follow-up sequences across WhatsApp + call (#6).
- Dashboard/metrics; integrate Zoho/LeadSquared (don't build a CRM).

**Phase 4 — Sell to other builders (agency → SaaS).**
- Template the agent per client (persona + project data swap), isolated data, white-label, onboarding. Modcon's numbers become the case study.

## Compliance gates (India) — non-negotiable
- **TRAI/DLT** registration + **DND/NCPR** scrubbing for outbound; **DPDP Act 2023** for PII; AI disclosure (already in Anaga's first line).
- **Consent-first:** call **opted-in leads** (enquiries/forms/callbacks) — compliant, cheaper, higher conversion. WhatsApp Calling is great here (no DLT/PSTN, but ≤2 business calls/user/15 days).

## Economics (per project/client)
- Per 2–3 min Telugu call ≈ **₹4–7** (Samvaad speech + telephony). Sheet/n8n/WhatsApp tiers are cheap/free to start.
- Blueprint's agency model still holds: cost ~₹3–6k/client/mo → **charge ₹8–15k+/mo** (or per qualified lead / per booked site visit). Sell the **outcome** (booked visits), not software.

## Honest notes
- n8n/Vercel **don't carry call audio** — Samvaad does. Keep realtime on Samvaad; use n8n as glue.
- The blueprint's Twilio/OpenAI/Vapi are **swapped out** on purpose (India + Telugu + Google-only).
- Cart/invoice agents are parked — not core to selling site visits.
