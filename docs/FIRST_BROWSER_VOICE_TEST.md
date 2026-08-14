# First Browser Voice Test — Local and Safe

This procedure starts the existing browser frontend and local API server with **real Sarvam and Deepgram services**, but it does **not** enable telephony, lead intake, a dial queue, or outbound calls. Use only your own voice or an internal team member’s voice in the first test.

> Create the **replacement** Sarvam key first. Do not reuse the key previously pasted into chat, and do not paste the replacement into chat, Git, a screenshot, or any frontend code.

## Fastest test: use the deployed browser now

The fastest path is the public test interface at [https://ai-voice-agent-anaga.vercel.app](https://ai-voice-agent-anaga.vercel.app). It was checked on 14 August 2026: the page opened, the call screen started, and a non-sensitive typed turn received a live Telugu response. The sandbox has no physical microphone, so it cannot test microphone capture; your own desktop/mobile browser can.

Open the page in Chrome or Edge on a laptop or phone with a working microphone. Select **Inbound** and **English** for the simplest first test, click **Start the call**, and choose **Allow** when the browser asks for microphone permission. Say:

> “Hi Anaga, I am looking for a three-bedroom apartment in Hyderabad.”

A successful result shows your transcript as **Prospect**, returns an Anaga reply as text, and plays that reply. If microphone permission is blocked, use the text box at the bottom to confirm the conversation path while you fix the browser permission.

## Local test: run the full frontend and API on your computer

Run these commands from the local repository checkout that contains the current code. The repository already ignores `.env.local`; confirm that it never appears in a commit.

```bash
cd ~/AI-VOICE-AGENT-Anaga
node --version                 # must be Node 22 or later
pnpm install --frozen-lockfile
```

Create the local-only configuration file. Replace only the two placeholders on **your own machine**.

```bash
cat > .env.local <<'EOF'
# Real browser voice test only. These remain server-side environment variables.
SARVAM_API_KEY=PASTE_NEW_SARVAM_KEY_HERE
DEEPGRAM_API_KEY=PASTE_DEEPGRAM_KEY_HERE

# Sarvam is the primary conversational and voice provider.
LLM_PROVIDER=sarvam
SARVAM_LLM_MODEL=sarvam-105b-conversations
TTS_PROVIDER=sarvam
SARVAM_TTS_MODEL=bulbul:v3
TTS_SPEAKER=kavya

# English uses Deepgram first; Indic languages use Sarvam first.
STT_PROVIDER=sarvam,deepgram
STT_PROVIDER_EN_IN=deepgram,sarvam
STT_PROVIDER_TE_IN=sarvam,deepgram
STT_PROVIDER_HI_IN=sarvam,deepgram
SARVAM_STT_MODEL=saaras:v3
DEEPGRAM_MODEL=nova-3

# Browser-only safety: do not configure a caller ID, queue URL, or telephony provider.
COMPLIANCE_MODE=strict
EOF
chmod 600 .env.local
```

Load the variables into the current shell and start the supported local development server. Do **not** use `STUB_VENDORS=1`; that mode is for offline UI tests and does not call Sarvam or Deepgram.

```bash
set -a
source .env.local
set +a
PORT=3000 node --experimental-detect-module scripts/dev-server.mjs
```

You should see:

```text
vaak dev server  http://localhost:3000
  13 api routes ...
  vendors: live (needs real keys + egress)
```

Open **http://localhost:3000** on the same computer. `localhost` is treated as a secure browser context for microphone access, so HTTPS is not required for this local-only test.

## Exact first-test sequence

1. Use headphones for the first test to reduce acoustic echo while confirming the microphone path.
2. Select **Inbound** and **English**, then select **Start the call**.
3. Allow microphone permission for `localhost:3000`.
4. Wait for Anaga’s opening. This proves the local TTS path can produce audio.
5. Say the test sentence above, then pause for two seconds.
6. Confirm that the screen shows the actual transcript and an Anaga reply. For English, the browser audio turn should use Deepgram first and fall back to Sarvam only if Deepgram is unavailable.
7. Say “Do not call me again” only if you want to validate the in-browser end-call behavior; it does not place a real telephone call in this local setup.
8. Click the red **End call** button. The microphone indicator in the browser should turn off.

| Result | Meaning | Next action |
|---|---|---|
| Opening plays and reply is spoken | Browser, Sarvam LLM, and TTS are working | Test Hindi and Telugu next. |
| Transcript appears but there is no audio | The conversation/recognition path works; TTS failed | Inspect the terminal log for the Sarvam TTS response. |
| “No microphone available” | Browser/device permission or mic hardware issue | Check the browser site permission, OS microphone permission, and select a real input device. |
| “Brain unavailable” | Sarvam LLM key, model, network, or quota issue | Confirm the new key is active and that the terminal launched with `.env.local` sourced. |
| No transcript after speech | STT failure or browser recording issue | Test typed fallback first, then inspect Deepgram/Sarvam errors in the terminal. |

When finished, stop the local server with `Ctrl+C`, close the browser tab, and leave `.env.local` uncommitted. After the new Sarvam key has passed this test, revoke the exposed old Sarvam key.
