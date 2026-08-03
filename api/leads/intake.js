// api/leads/intake.js
//
// POST /api/leads/intake — the source-agnostic front door. Anything that is not
// a Meta Lead Ads webhook comes in here: a CRM workflow (HubSpot workflow, Zoho
// function, Salesforce Flow), a landing page, a CSV/campaign uploader, Zapier.
//
// Auth: Bearer INTEGRATIONS_API_KEY (fails closed — unset key authorizes nobody).
//
// Body: a single lead or { leads: [...] }, plus optional flags:
//   { name, phone, email, city, purpose, budget, configuration, timeline,
//     consent: { granted, basis, at }, campaign: {...},
//     dryRun: true, ignoreWindow: true }
//
// Consent is NOT assumed. A caller that cannot state a basis and a timestamp
// gets its lead stored (if a CRM is wired) and its dial refused — see
// api/_lib/compliance.js. That refusal is the product, not a bug.
//
// Contract: shared/integrations-contract.md

import { authorize, requireMethod, readRawBody, parseJson } from '../_lib/integrations/http.js';
import { normalizeLead } from '../_lib/integrations/lead.js';
import { intakeLead } from '../_lib/pipeline.js';

const MAX_BATCH = 100;

export default async function handler(req, res) {
  if (!requireMethod(req, res, 'POST')) return;

  const auth = authorize(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const raw = await readRawBody(req);
  const body = parseJson(raw);
  if (!body) return res.status(400).json({ error: 'invalid_json' });

  const rows = Array.isArray(body.leads) ? body.leads : [body];
  if (!rows.length) return res.status(400).json({ error: 'no_leads' });
  if (rows.length > MAX_BATCH) {
    return res.status(400).json({ error: 'batch_too_large', max: MAX_BATCH });
  }

  const opts = { dryRun: body.dryRun === true, ignoreWindow: body.ignoreWindow === true };

  const results = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') {
      results.push({ accepted: false, reason: 'invalid_lead' });
      continue;
    }

    const lead = normalizeLead(row, {
      source: String(row.source || body.source || 'api'),
      sourceId: row.id || row.sourceId || row.recordId || null,
      campaign: row.campaign || body.campaign || {},
      consent: row.consent || body.consent || {},
    });

    results.push(await intakeLead(lead, opts));
  }

  return res.status(200).json({
    received: results.length,
    queued: results.filter((r) => r.queued).length,
    blocked: results.filter((r) => String(r.reason || '').startsWith('blocked:')).length,
    results,
  });
}
