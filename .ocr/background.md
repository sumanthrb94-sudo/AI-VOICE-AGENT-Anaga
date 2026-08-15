# Review background — Anaga voice agent

Read this before reviewing. It changes what counts as a defect in this repo.

## What this system does

It places **outbound phone calls to real people in India**, under TRAI/DLT/DND
regulation. A defect here is not a broken build — it is an illegal call to
someone who asked not to be contacted, or a lead dialled without a legal basis.
Weight findings accordingly: a bypassed compliance check outranks any style issue.

## Non-negotiables — treat a violation as a blocking defect

1. **The compliance gate fails CLOSED** (`api/_lib/compliance.js`).
   Unconfigured means blocked. An unreachable DND scrub or suppression list means
   blocked. Flag any change that turns a "cannot verify" into an allow, adds a
   default that permits dialling, or reaches the dial queue without going through
   `intakeLead()` in `api/_lib/pipeline.js`.

2. **Opt-out is absolute.** It must reach the suppression list *before* the CRM,
   and a transcript opt-out must override the disposition the agent reported.
   A swallowed or best-effort opt-out is a blocking defect, not a warning.

3. **Provider abstraction holds.** No vendor SDK, vendor name, or vendor-specific
   field in business logic. LLM → `api/_lib/llm.js`; TTS → `api/_lib/tts.js`;
   CRM → `api/_lib/integrations/crm.js`; lead sources → a normalizer producing the
   canonical Lead. Flag any vendor import that crosses that boundary.

4. **Secrets and PII.** Keys are server-side env only and must never appear in a
   response, log line, error message, or URL echoed to a client. Phone numbers are
   masked with `maskPhone()` outside the dialling path. Flag any leak.

5. **Webhook authenticity.** `api/integrations/meta/leads.js` must verify the
   `X-Hub-Signature-256` HMAC against the **raw** body before processing anything.
   This endpoint causes phone calls; an unverified path is critical.

6. **Honesty in outputs.** Endpoints and UI report what actually happened.
   `queued:false` with a reason beats a hopeful success. A rate with no
   denominator is `null`, never `0%`. Flag fabricated, seeded, or placeholder data
   presented as real.

7. **Anaga qualifies and books; humans close.** Flag any prompt, doc, or UI string
   claiming the agent closes deals or negotiates price.

## Repo conventions

- Vanilla ESM on Node 18+, no build step, no npm dependencies in `api/` or `web/`.
  Flag any added runtime dependency.
- **This is not a React project.** Ignore React/hooks rules from the default
  ruleset — `web/` is vanilla DOM.
- Tests are dependency-free: `scripts/test-integrations.mjs`, run with
  `node --experimental-detect-module`. Any change to the gate should add a case
  asserting it still blocks when unconfigured.
- Fail soft at the edges (a CRM outage must not stop a legal dial), fail closed at
  the gate (an unverifiable number must always stop one).
