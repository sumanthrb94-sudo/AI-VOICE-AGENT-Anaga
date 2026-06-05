# caller-agent

WP-3 — Caller-agent pipeline: streaming STT→LLM→TTS, turn-taking, barge-in. The product's soul.

The agent persona is **Anaga** — a warm **female** voice (Telugu / Hindi / English, code-mixed).
Her identity, voice, and non-skippable AI disclosure live as versioned data in
`flows/anaga.persona.json` (never hard-coded). Voice is provider-abstracted (WP-4): swap the
Sarvam female speaker via config only.

See `engineering/MULTI_AGENT_SPEC.md` for the full work-package brief.
