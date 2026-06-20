// api/dashboard/stats.js
//
// GET /api/dashboard/stats
// Returns aggregate stats over the lead store — total leads, booked, hot leads,
// opt-outs, call directions breakdown, and a 7-day lead trend.
//
// Same auth as /api/dashboard: DASHBOARD_PASSCODE-gated.
// Supabase only (Sheets read is not implemented for aggregates).

import { blockedByRateLimit } from '../_lib/ratelimit.js';

function authorized(req) {
  const pass = process.env.DASHBOARD_PASSCODE;
  if (!pass) return false;
  const bearer = String((req.headers && req.headers['authorization']) || '').replace(/^Bearer\s+/i, '').trim();
  const alt = String((req.headers && req.headers['x-dashboard-key']) || '').trim();
  return bearer === pass || alt === pass;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (blockedByRateLimit(req, res, { key: 'stats', max: 30, windowMs: 60000 })) return;
  if (!process.env.DASHBOARD_PASSCODE) return res.status(503).json({ error: 'dashboard_disabled' });
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(200).json({ ok: true, available: false, reason: 'supabase_not_configured' });
  }

  const base = process.env.SUPABASE_URL.replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_KEY;
  const table = process.env.SUPABASE_LEADS_TABLE || 'leads';

  try {
    // Fetch all leads (limit 2000 for stats — tune as volume grows)
    const resp = await fetch(
      `${base}/rest/v1/${table}?select=disposition,score,interested,callType,created_at&limit=2000&order=created_at.desc`,
      { headers: { apikey: key, Authorization: 'Bearer ' + key } }
    );
    if (!resp.ok) throw new Error('fetch_' + resp.status);
    const leads = await resp.json();
    if (!Array.isArray(leads)) throw new Error('bad_response');

    const total = leads.length;
    const booked = leads.filter((l) => l.disposition === 'booked').length;
    const interested = leads.filter((l) => l.interested === 'yes' || l.interested === true).length;
    const hot = leads.filter((l) => parseInt(l.score, 10) >= 70).length;
    const optOut = leads.filter((l) => l.disposition === 'opt-out').length;
    const callback = leads.filter((l) => l.disposition === 'callback').length;

    // Direction breakdown
    const byDirection = {};
    for (const l of leads) {
      const d = l.callType || 'unknown';
      byDirection[d] = (byDirection[d] || 0) + 1;
    }

    // 7-day trend (count per day)
    const trend = [];
    const now = new Date();
    for (let i = 6; i >= 0; i--) {
      const dayStart = new Date(now);
      dayStart.setUTCHours(0, 0, 0, 0);
      dayStart.setUTCDate(dayStart.getUTCDate() - i);
      const dayEnd = new Date(dayStart.getTime() + 86400000);
      const count = leads.filter((l) => {
        const t = new Date(l.created_at).getTime();
        return t >= dayStart.getTime() && t < dayEnd.getTime();
      }).length;
      const label = `${dayStart.getUTCDate()}/${dayStart.getUTCMonth() + 1}`;
      trend.push({ date: dayStart.toISOString().slice(0, 10), label, count });
    }

    return res.status(200).json({
      ok: true,
      total,
      booked,
      interested,
      hot,
      optOut,
      callback,
      conversionRate: total > 0 ? Math.round((booked / total) * 100) : 0,
      byDirection,
      trend,
    });
  } catch (e) {
    console.error('stats_failed', String(e).slice(0, 160));
    return res.status(503).json({ ok: false, error: 'stats_unavailable' });
  }
}
