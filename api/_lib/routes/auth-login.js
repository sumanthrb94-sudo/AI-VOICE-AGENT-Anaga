// api/auth/login.js
//
// POST /api/auth/login  { email, password } -> sets the session cookie
//
// Deliberately uninformative on failure. "No such account" and "wrong password"
// are the same 401 with the same wording, and authenticate() does the PBKDF2
// work even for an unknown address so the two do not differ in timing either.
// Otherwise this endpoint is a free tool for discovering who has an account.

import { requireMethod, readRawBody, parseJson } from '../integrations/http.js';
import { limited, log, requestId } from '../guard.js';
import { authenticate, issueToken, sessionCookie, authConfigured, normalizeEmail } from '../auth.js';
import { updateUser } from '../store.js';

export default async function handler(req, res) {
  if (!requireMethod(req, res, 'POST')) return;
  if (!authConfigured()) {
    return res.status(503).json({ error: 'auth_not_configured', detail: 'set SESSION_SECRET (32+ chars)' });
  }
  // Tighter than the other endpoints: this one guards every account on the
  // deployment, so the limit is about credential stuffing, not about cost.
  if (limited(req, res, { bucket: 'login', limit: Number(process.env.RATE_LIMIT_LOGIN || 10) })) return;

  const rid = requestId(req);
  const body = parseJson(await readRawBody(req)) || (typeof req.body === 'object' ? req.body : null);
  if (!body) return res.status(400).json({ error: 'invalid_json' });

  const email = normalizeEmail(body.email);
  const user = await authenticate(email, body.password);
  if (!user) {
    // Log the attempt, never the password, and only a masked address.
    log('LOGIN_FAILED', { rid, email: email.replace(/(.).*(@.*)/, '$1***$2') });
    return res.status(401).json({ error: 'invalid_credentials' });
  }

  const token = issueToken(user);
  if (!token) return res.status(503).json({ error: 'auth_not_configured' });

  updateUser(user.email, { lastLoginAt: new Date().toISOString() }).catch(() => {});
  log('LOGIN_OK', { rid, role: user.role, org: user.orgId || 'default' });

  res.setHeader('Set-Cookie', sessionCookie(token));
  return res.status(200).json({
    ok: true,
    user: { email: user.email, name: user.name || '', role: user.role || 'viewer', orgId: user.orgId || 'default' },
  });
}
