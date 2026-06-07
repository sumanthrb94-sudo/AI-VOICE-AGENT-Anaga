// api/_lib/ratelimit.js
//
// Best-effort, zero-dependency, per-IP rate limit for the PAID endpoints
// (/api/tts, /api/stt, /api/anaga/*, /api/live/token). These are public and each
// call spends real money (Sarvam credits / Gemini tokens), so an unthrottled URL
// could be scripted to drain an account.
//
// NOTE: on Vercel each serverless instance has its own memory, so this is a
// PER-INSTANCE guard, not a global one. It stops casual abuse and accidental
// loops but is NOT a substitute for a shared store (Upstash / Vercel KV) at real
// scale — see docs/PRODUCTION_READINESS.md.

const BUCKETS = new Map(); // key -> { count, reset }

export function clientIp(req) {
  const h = (req && req.headers) || {};
  const xff = h['x-forwarded-for'] || h['x-real-ip'] || '';
  const ip = String(xff).split(',')[0].trim();
  return ip || (req && req.socket && req.socket.remoteAddress) || 'unknown';
}

/**
 * Fixed-window per-IP limiter. Call once per request; on { ok:false } reply 429.
 * @param {object} req
 * @param {{max?:number, windowMs?:number, key?:string}} [opts]
 * @returns {{ok:boolean, remaining:number, retryAfter:number}}
 */
export function rateLimit(req, opts = {}) {
  const max = opts.max || 30;
  const windowMs = opts.windowMs || 60000;
  const bucketKey = (opts.key ? opts.key + ':' : '') + clientIp(req);
  const now = Date.now();

  let b = BUCKETS.get(bucketKey);
  if (!b || now >= b.reset) { b = { count: 0, reset: now + windowMs }; BUCKETS.set(bucketKey, b); }
  b.count++;

  // opportunistic GC so the map can't grow unbounded across many IPs
  if (BUCKETS.size > 5000) {
    for (const [k, v] of BUCKETS) if (now >= v.reset) BUCKETS.delete(k);
  }

  return {
    ok: b.count <= max,
    remaining: Math.max(0, max - b.count),
    retryAfter: Math.max(1, Math.ceil((b.reset - now) / 1000)),
  };
}

// Helper: apply a limit and write the 429 response if exceeded. Returns true if
// the request was blocked (caller should `return`).
export function blockedByRateLimit(req, res, opts) {
  const rl = rateLimit(req, opts);
  if (!rl.ok) {
    res.setHeader('Retry-After', String(rl.retryAfter));
    res.status(429).json({ error: 'rate_limited' });
    return true;
  }
  return false;
}
