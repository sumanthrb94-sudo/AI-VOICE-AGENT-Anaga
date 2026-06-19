# n8n — Anaga lead loop

An importable workflow that turns **any lead source into an instant Anaga call + a
logged row**:

```
Lead source (website form / Meta lead-ad / 99acres / Zapier / curl)
   → n8n Webhook
   → normalize {name, phone, source, direction}
   → POST /api/calls/outbound   (Anaga calls the lead in seconds)
   → append a row to your Google Sheet ("queued")
   → respond 200
```

> The **call outcome** (disposition, score, summary, recording…) is written to the
> **same Sheet automatically** by `/api/voice/webhook` when the call ends — so this
> n8n flow logs the *intake* and the app logs the *result*. (If you'd rather have a
> single row, delete the "Log Lead (Sheet)" node and let the app do all logging.)

## Import
1. n8n → **Workflows → Import from File** → choose `anaga-lead-loop.workflow.json`.
2. Open the nodes and fix the 3 placeholders:
   - **Trigger Anaga Call** (HTTP Request): set `url` to `https://<your-app>/api/calls/outbound`, and replace `Bearer YOUR_CALL_TRIGGER_SECRET` with your real `CALL_TRIGGER_SECRET` *(better: make a "Header Auth" credential so the secret isn't stored in the node).*
   - **Log Lead (Sheet)** (Google Sheets): pick your Google credential, set the **document** to your Sheet (`YOUR_GOOGLE_SHEET_ID`) and the **tab** (`Leads`). The Sheet's header row should match the columns in `api/_lib/leadstore.js` (`ts, name, phone, language, callType, disposition, score, interested, summary, nextAction, comment, bookingDay, callId, source, recording`).
   - (optional) tweak the **Normalize Lead** field mapping to match your source's field names.
3. **Activate** the workflow → copy the **Production Webhook URL**.

## Point your lead sources at it
Send a `POST` to the webhook URL with JSON like:
```json
{ "name": "Ravi", "phone": "9534869999", "source": "website" }
```
- **Website form / Meta lead-ad / portals:** point their webhook/Zapier/Make at this URL.
- **Test it:**
  ```bash
  curl -X POST https://<your-n8n>/webhook/anaga-lead \
    -H "Content-Type: application/json" \
    -d '{"name":"Ravi","phone":"9534869999","source":"test"}'
  ```
  Anaga should call the number within seconds and a row should appear in the Sheet.

## Batch / campaign variant
To call a **list** instead of one lead, duplicate the flow and change the HTTP node to
`POST https://<your-app>/api/campaign` with a body like:
```json
{ "numbers": ["9534869999", "8341234567"], "concurrency": 5, "direction": "outbound" }
```
For large, time-paced lists, add a **Split In Batches** + **Wait** loop so you stay
within your Samvaad/Exotel channel limit.

## Prerequisites
- The app deployed with `CALL_TRIGGER_SECRET` set, and a voice platform configured
  (`SARVAM_API_KEY` + `SAMVAAD_OUTBOUND_URL` + `SAMVAAD_AGENT_ID`) — otherwise
  `/api/calls/outbound` returns `503 voice_unavailable`.
- For the Sheet node: a Google account connected in n8n with access to your Sheet.
