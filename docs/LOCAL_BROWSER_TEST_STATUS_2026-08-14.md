# Local Browser Test Status — 2026-08-14

The deployed browser interface at `https://ai-voice-agent-anaga.vercel.app/` was opened and the call screen was started successfully.

The approved Telugu outbound opening line rendered in the call transcript. The sandbox browser reported `no microphone available — type below`, which is expected because the sandbox has no physical microphone device. This environment therefore confirms front-end navigation and the non-microphone fallback, but it cannot prove an actual microphone-to-STT exchange.

A real voice test must be performed from the founder or team member's own desktop/mobile browser with microphone hardware. The intended test route is the public deployment; no outbound telephone call is initiated by this screen.

Before a reliable real-provider test, the replacement `SARVAM_API_KEY` must be set as a server-side production secret. The exposed old key should then be revoked after verification.

A non-sensitive typed test turn was also submitted through the deployed browser UI. The server returned a Telugu qualification reply, confirming that the deployed browser interface, turn endpoint, and reply rendering path work end-to-end. The test was not an outbound telephone call and did not use customer data.

The remaining unverified portion is microphone capture and real audio STT, because the sandbox has no physical microphone. That must be tested from a real desktop or mobile browser after a replacement Sarvam key is configured and the exposed key has been retired.
