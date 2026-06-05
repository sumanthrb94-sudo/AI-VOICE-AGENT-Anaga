# Agent Task Template — Vaak AI Work Package

Copy this into a GitHub issue to spawn a coding agent (or brief a developer) against one WP.

---

**Work Package:** WP-[N] — [title]
**Depends on:** [WP-x merged] / none
**Owner agent/dev:** [assignee]
**Branch:** `wp-[N]-[slug]`

## Goal
[One sentence from MULTI_AGENT_SPEC.md.]

## Deliverables
- [ ] [from spec]
- [ ] [from spec]

## Done-when (acceptance)
- [ ] [measurable criterion from spec]
- [ ] Tests pass in CI
- [ ] Honors provider-abstraction boundary (no vendor SDK in business logic)
- [ ] Conversation flows/prompts (if touched) live as versioned data, not code
- [ ] If compliance-adjacent: fails closed; audit log complete

## Guardrails (read MULTI_AGENT_SPEC.md §7)
- Verify any Pipecat / Bolna / Sarvam / Plivo API names against current docs.
- Write the eval test before changing any prompt (WP-7).
- If unsure whether a dial is legal, block it.

## Definition of production grade (repo bar)
See MULTI_AGENT_SPEC.md §5. This WP must not regress any item there.

## PR checklist
- [ ] Scoped to this WP only
- [ ] Updated relevant docs / contracts in `shared/`
- [ ] Observability added (logs/metrics/traces) where relevant
- [ ] No secrets in code
