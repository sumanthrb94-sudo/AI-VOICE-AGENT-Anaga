# Vaak AI — Financial Model Notes (assumptions to validate)

These are the assumptions behind the plan, written so an investor can interrogate them and a
founder can replace them with real numbers as design partners report data. Nothing here is a promise.

## Per-call cost (the engine of unit economics)
~3-min call, India:
- Telephony (160-series outbound): ~₹0.50–0.90/min → ₹1.5–2.7
- STT (Sarvam): ~₹1.5/min → ₹4.5
- TTS (Sarvam): ~₹1.5/min → ₹4.5  (ElevenLabs ~3x higher — avoid unless cloned voice needed)
- LLM: ₹2–6/call (drops sharply with self-hosted Ollama/VLLM)

**Cost per call by stack maturity:**
- Managed platform (e.g. Bolna BYOK), early: ~₹13–22
- Self-hosted orchestration + Sarvam + own LLM: ~₹6–10
- The migration from the first to the second is WP-2/WP-4 and a planned gross-margin step-change.

## Volume reference
- 200 calls/day ≈ 18,000 min/month ≈ running cost ₹55k–1.3L/month depending on stack.
- Scales linearly with concurrency (WP-9 autoscale).

## Value to customer (why outcome pricing works)
- A booked, qualified site visit for a ₹2–4 Cr villament is worth lakhs in expected value.
- A human telecaller: ₹25–40k/month all-in, ~50–80 quality calls/day, no nights/weekends, attrition.
- One Vaak agent: thousands of calls/day, 24/7, consistent, in-language. The arbitrage is large
  enough that outcome pricing (per booked meeting) leaves strong margin for both sides.

## Revenue model levers
- Platform/seat floor (predictable MRR) + per-booked-meeting (aligned, scalable) + usage pass-through.
- Enterprise/on-prem tier (BFSI): higher ACV, stickier, data residency.

## What to fill in with real data (do NOT fabricate for the deck)
- [ ] Actual book-rate per 100 calls by vertical (from design partners)
- [ ] Actual blended cost/call on owned stack
- [ ] CAC and sales cycle per developer
- [ ] Net revenue retention after 6 months
- [ ] Churn

## Market figures used in the plan (sources)
- India voice assistant market: USD 153.01M (2024) → USD 957.61M (2030), 35.7% CAGR — NextMSC.
- India conversational AI: 26.3% CAGR 2025–30 — Grand View Research.
- Global conversational AI: USD 11.58B (2024) → USD 41.39B (2030), 23.7% CAGR — Grand View Research.
- IndicVoices: 12,000-hr, 22-language dataset (IIT Madras / AI4Bharat / Sarvam) — NextMSC.
- Gnani.ai speech-to-speech LLM: ~10M daily bank interactions — NextMSC.

**Diligence discipline:** every number in the deck must trace to either a cited source or
design-partner data. Replace bracketed placeholders before any investor sees the model.
