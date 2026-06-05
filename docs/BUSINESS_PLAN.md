# Vaak AI — Business Plan & Investment Memorandum

> **Vaak** (वाक् / వాక్) — Sanskrit for *speech, the spoken word*.
> The voice-AI sales infrastructure for Bharat's high-ticket industries.

**Confidential — for prospective investors and founding team only**
**Stage:** Pre-seed / Seed · **Target positioning:** ₹100 Cr valuation
**Document owner:** Founder & CEO · **Version:** 1.0 · **Date:** June 2026

---

## 0. How to read this document

This is a two-part package. **Part A (this file)** is the business and investment case — read this first if you're an investor or evaluating the opportunity. **Part B (`/engineering`)** is the production build specification — the architecture, the multi-agent system design, and the milestone plan that the engineering org (human or AI coding agents) executes against. The `/engineering/MULTI_AGENT_SPEC.md` file is specifically structured so that autonomous coding agents can be spawned against discrete, well-scoped work packages.

A note on honesty, because it protects you in a fundraise: this plan deliberately separates *what is true today* from *what we will build*. Inflated claims survive a pitch and die in diligence. Everything here is written to survive diligence.

---

## 1. Executive summary

India runs on phone calls, in dozens of languages, and the highest-value of those calls — selling a ₹2 crore home, closing an insurance policy, recovering a loan — are still made by humans who are expensive, inconsistent, unavailable after 7pm, and impossible to scale with ad spend.

**Vaak is voice-AI sales infrastructure built natively for India's languages and India's regulations.** We deploy autonomous, multilingual voice agents that qualify leads, handle objections, and book high-intent meetings across Hindi, Telugu, Tamil, and English — including the code-mixed way Indians actually speak — then hand warm prospects to human closers. We start where the unit economics are most violent: **real estate**, where a single booked site visit is worth lakhs and developers burn crores on leads that never get a callback.

The wedge is narrow and deep. The platform underneath is horizontal: the same engine that books a site visit qualifies an insurance lead or runs a collections call. We are building the **agentic sales layer for Bharat's regulated, high-ticket, multilingual industries** — a market no US-built platform can serve well, because they were never built for Indian languages, Indian telephony, or TRAI.

**The ask:** [seed amount] to reach [N] paying enterprise customers, ₹[X] ARR, and a defensible, India-tuned conversation engine within 18 months.

---

## 2. The problem (sharp version)

Three facts, stacked:

1. **Speed-to-lead decides who wins, and India is catastrophically slow.** Leads contacted within five minutes convert dramatically better than those contacted hours later; the average Indian business takes 2–6 hours to respond, by which point a high-intent buyer has already spoken to three competitors. Every rupee of ad spend that generates a lead nobody calls back is wasted.

2. **The work is unscalable with humans.** A good telecaller manages 50–80 quality conversations a day, costs ₹25–40k/month all-in, quits, needs training, has bad days, and cannot work at 9pm on a Sunday when the working professional finally has time to talk. You cannot scale call capacity at the rate you scale ad spend.

3. **The existing AI doesn't speak Bharat.** Global voice platforms (US-built) handle English well and fall apart on Indian accents, regional languages, and the code-switching ("Telugu starting, English finishing") that is the actual register of Indian business conversation. They also weren't built for the 160-series / DLT / DND regime that governs every commercial call in India — so deploying them is a compliance liability, not just a quality one.

The result: a structural gap between the value of high-ticket Indian sales conversations and the tools available to have them at scale.

---

## 3. The solution

**Vaak deploys fleets of autonomous voice agents that sound local, stay compliant, and are measured on outcomes — booked meetings — not minutes.**

What an agent does on a call:
- Opens in the prospect's language, discloses it's an AI (legally required, and it builds trust), and asks permission.
- Qualifies through natural conversation, not a rigid script — budget, configuration, timeline, intent.
- Handles the real objections (price, location, possession date, trust) from a tuned playbook.
- Books the high-value next step — a site visit, a demo, a human callback — directly into the calendar.
- Hands hot leads to a human closer, warm, with full context written to the CRM.
- Respects opt-outs instantly and logs everything for compliance.

What makes it *Vaak* and not a wrapper:
- **India-native language core** — built on the Indian-language speech stack (Sarvam-class STT/TTS, IndicVoices-trained models), tuned on real Indian telephony audio, handling code-mixing as a first-class case.
- **Compliance as a product feature** — 160-series, DLT, real-time DND scrubbing, AI disclosure, and 90-day Indian-soil recording retention are built into the dialing path. Competitors treat this as an integration problem; we treat it as the moat.
- **Outcome-priced** — we align our pricing to booked meetings, not call minutes, which aligns our incentives with the customer's ROI and is structurally hard for USD-per-minute foreign platforms to match.

---

## 4. Market

The numbers support a venture-scale outcome without any need to exaggerate them.

**India voice AI / conversational AI — top-down:**
- India's voice assistant market: valued at USD 153.01 million in 2024, predicted to reach USD 957.61 million by 2030, at a 35.7% CAGR — among the fastest-growing voice AI markets globally.
- India's broader conversational AI market is forecast to grow at a 26.3% CAGR from 2025 to 2030, with BFSI, retail, and healthcare as the leading adopting sectors.
- The global conversational AI market sits at USD 11.58 billion in 2024, projected to USD 41.39 billion by 2030 at a 23.7% CAGR — Vaak is an India-first play in a globally expanding category.
- The validating tailwind: IIT Madras, AI4Bharat, and Sarvam AI launched IndicVoices, a 12,000-hour speech dataset covering 22 Indian languages, and Indian voicebots already operate at scale — e.g. Gnani.ai's speech-to-speech LLM powers 10M daily interactions for banks. The infrastructure to build on exists; the application layer for high-ticket sales is open.

**Bottom-up TAM (the number that matters):**
- Real estate beachhead: India has thousands of active residential projects. A mid-size developer spends ₹50L–₹5Cr/year on lead generation and loses a large fraction to slow follow-up. If Vaak captures even ₹5–15L/year per developer across a few thousand developers, the real-estate segment alone is a multi-thousand-crore opportunity.
- Horizontal expansion (BFSI collections, insurance renewals, lending, edtech, healthcare) multiplies this several times over — each is a phone-driven, multilingual, regulated, high-ticket vertical with the identical core need.

We are not claiming the whole market. We are claiming that a focused India-native player can build a ₹100 Cr+ enterprise inside it.

---

## 5. Why now

- **The language layer just became viable.** India's open and commercial Indic speech stacks crossed the quality bar for telephony in 2025–26. Two years ago this product was not buildable at quality; today it is.
- **Latency is solved.** Production voice stacks now respond in under a second, which is the threshold below which a phone conversation feels human. The hard infrastructure problem is no longer the blocker.
- **Regulation created a moat.** The 160-series/DLT/DND regime is now strictly enforced, with carriers auto-detecting and disconnecting non-compliant dialers. This is painful — which is exactly why compliance-native infrastructure is valuable and defensible.
- **Demand is proven, not hypothetical.** Indian developers are already publicly running AI-led, sales-team-free launches (e.g. the HoABL Naigaon digital allotment of 1,419 homes). The market has seen it work and wants it.

---

## 6. Product & the multi-agent architecture

Vaak is not a single bot. It is an **orchestrated fleet of specialized agents**, which is both the technical design and the scaling story investors should understand:

- **Caller agents** — run the live conversation (one per call, spawned on demand, horizontally scalable to thousands of concurrent calls).
- **Qualifier/scoring agent** — grades lead intent in real time against the customer's ideal-customer profile and live inventory.
- **Compliance agent** — gates every dial on DND/consent, enforces disclosure, manages retention. Fails closed.
- **Orchestrator** — assigns work, balances load across caller agents, handles handoff to humans.
- **Analytics/eval agent** — scores every recorded call (LLM-as-judge + sampling for human review) and feeds improvements back into the prompts and routing. This is the flywheel: more calls → better conversation data → better agents → better outcomes → more customers.

The full technical specification, including how autonomous coding agents are spawned to build each component, is in **`/engineering/MULTI_AGENT_SPEC.md`**.

---

## 7. Business model

- **Outcome-based core:** priced per qualified booked meeting, with a platform subscription floor. This is the headline and the differentiator.
- **Platform/seat fee:** monthly per-client base covering agent provisioning, dashboard, CRM integration.
- **Usage pass-through:** telephony + model costs, transparently.
- **Enterprise/on-prem tier:** for BFSI and large developers needing data residency and custom deployment — higher margin, stickier.

Unit economics direction (to be validated and reported honestly to investors): target blended cost of ~₹6–22 per call depending on stack maturity, against a booked-meeting value of thousands of rupees to the customer. Gross margin expands as we migrate from third-party platforms to our own orchestration on owned infrastructure — the cost-reduction path is a planned milestone, not a hope.

---

## 8. Go-to-market

1. **Beachhead — Hyderabad real estate (founder's home advantage).** The founder operates inside this market (channel-partner relationships, live projects). Land 3–5 design-partner developers, prove booked-visit lift, generate referenceable case studies in-language.
2. **Expand within real estate** across Hyderabad → Bangalore → Pune → MMR via developer and channel-partner networks.
3. **Cross the vertical** into BFSI collections/renewals and lending, where the same engine applies and contract sizes are larger.
4. **Land-and-expand** inside enterprise accounts: one use case → many.

The founder's existing footprint (real estate channel partnerships, a portfolio of brand/marketing ventures, software background) is the unfair distribution advantage for the beachhead.

---

## 9. Competition & moat

| Competitor type | Examples | Why Vaak wins |
|---|---|---|
| US-built voice platforms | Vapi, Retell, Bland | Weak Indian-language quality; not TRAI-native; USD/min pricing punishes Indian call patterns |
| India horizontal voicebots | Bolna, Gnani, SquadStack | Generalist/API-first; Vaak wins on vertical depth (high-ticket sales playbooks) + outcome pricing |
| In-house dev teams | Enterprises building their own | Compliance + conversation quality + eval flywheel are hard to replicate; we sell time-to-value |

**The compounding moats:** (1) proprietary in-language, in-telephony conversation + objection data from real high-ticket calls; (2) compliance infrastructure as a hard-to-copy product surface; (3) outcome-pricing that aligns incentives and is structurally awkward for foreign per-minute platforms; (4) the eval flywheel — every call makes the next one better.

---

## 10. Team

- **Founder & CEO** — full-stack engineer (~5.5 yrs, .NET/Azure/Angular/cloud) and operator running multiple ventures across real estate marketing and software; deep Hyderabad real-estate distribution; lives the beachhead customer's problem daily.
- **[To hire] Founding AI/Voice engineer** — owns the conversation engine and turn-taking quality.
- **[To hire] Enterprise sales lead** — BFSI/real-estate relationships.
- **Advisors [target]** — a voice-AI/Indic-NLP researcher; a TRAI/telecom-compliance expert; a real-estate developer principal.

*Honest note for investors:* this is currently founder-led with a clear, costed hiring plan tied to milestones below. We are not claiming a team we don't have.

---

## 11. Roadmap & milestones (18 months)

| Phase | Window | Goal | Proof point |
|---|---|---|---|
| **P0 — Compliance + MVP** | M0–M2 | DLT/160-series live; single Syl-class agent on managed stack | First 100 real compliant calls, recorded & scored |
| **P1 — Design partners** | M2–M6 | 3–5 paying real-estate design partners | Measured booked-visit lift vs. human baseline |
| **P2 — Own the stack** | M6–M10 | Migrate to owned multi-agent orchestration; cut per-call cost ~40% | Gross-margin step-change; concurrency to 100s |
| **P3 — Scale RE + eval flywheel** | M10–M14 | 20+ RE customers; analytics agent live | Repeatable onboarding; net revenue retention >100% |
| **P4 — Cross-vertical** | M14–M18 | First BFSI/lending logos | Horizontal proof; Series A readiness |

---

## 12. The ask & use of funds

**Raising:** [₹ amount] seed at the target valuation.
**Use of funds (indicative):** ~45% engineering (conversation engine, multi-agent orchestration, eval), ~25% GTM/sales, ~15% compliance + infra, ~15% founder + ops runway.
**18-month outcome we're underwriting:** [N] paying customers, ₹[X] ARR, a defensible India-native engine, and the metrics to raise a Series A.

---

## 13. Risk register (told straight)

| Risk | Mitigation |
|---|---|
| "Closes deals autonomously" is overhyped | We do NOT claim it. Vaak qualifies + books; humans close high-ticket. This is the correct, defensible design. |
| Regulatory change (TRAI/DPDP) | Compliance is core team competency + advisor; we adapt faster than generalists because it's our moat. |
| Foundation-model / platform dependency | Provider-abstracted architecture (swap STT/LLM/TTS); migrate to owned orchestration; own the data + eval layer. |
| Incumbent (Sarvam/Gnani) moves down-market | We win on vertical depth + outcome pricing + distribution, not on being a better horizontal API. |
| Conversation quality / "feels robotic" | Turn-taking is a first-class engineering investment; eval flywheel; in-language tuning. |
| Founder concentration / hiring | Milestone-tied hiring plan; advisors; this raise funds the first key hires. |

---

## 14. Closing

India's most valuable conversations happen by voice, in many languages, and the tools to have them at scale don't exist yet — not built for Bharat. Vaak is that infrastructure. We start with the most painful, highest-value wedge, build a compliance and conversation moat that foreign platforms structurally cannot cross, and compound it with every call we run.

We're not selling the fantasy that AI closes the deal. We're building the engine that makes sure the deal *gets the call* — instantly, in the customer's language, every time. That engine is a ₹100 Cr+ company.

---

*Appendices: `/engineering/` (build spec, multi-agent system, milestones), `/docs/FINANCIAL_MODEL_NOTES.md` (assumptions), `/docs/COMPLIANCE.md` (regulatory detail). Market figures cited from MarketsandMarkets, Grand View Research, NextMSC, KenResearch (2025–26). All forward-looking statements are estimates to be validated.*
