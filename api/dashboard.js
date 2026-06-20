// api/dashboard.js
//
// Consolidated dashboard endpoint — leads, stats, and CSV export in one function.
//
// GET /api/dashboard           → { ok, store, leads:[...] }  (was /api/dashboard)
// GET /api/dashboard?view=stats  → aggregate stats           (was /api/dashboard/stats)
// GET /api/dashboard?view=export → CSV file download         (was /api/dashboard/export)
//
// All routes require DASHBOARD_PASSCODE (Bearer or x-dashboard-key header).

import { listLeads, leadStore, LEAD_FIELDS } from './_lib/leadstore.js';
import { blockedByRateLimit } from './_lib/ratelimit.js';

function authorized(req) {
  const pass = process.env.DASHBOARD_PASSCODE;
  if (!pass) return false;
  const bearer = String((req.headers && req.headers['authorization']) || '').replace(/^Bearer\s+/i, '').trim();
  const alt = String((req.headers && req.headers['x-dashboard-key']) || '').trim();
  return bearer === pass || alt === pass;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'method_not_allowed' }); }
  if (blockedByRateLimit(req, res, { key: 'dash', max: 30, windowMs: 60000 })) return;
  if (!process.env.DASHBOARD_PASSCODE) return res.status(503).json({ error: 'dashboard_disabled' });
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });

  const view = String(req.query && req.query.view || '');
  if (view === 'stats') return handleStats(req, res);
  if (view === 'export') return handleExport(req, res);
  return handleLeads(req, res);
}

async function handleLeads(req, res) {
  try {
    const r = await listLeads({ limit: 200 });
    return res.status(200).json({ ok: true, store: leadStore(), leads: r.leads || [] });
  } catch (e) {
    console.error('dashboard_failed', String(e).slice(0, 160));
    return res.status(503).json({ error: 'dashboard_unavailable' });
  }
}

async function handleStats(req, res) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(200).json({ ok: true, available: false, reason: 'supabase_not_configured' });
  }
  const base = process.env.SUPABASE_URL.replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_KEY;
  const table = process.env.SUPABASE_LEADS_TABLE || 'leads';

  try {
    const resp = await fetch(`${base}/rest/v1/${table}?select=disposition,score,interested,callType,created_at&limit=2000&order=created_at.desc`, { headers: { apikey: key, Authorization: 'Bearer ' + key } });
    if (!resp.ok) throw new Error('fetch_' + resp.status);
    const leads = await resp.json();
    if (!Array.isArray(leads)) throw new Error('bad_response');

    const total = leads.length;
    const booked = leads.filter((l) => l.disposition === 'booked').length;
    const interested = leads.filter((l) => l.interested === 'yes' || l.interested === true).length;
    const hot = leads.filter((l) => parseInt(l.score, 10) >= 70).length;
    const optOut = leads.filter((l) => l.disposition === 'opt-out').length;
    const callback = leads.filter((l) => l.disposition === 'callback').length;

    const byDirection = {};
    for (const l of leads) { const d = l.callType || 'unknown'; byDirection[d] = (byDirection[d] || 0) + 1; }

    const now = new Date();
    const trend = [];
    for (let i = 6; i >= 0; i--) {
      const dayStart = new Date(now); dayStart.setUTCHours(0, 0, 0, 0); dayStart.setUTCDate(dayStart.getUTCDate() - i);
      const dayEnd = new Date(dayStart.getTime() + 86400000);
      const count = leads.filter((l) => { const t = new Date(l.created_at).getTime(); return t >= dayStart.getTime() && t < dayEnd.getTime(); }).length;
      trend.push({ date: dayStart.toISOString().slice(0, 10), label: `${dayStart.getUTCDate()}/${dayStart.getUTCMonth() + 1}`, count });
    }

    return res.status(200).json({ ok: true, total, booked, interested, hot, optOut, callback, conversionRate: total > 0 ? Math.round((booked / total) * 100) : 0, byDirection, trend });
  } catch (e) {
    console.error('stats_failed', String(e).slice(0, 160));
    return res.status(503).json({ ok: false, error: 'stats_unavailable' });
  }
}

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

async function handleExport(req, res) {
  try {
    const limit = Math.min(parseInt(req.query && req.query.limit, 10) || 2000, 5000);
    const r = await listLeads({ limit });
    const leads = r.leads || [];
    const columns = [...LEAD_FIELDS, 'created_at'];
    const header = columns.map(csvEscape).join(',');
    const rows = leads.map((l) => columns.map((f) => csvEscape(l[f])).join(','));
    const csv = [header, ...rows].join('\r\n');
    const filename = `anaga-leads-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send('﻿' + csv);
  } catch (e) {
    console.error('export_failed', String(e).slice(0, 160));
    return res.status(503).json({ error: 'export_unavailable' });
  }
}
