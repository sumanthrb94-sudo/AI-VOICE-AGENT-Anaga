# Running Anaga for more than one business

This is grounded in what the codebase actually does today, checked line by
line before writing anything below — not a generic multi-tenancy template.
Two things are true at once, and the plan has to hold both:

1. **The hard part is already built.** A business's voice, script, and
   compliance rules are versioned JSON (`caller-agent/flows/*.json`), never
   code — that was a deliberate architectural bet, and it means "onboard a
   new business" is mostly "author a new JSON file," not "write new code."
2. **The isolation is not built at all.** Every deployment today shares one
   flat Firestore namespace — `calls`, `suppression`, `users` are global
   collections (`api/_lib/store.js:48-52`). Two businesses on one deployment
   would share a call log, a do-not-call list, and a user pool right now,
   with nothing stopping it.

Everything below is organised around closing that second gap without
throwing away the first.

---

## 1. Two deployment models — pick one per business, not one for all

| | **Fork** (separate Vercel project + Cloud Run service per business) | **Multi-tenant** (one deployment, org-scoped data) |
|---|---|---|
| Isolation | Total — separate Firestore project, separate secrets, separate everything | Depends entirely on code enforcing `orgId` on every read/write |
| Engineering cost today | Zero — this is what the repo already does (deploy.sh takes a project id) | Real: every store.js call site needs an org-scoped path, every route needs org resolved from the session, every secret needs an org dimension |
| Cost attribution | Free — separate GCP billing per business | Needs building (`CALL_COST_*` is currently one global rate table) |
| Blast radius of a bug | One business | All of them |
| Where you'd actually use it | A handful of high-touch clients (what Modcon is today), or any client who requires their own compliance boundary | Many small/self-serve businesses where per-business infra cost doesn't pencil out |

**Recommendation: fork for the first 3-5 businesses, multi-tenant once that's proven.** Not because multi-tenant is wrong — because the compliance gate in this system fails closed on purpose (`docs/COMPLIANCE.md`), and the fastest way to violate that promise is a cross-tenant data leak in a shared Firestore project that nobody load-tested for isolation. Forking is boring and safe while the business-side process (below) is still being learned. Convert to multi-tenant once the same onboarding has been run 3+ times and the shape of "what varies per business" has stopped changing.

If multi-tenant is chosen anyway, the concrete code changes are:
- `api/_lib/store.js`: every collection path gains an `orgId` prefix — `orgs/{orgId}/calls`, `orgs/{orgId}/suppression`, `orgs/{orgId}/users`. `orgId` already exists on the session user (`api/_lib/auth.js:137`) and is already carried through — it is simply never used as a path segment today.
- `api/_lib/google-identity.js`: `allowedRole()` currently resolves a role from one global `ADMIN_EMAILS`. It needs to resolve **(org, role)** — the same email can be an owner of one business's console and have no access to another's.
- Secrets: `SARVAM_API_KEY`, `DEEPGRAM_API_KEY`, per-business CRM tokens — currently one value per env var. Multi-tenant needs these keyed by org, likely in Secret Manager with an org-suffixed name, fetched per-request rather than read once at cold start.
- `CALL_COST_*`: currently one flat rate table for spend attribution. Needs an org dimension so business A's spend never shows up in business B's dashboard.
- The Cloud Run agent (`caller-agent/`) needs to know which org's flow/persona/voice to load per call — today it loads one hardcoded flow file.

None of this is started. Say so plainly to anyone who assumes "multi-tenant" is a config flag.

---

## 2. The per-business configuration unit — what "training" actually means here

There is no model fine-tuning in this system, and there shouldn't be — the
brain is Sarvam/Gemini, called through a prompt, not a model anyone trains.
"Training" a new business onto Anaga means **authoring three files and
passing a gate**, not touching weights.

### 2.1 The persona file (`*.persona.json`, schema at `shared/persona.schema.json`)

Required fields today: `id`, `version`, `displayName`, `persona`, `voice`,
`disclosure`. For a new business this is where identity lives — and where
the single most safety-critical string in the whole system lives:
`disclosure["te-IN"|"hi-IN"|"en-IN"]`, the sentence that makes the call legal.
The file's own convention (already established, keep it): mark it `NEVER
machine-translated`, version-bump on every wording change, and get a native
speaker to read it aloud before the first real dial — this isn't a
suggestion, `test-voice.mjs` enforces the marker exists.

**Currently hardcoded and needs extracting before a second business can use this** — 8 literal occurrences of `"Modcon Builders"` across `api/_lib/flow.js`, `api/_lib/prompts.js`, and the two CRM adapters (`hubspot.js`, `zoho.js`). These are template-literal fallbacks and LLM system-prompt text, not business logic — the fix is mechanical: read `persona.displayName` (already exists) or a new `persona.orgName` everywhere those 8 lines currently hardcode the string. Small, but it is the literal blocker to a second business today — do this before onboarding one.

### 2.2 The flow file (`*.flow.json`)

The qualification script: what questions get asked, in what order, what
counts as qualified, what the booking ask looks like. `caller-agent/flows/real-estate-qualify.flow.json` is real-estate-shaped today (purpose → budget → configuration → timeline). A different vertical needs a different flow file with the same shape — this is genuinely reusable across businesses in the same vertical (three real-estate developers could share one flow file and differ only in persona + CRM target), and needs a new file per vertical otherwise.

### 2.3 The CRM adapter (`api/_lib/integrations/crm/*.js`)

Two exist (HubSpot, Zoho) — `provider: 'none'` is also valid (health reports
this honestly). A new business either uses one of these two, adds a third
adapter (small — each is a thin REST wrapper, no vendor SDK per the repo's
own rule), or runs without CRM writeback and relies on the transcript panel.

### 2.4 What is explicitly NOT per-business — keep it that way

The compliance gate (`docs/COMPLIANCE.md`), the fail-closed suppression
check, the opt-out-overrides-everything rule, the calling-window enforcement.
These are regulatory, not brand preference. A business does not get to
configure these looser. If a business's requirements conflict with them, the
answer is "we don't onboard that business," not a per-tenant override flag —
the day one exists, it's a matter of time before it's set wrong for someone.

---

## 3. The onboarding protocol — the actual checklist, in order

Each gate below blocks the next. This mirrors how the compliance gate itself
is built (fail closed, verify don't assume) rather than inventing a new
philosophy for onboarding specifically.

**Gate 0 — Legal/compliance sign-off (before any engineering work starts)**
- Confirm the business has consent to call the numbers it will provide (this system dials outbound; it does not generate consent)
- Confirm DND/NDNC registration status for the calling numbers and territory
- Confirm the calling window (`docs/COMPLIANCE.md` currently encodes 9:00–21:00 IST) is correct for the business's jurisdiction — do not assume India-wide rules generalize if the business isn't in India
- Written sign-off, kept — this is the thing `compliance.mode: strict` refuses to skip, and the paper trail is what a regulator or a platform partner (the telephony provider, WhatsApp BSP, etc.) will ask for

**Gate 1 — Identity: the persona file**
- Business name, disclosure line in every language the business will call in, voice choice
- Disclosure line reviewed by a native speaker in each language, aloud, before it goes anywhere near a real number
- `id` and `version` set; this file goes into version control like code, because it changes like code (a wording fix is a diff someone reviews, not an edit made live)

**Gate 2 — Script: the flow file**
- Qualification questions, in order, matched to what the business's sales team actually asks
- The disqualification/booking criteria defined explicitly — "qualified" cannot be left implicit or the LLM will guess
- A human on the business side reads the flow file top to bottom and confirms it matches how their best rep actually opens a call

**Gate 3 — Integration**
- CRM adapter selected/built, or explicit `provider: 'none'` accepted
- Caller ID / outbound number provisioned and verified deliverable in the target territory
- Meta Lead Ads webhook wired if leads originate there, or the lead-intake endpoint used directly otherwise

**Gate 4 — Shadow mode (this does not exist yet as a feature — build it before Gate 5)**
- New business's flow runs against a small batch of real leads with a human listening live or reviewing every transcript before the business trusts it unsupervised
- No deployment should go from Gate 3 straight to unsupervised dialing; the repo does not currently have a "shadow" flag, and one is needed before the second business is faster than the first

**Gate 5 — Go-live**
- Rate limits and daily dial caps set explicitly, not left at whatever the default was tuned for the first business
- Spend attribution confirmed working (`CALL_COST_*` rates set) so the business's dashboard reflects real cost, not `missingRates`
- One real call, listened to end to end, on the actual production number — the same rule this session already learned the hard way applies to every future business, not just the first one

**Ongoing**
- `scripts/test-e2e-demo.mjs`-style scoping tests (currently for the demo/admin split) need a business-scoping equivalent once Gate 5 has run more than once: business A must never see business B's calls, transcripts, or spend. Write that test before the second business goes live, not after an incident.

---

## 4. What this deliberately does not cover

- **Fine-tuning a model per business.** Not needed and not recommended — the prompt + versioned flow/persona already carries per-business behavior, and fine-tuning would add a training pipeline, a model registry, and a drift problem for no capability this architecture is missing.
- **A self-serve signup flow.** Every gate above assumes a human runs onboarding. A self-serve product (business signs up, uploads a flow file, goes live with no review) is a different, much later product decision — Gate 0 and Gate 4 specifically are not things software should let a business skip by clicking "I agree."
- **Building the multi-tenant Firestore/secrets changes now.** Section 1 describes what they'd require; nothing there has been implemented. Say so if asked "is this ready" — it is scoped, not built.
