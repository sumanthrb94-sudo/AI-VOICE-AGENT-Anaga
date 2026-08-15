// api/_lib/routes/auth-google.js
//
// POST /api/auth/google  { credential } -> sets the same session cookie login does
//
// The browser gets `credential` from Google Identity Services. We verify it
// against Google's public keys (../google-identity.js), check the address is on
// the admin allowlist, and then mint EXACTLY the session that a password login
// mints — same token, same cookie, same expiry, same role model.
//
// That last part is the whole design. This is a second FRONT DOOR, not a second
// authentication system. Everything downstream — currentUser(), requireUser(),
// hasRole(), the pwChangedAt revocation — is untouched and cannot tell the two
// apart, so there is no second code path to get wrong later.
//
// ── WHY THIS DOES NOT LIVE IN ITS OWN FILE UNDER api/ ─────────────────────
// Vercel Hobby allows 12 serverless functions and this repo is at exactly 12.
// api/auth.js already dispatches four routes; this is the fifth, and it costs
// nothing because _lib/ is not turned into a function. The URL is unchanged
// either way.

import { requireMethod, readRawBody, parseJson } from '../integrations/http.js';
import { limited, log, requestId } from '../guard.js';
import { issueToken, sessionCookie, authConfigured } from '../auth.js';
import { verifyGoogleIdToken, allowedRole, googleSignInConfigured } from '../google-identity.js';
import { getUserByEmail, createUser, updateUser, storeBackend } from '../store.js';

const mask = (e) => String(e).replace(/(.).*(@.*)/, '$1***$2');

export default async function handler(req, res) {
  if (!requireMethod(req, res, 'POST')) return;

  // Same bucket as password login. Both are ways to get a session, so sharing
  // the limit means an attacker cannot get a second budget by switching doors.
  if (limited(req, res, { bucket: 'login', limit: Number(process.env.RATE_LIMIT_LOGIN || 10) })) return;

  const rid = requestId(req);

  if (!authConfigured()) {
    return res.status(503).json({ error: 'auth_not_configured', detail: 'set SESSION_SECRET (32+ chars)' });
  }
  if (!googleSignInConfigured()) {
    return res.status(503).json({ error: 'google_not_configured', detail: 'set GOOGLE_CLIENT_ID' });
  }
  // Sessions are stateless but the ROLE is not — it is read back from the user
  // record on every request. Without a durable store this would "succeed" into
  // a map that vanishes with the instance, and the next request would 401.
  if (storeBackend() !== 'firestore') {
    return res.status(503).json({ error: 'store_not_configured', detail: 'set FIREBASE_SERVICE_ACCOUNT' });
  }

  const body = parseJson(await readRawBody(req)) || (typeof req.body === 'object' ? req.body : null);
  if (!body) return res.status(400).json({ error: 'invalid_json' });

  const identity = await verifyGoogleIdToken(body.credential);
  if (!identity) {
    // Deliberately one error for every failure: bad signature, wrong audience,
    // expired, unverified address. Telling a caller WHICH check failed is a
    // free oracle for tuning a forged token.
    log('GOOGLE_SIGNIN_REJECTED', { rid });
    return res.status(401).json({ error: 'invalid_credential' });
  }

  const role = allowedRole(identity.email);
  if (!role) {
    // A real Google identity that is simply not staff. Logged with a masked
    // address because it is the signal that matters if it ever happens a lot.
    log('GOOGLE_SIGNIN_NOT_ALLOWED', { rid, email: mask(identity.email) });
    return res.status(403).json({ error: 'not_authorized' });
  }

  const existing = await getUserByEmail(identity.email);
  let user;

  if (existing.ok && existing.found) {
    user = existing.data;
    if (user.disabled === true) {
      // The allowlist says yes and the account says no. The ACCOUNT wins —
      // otherwise disabling someone would not disable them, which is the
      // entire point of being able to disable someone.
      log('GOOGLE_SIGNIN_DISABLED', { rid, email: mask(identity.email) });
      return res.status(403).json({ error: 'account_disabled' });
    }
    // The allowlist is the source of truth for role, so demoting someone in the
    // env var takes effect on their next sign-in rather than needing a console.
    if (user.role !== role) {
      await updateUser(identity.email, { role }).catch(() => {});
      user = { ...user, role };
    }
    updateUser(identity.email, {
      lastLoginAt: new Date().toISOString(),
      googleSub: identity.sub,
      name: user.name || identity.name,
    }).catch(() => {});
  } else {
    // First sign-in for an allowlisted address creates the account.
    //
    // NOTE there is no passwordHash. That is intentional and safe:
    // authenticate() in auth.js compares against a fixed dummy hash when the
    // record has none, so this account cannot be logged into with a password —
    // there is no password to guess, and no empty string that verifies.
    const created = await createUser(identity.email, {
      name: identity.name || '',
      role,
      orgId: process.env.DEFAULT_ORG_ID || 'default',
      provider: 'google',
      googleSub: identity.sub,
      pwChangedAt: 0,
      createdAt: new Date().toISOString(),
      lastLoginAt: new Date().toISOString(),
    });
    if (!created.ok) {
      log('GOOGLE_SIGNIN_CREATE_FAILED', { rid, reason: created.error || 'unknown' });
      return res.status(503).json({ error: 'store_unavailable' });
    }
    const reread = await getUserByEmail(identity.email);
    if (!reread.ok || !reread.found) return res.status(503).json({ error: 'store_unavailable' });
    user = reread.data;
    log('GOOGLE_ACCOUNT_CREATED', { rid, role, email: mask(identity.email) });
  }

  const token = issueToken({ ...user, id: user.id || identity.email });
  if (!token) return res.status(503).json({ error: 'auth_not_configured' });

  log('LOGIN_OK', { rid, role: user.role, org: user.orgId || 'default', via: 'google' });
  res.setHeader('Set-Cookie', sessionCookie(token));
  return res.status(200).json({
    ok: true,
    user: {
      email: user.email,
      name: user.name || identity.name || '',
      picture: identity.picture || '',
      role: user.role || 'viewer',
      orgId: user.orgId || 'default',
    },
  });
}
