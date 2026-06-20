// api/dashboard/export.js
//
// GET /api/dashboard/export  → download all leads as a CSV file.
// Same DASHBOARD_PASSCODE auth as /api/dashboard.
// Columns match LEAD_FIELDS in leadstore.js, plus created_at.

import { listLeads, LEAD_FIELDS } from '../_lib/leadstore.js';
import { blockedByRateLimit } from '../_lib/ratelimit.js';

function authorized(req) {
  const pass = process.env.DASHBOARD_PASSCODE;
  if (!pass) return false;
  const bearer = String((req.headers && req.headers['authorization']) || '').replace(/^Bearer\s+/i, '').trim();
  const alt = String((req.headers && req.headers['x-dashboard-key']) || '').trim();
  return bearer === pass || alt === pass;
}

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (blockedByRateLimit(req, res, { key: 'export', max: 10, windowMs: 60000 })) return;
  if (!process.env.DASHBOARD_PASSCODE) return res.status(503).json({ error: 'dashboard_disabled' });
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });

  try {
    const limit = Math.min(parseInt(req.query && req.query.limit, 10) || 2000, 5000);
    const r = await listLeads({ limit });
    const leads = r.leads || [];

    const columns = [...LEAD_FIELDS, 'created_at'];
    const header = columns.map(csvEscape).join(',');
    const rows = leads.map((l) =>
      columns.map((f) => csvEscape(l[f])).join(',')
    );
    const csv = [header, ...rows].join('\r\n');

    const filename = `anaga-leads-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send('﻿' + csv); // BOM for Excel UTF-8
  } catch (e) {
    console.error('export_failed', String(e).slice(0, 160));
    return res.status(503).json({ error: 'export_unavailable' });
  }
}
