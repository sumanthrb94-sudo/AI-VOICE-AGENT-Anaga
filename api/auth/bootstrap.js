// api/auth/bootstrap.js
//
// POST /api/auth/bootstrap  { email, password, name, token } -> the first owner
//
// The chicken-and-egg problem: you cannot sign in to create the first account.
// Every solution to that is a hole if you get it wrong, so this one is closed
// three ways at once, and any single one of them failing shuts it:
//
//   1. It refuses once ANY account exists. This is the important one — the
//      window is open for one request in the lifetime of the deployment.
//   2. It requires BOOTSTRAP_TOKEN from the environment. Whoever can set env
//      vars is already the owner of the deployment; nobody else can guess it.
//   3. It requires a durable store, so it cannot "succeed" into an in-memory
//      map that vanishes and leaves the window open again on the next instance.
//
// The alternative — seeding a default admin password — is how products ship
// with admin/admin in production for years.

import { requireMethod, readRawBody, parseJson } from '../_lib/integrations/http.js';
import { limited, log, requestId } from '../_lib/guard.js';
import {
  hashPassword, passwordProblem, normalizeEmail, issueToken, sessionCookie, authConfigured,
} from '../_lib/auth.js';
import { anyUserExists, createUser, storeBackend } from '../_lib/store.js';

function safeEqual(a, b) {
  const x = String(a || ''), y = String(b || '');
  if (x.length !== y.length || !x.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

export default async function handler(req, res) {
  if (!requireMethod(req, res, 'POST')) return;
  if (limited(req, res, { bucket: 'bootstrap', limit: Number(process.env.RATE_LIMIT_BOOTSTRAP || 5) })) return;

  const rid = requestId(req);

  if (!authConfigured()) {
    return res.status(503).json({ error: 'auth_not_configured', detail: 'set SESSION_SECRET (32+ chars)' });
  }
  if (storeBackend() !== 'firestore') {
    return res.status(503).json({ error: 'store_not_configured', detail: 'set FIREBASE_SERVICE_ACCOUNT' });
  }

  const expected = process.env.BOOTSTRAP_TOKEN || '';
  if (expected.length < 16) {
    return res.status(503).json({ error: 'bootstrap_disabled', detail: 'set BOOTSTRAP_TOKEN (16+ chars)' });
  }

  const body = parseJson(await readRawBody(req)) || (typeof req.body === 'object' ? req.body : null);
  if (!body) return res.status(400).json({ error: 'invalid_json' });

  if (!safeEqual(body.token, expected)) {
    log('BOOTSTRAP_REJECTED', { rid, reason: 'bad_token' });
    return res.status(401).json({ error: 'invalid_token' });
  }

  // Checked AFTER the token so a stranger cannot use this endpoint to find out
  // whether the deployment has been set up yet.
  const any = await anyUserExists();
  if (!any.ok) return res.status(502).json({ error: 'store_unavailable' });
  if (any.any) {
    log('BOOTSTRAP_REJECTED', { rid, reason: 'already_bootstrapped' });
    return res.status(409).json({ error: 'already_bootstrapped', detail: 'sign in, or add users from the console' });
  }

  const email = normalizeEmail(body.email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'invalid_email' });
  const bad = passwordProblem(body.password);
  if (bad) return res.status(400).json({ error: 'weak_password', detail: bad });

  const created = await createUser(email, {
    name: String(body.name || '').trim().slice(0, 80),
    role: 'owner',
    orgId: String(body.orgId || 'default').trim().slice(0, 64),
    passwordHash: hashPassword(body.password),
    pwChangedAt: Date.now(),
    disabled: false,
  });
  // createDocIfAbsent losing the race means somebody bootstrapped in the
  // milliseconds between the check above and here. They won; this one loses.
  if (!created.ok || !created.created) {
    return res.status(409).json({ error: 'already_bootstrapped' });
  }

  log('BOOTSTRAP_OK', { rid, org: body.orgId || 'default' });

  const token = issueToken({ id: email, orgId: body.orgId || 'default', role: 'owner', pwChangedAt: Date.now() });
  res.setHeader('Set-Cookie', sessionCookie(token));
  return res.status(200).json({
    ok: true,
    user: { email, name: body.name || '', role: 'owner', orgId: body.orgId || 'default' },
    next: 'Remove BOOTSTRAP_TOKEN from the environment — it can never be used again.',
  });
}
