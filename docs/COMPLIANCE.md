# Vaak AI — Compliance (India)

Compliance is a **product feature and a moat**, not paperwork. Every commercial outbound call in
India is governed by overlapping frameworks. The compliance agent (WP-5) enforces these in code.

## Owner & status tracker

| Requirement | Owner | Status |
|---|---|---|
| DLT registration (Principal Entity) + approved header | [name] | [ ] |
| 160-series number(s) via SIP provider | [name] | [ ] |
| Telemarketer registration via TSP | [name] | [ ] |
| Real-time DND scrub wired into dialer (fail closed) | [name] | [ ] |
| AI disclosure enforced at call open | [name] | [ ] |
| Opt-out propagation to suppression list (SLA defined) | [name] | [ ] |
| Recording + 90-day retention on Indian infra | [name] | [ ] |
| Calls only within TRAI-permitted hours | [name] | [ ] |
| DPDP Act data-handling review | [advisor] | [ ] |

## The frameworks (what each one demands)

1. **TRAI / TCCCPR (DLT):** all commercial calls registered on the DLT platform; pre-registered
   header per call; carriers auto-detect and disconnect unregistered/spam-pattern dialers across
   all networks at once.
2. **160-series mandate:** commercial outbound must originate from a 160-series number or be blocked.
3. **DND / National Customer Preference Register:** scrub before every call; status changes daily;
   log verification per attempt; honor opt-outs fast.
4. **AI/synthetic-content disclosure:** disclose the caller is an AI (2026 IT Rules direction).
5. **DPDP Act:** lawful basis for using the lead's number; data-handling, retention, deletion.

## Design rules (enforced in code — WP-5)
- **Fail closed.** No verified-clean number → no dial. Default-deny.
- **Disclosure is non-skippable.** The flow cannot proceed past the open without it.
- **Opt-out is immediate and permanent.** Writes to suppression list, blocks all future dials, logged.
- **Audit everything.** Immutable per-call log: number, scrub result, consent basis, disclosure, recording ref, outcome.

## Practical note
Use a provider (Plivo India / Exotel / FreJun / Ozonetel) that bundles DLT + DND + consent
management. Don't hand-roll the regulatory plumbing — integrate it, then enforce on top.
