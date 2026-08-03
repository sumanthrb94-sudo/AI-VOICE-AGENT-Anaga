// caller-agent/src/optout.js
//
// Re-export of the canonical detector in shared/optout.js. The caller agent and
// the API must never drift on what counts as an opt-out, so there is exactly
// one implementation and this file only points at it.

export { detectOptOut, transcriptHasOptOut } from '../../shared/optout.js';
