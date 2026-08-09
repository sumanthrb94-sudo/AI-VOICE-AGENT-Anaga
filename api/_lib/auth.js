// api/_lib/auth.js
//
// Human authentication: accounts, passwords, sessions.
//
// This is NOT the same thing as INTEGRATIONS_API_KEY, and conflating them is why
// there was no login until now. That key is a machine credential — one shared
// secret the caller agent uses to report an outcome. It answers "is this our
// software?". It cannot answer "which person is doing this?", so it can never
// support a lead being assigned to someone, an audit trail naming a human, or
// one operator being locked out without locking out the fleet.
//
// Both exist from here on. Machines carry the key; people carry a session.
//
// ── CHOICES, AND WHY ──────────────────────────────────────────────────────
// PBKDF2-HMAC-SHA256 for passwords. bcrypt/argon2 are better and both are
// native modules; this repo has zero dependencies and runs on serverless, so
// PBKDF2 out of node:crypto is the strongest thing available without breaking
// that. 210,000 iterations is OWASP's 2023 floor for SHA-256.
//
// Sessions are a signed token in an httpOnly cookie, not a database lookup.
// Serverless has no shared memory and a Firestore read per request costs a
// round trip on every page; an HMAC verifies locally in microseconds. The
// trade is that a session cannot be revoked before it expires — so they are
// short, and `pwChangedAt` invalidates every existing session for a user whose
// password changed, which is the case that actually matters.

import crypto from 'node:crypto';
import { getUserByEmail, getUser } from './store.js';

const ITERATIONS = 210_000;
const KEYLEN = 32;
const DIGEST = 'sha256';
export const SESSION_HOURS = Number(process.env.SESSION_HOURS || 12);
const COOKIE = 'vaak_session';

export const ROLES = ['owner', 'operator', 'viewer'];

/** Secret for signing sessions. Fails closed — no secret, no logins. */
function sessionSecret() {
  const s = process.env.SESSION_SECRET || '';
  // Refuse a weak secret rather than sign with one. A guessable secret means
  // anybody can mint themselves an owner session, which is worse than the
  // login page being down.
  return s.length >= 32 ? s : null;
}

export function authConfigured() {
  return Boolean(sessionSecret());
}

// ---------------------------------------------------------------------------
// passwords
// ---------------------------------------------------------------------------

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(String(password), salt, ITERATIONS, KEYLEN, DIGEST).toString('hex');
  return `pbkdf2$${DIGEST}$${ITERATIONS}$${salt}$${hash}`;
}

/** Constant-time verify. Returns false for any malformed record rather than throwing. */
export function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 5 || parts[0] !== 'pbkdf2') return false;
  const [, digest, iterations, salt, expected] = parts;
  const n = Number(iterations);
  if (!Number.isFinite(n) || n < 1000) return false;
  let actual;
  try {
    actual = crypto.pbkdf2Sync(String(password), salt, n, expected.length / 2, digest).toString('hex');
  } catch { return false; }
  const a = Buffer.from(actual, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Passwords people will actually use, without a policy that pushes them to
 * "Password1!". Length does the work.
 */
export function passwordProblem(password) {
  const p = String(password || '');
  if (p.length < 12) return 'Use at least 12 characters.';
  if (p.length > 200) return 'That is too long.';
  if (/^\s|\s$/.test(p)) return 'Remove the leading or trailing space.';
  const common = ['password', '123456', 'qwerty', 'letmein', 'welcome', 'admin', 'vaak'];
  if (common.some((c) => p.toLowerCase().includes(c) && p.length < 20)) {
    return 'That contains a word attackers try first. Use a longer passphrase.';
  }
  return null;
}

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------

const b64u = (buf) => Buffer.from(buf).toString('base64url');

function sign(payload, secret) {
  const body = b64u(JSON.stringify(payload));
  const mac = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

/** Verify and decode. Returns null on ANY problem — never a partial session. */
export function readToken(token) {
  const secret = sessionSecret();
  if (!secret || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expect = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  if (!payload || typeof payload !== 'object') return null;
  if (!payload.exp || Date.now() > payload.exp) return null;
  return payload;
}

export function issueToken(user) {
  const secret = sessionSecret();
  if (!secret) return null;
  return sign({
    uid: user.id,
    org: user.orgId || 'default',
    role: user.role || 'viewer',
    // Stamped so a password change can invalidate every token issued before it,
    // without a revocation list.
    pw: user.pwChangedAt || 0,
    exp: Date.now() + SESSION_HOURS * 3600 * 1000,
  }, secret);
}

export function sessionCookie(token) {
  const maxAge = SESSION_HOURS * 3600;
  // httpOnly: JavaScript must not be able to read it, so an XSS cannot lift a
  // session. Lax: sends on top-level navigation but not cross-site POSTs, which
  // is the CSRF protection for every mutating route here.
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function cookieFrom(req) {
  const raw = req.headers?.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return v.join('=');
  }
  return null;
}

/**
 * The signed-in user, or null. Reads the session locally, then loads the record
 * so a disabled account stops working immediately rather than at token expiry.
 *
 * @returns {Promise<null|{id,email,name,role,orgId}>}
 */
export async function currentUser(req) {
  const payload = readToken(cookieFrom(req));
  if (!payload) return null;
  const out = await getUser(payload.uid);
  if (!out.ok || !out.found || !out.data) return null;
  const u = out.data;
  if (u.disabled === true) return null;
  // A password change retires every session issued before it.
  if ((u.pwChangedAt || 0) > (payload.pw || 0)) return null;
  return { id: payload.uid, email: u.email, name: u.name || '', role: u.role || 'viewer', orgId: u.orgId || 'default' };
}

/** Guard for a handler. Returns the user, or writes the error and returns null. */
export async function requireUser(req, res, { role = null } = {}) {
  if (!authConfigured()) {
    res.status(503).json({ error: 'auth_not_configured', detail: 'set SESSION_SECRET (32+ chars)' });
    return null;
  }
  const user = await currentUser(req);
  if (!user) {
    res.status(401).json({ error: 'not_signed_in' });
    return null;
  }
  if (role && !hasRole(user, role)) {
    res.status(403).json({ error: 'forbidden', need: role });
    return null;
  }
  return user;
}

/** Roles are ranked: owner does everything an operator can, and so on. */
export function hasRole(user, need) {
  const rank = { viewer: 0, operator: 1, owner: 2 };
  return (rank[user?.role] ?? -1) >= (rank[need] ?? 99);
}

/**
 * Look up a user for sign-in. Always does the PBKDF2 work, even when the email
 * is unknown, so response timing does not reveal which addresses have accounts.
 */
export async function authenticate(email, password) {
  const e = normalizeEmail(email);
  const out = await getUserByEmail(e);
  const user = out.ok && out.found ? out.data : null;
  const stored = user?.passwordHash
    || 'pbkdf2$sha256$210000$0000000000000000000000000000000000000000000000000000000000000000$'
       + '0'.repeat(64);
  const ok = verifyPassword(password, stored);
  if (!user || !ok || user.disabled === true) return null;
  return { ...user, id: user.id || out.id };
}
