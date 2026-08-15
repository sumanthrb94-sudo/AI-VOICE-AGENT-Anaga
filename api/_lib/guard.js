// api/_lib/guard.js
//
// Production hardening shared by the public API surface: rate limiting,
// structured logging, and request correlation.
//
// ⚠️ SCOPE HONESTY — read before relying on the rate limiter.
// The counters live in process memory. On Vercel that means PER INSTANCE, and
// instances scale out, so the effective global limit is (limit x instances).
// This is a cheap abuse dampener, NOT a security control: it will slow a naive
// flood from one source, and it will not stop a distributed one. The real
// protections are the HMAC on the Meta webhook and the bearer token on every
// other endpoint — those are what actually gate access. For a hard global
// limit, put Vercel WAF / Cloudflare in front, or move these counters to Redis.

const WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000);
const buckets = new Map();   // key -> { count, resetAt }

/**
 * @returns {{allowed:boolean, remaining:number, retryAfterSec:number}}
 */
export function rateLimit(key, limit) {
  const now = Date.now();
  let b = buckets.get(key);

  if (!b || now >= b.resetAt) {
    b = { count: 0, resetAt: now + WINDOW_MS };
    buckets.set(key, b);
  }
  b.count++;

  // Opportunistic sweep so a long-lived instance does not grow unbounded.
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) if (now >= v.resetAt) buckets.delete(k);
  }

  const remaining = Math.max(0, limit - b.count);
  return {
    allowed: b.count <= limit,
    remaining,
    retryAfterSec: Math.max(1, Math.ceil((b.resetAt - now) / 1000)),
  };
}

/** Best-effort client identity: the first hop in X-Forwarded-For. */
export function clientKey(req) {
  const xff = String(req.headers['x-forwarded-for'] || '');
  const ip = xff.split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
  return ip;
}

/**
 * Apply a rate limit and set the standard headers. Returns true when the
 * request was rejected (the handler should return immediately).
 */
export function limited(req, res, { bucket, limit }) {
  const r = rateLimit(`${bucket}:${clientKey(req)}`, limit);
  res.setHeader('X-RateLimit-Limit', String(limit));
  res.setHeader('X-RateLimit-Remaining', String(r.remaining));
  if (!r.allowed) {
    res.setHeader('Retry-After', String(r.retryAfterSec));
    res.status(429).json({ error: 'rate_limited', retryAfterSec: r.retryAfterSec });
    return true;
  }
  return false;
}

/** Correlation id — reuses the platform's when present. */
export function requestId(req) {
  return String(
    req.headers['x-vercel-id'] || req.headers['x-request-id'] ||
    Math.random().toString(36).slice(2, 10)
  );
}

// Anything matching these keys is redacted before a log line is written, so a
// future caller cannot accidentally log a secret by passing the wrong object.
const SECRET_KEY = /(key|token|secret|authorization|password|api[-_]?key)/i;

function redact(value, depth = 0) {
  if (depth > 4 || value == null) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value !== 'object') return value;

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

/** One JSON object per line. Never a secret; phone numbers must arrive masked. */
export function log(event, fields = {}) {
  try {
    console.log(JSON.stringify({
      at: new Date().toISOString(), svc: 'anaga-api', event, ...redact(fields),
    }));
  } catch {
    console.log(JSON.stringify({ at: new Date().toISOString(), svc: 'anaga-api', event }));
  }
}
