/* ===========================================================================
   The browser's view of the Anaga API.

   SAME ORIGIN, ALWAYS. Every path here is relative. The session cookie is
   host-only and SameSite=Lax, so the moment a call goes cross-origin the
   cookie stops being sent and sign-in silently stops working — which is the
   single reason the frontend is a static export inside THIS project rather
   than a separate one.

   Nothing here holds a credential. The session lives in an httpOnly cookie
   that JavaScript cannot read, which is the point: an XSS on this page cannot
   lift a session.
   =========================================================================== */

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message?: string) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      // Send the cookie. Same-origin is the default, but being explicit means
      // this keeps working if anyone ever adds a base URL.
      credentials: 'same-origin',
      headers: { accept: 'application/json', ...(init.headers || {}) },
      ...init,
    });
  } catch {
    // A network failure is not an auth failure and must not read like one —
    // "please sign in" for a dropped connection sends people to reset a
    // password that was never wrong.
    throw new ApiError(0, 'network_unreachable', 'Could not reach the server.');
  }

  const body = await res.json().catch(() => ({}) as Record<string, unknown>);
  if (!res.ok) {
    throw new ApiError(res.status, String(body?.error || `http_${res.status}`), String(body?.detail || ''));
  }
  return body as T;
}

/* ------------------------------------------------------------------- types */

export type Role = 'owner' | 'operator' | 'viewer';

export interface SessionUser {
  email: string;
  name: string;
  picture?: string;
  role: Role;
  orgId: string;
}

export interface SignInStatus {
  session: boolean;
  google: boolean;
  clientId: string | null;
  admins: number;
  store: boolean;
}

export interface Health {
  ok: boolean;
  region?: string;
  ready?: { demo: boolean; call: boolean; production: boolean };
  signIn?: SignInStatus;
  blockers?: string[];
  [k: string]: unknown;
}

/* ------------------------------------------------------------------ calls */

/** Public. Also the one place the login page learns whether Google is wired. */
export const getHealth = () => request<Health>('/api/integrations/health');

export const signInWithGoogle = (credential: string) =>
  request<{ ok: true; user: SessionUser }>('/api/auth/google', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credential }),
  });

/**
 * NOTE THE `| null`. /api/auth/me answers **200 with `user: null`** for an
 * anonymous visitor rather than 401 — deliberately, so a page can ask "who is
 * this?" without treating "nobody" as an error. It means a RESOLVED getMe() is
 * not proof of a session: anything consuming this must check the `user` field,
 * not merely that the promise did not reject. Typing it as non-null would have
 * let every caller skip that check with the type system's blessing.
 */
export const getMe = () => request<{ ok: true; user: SessionUser | null }>('/api/auth/me');

export const signOut = () => request<{ ok: true }>('/api/auth/logout', { method: 'POST' });

export const getConsoleSummary = (limit = 50) =>
  request<Record<string, unknown>>(`/api/console/summary?limit=${limit}`);

export const getCalls = (limit = 25) =>
  request<{ ok: true; calls: unknown[] }>(`/api/calls/transcript?limit=${limit}`);

export const getCall = (callId: string) =>
  request<{ ok: true; call: unknown }>(`/api/calls/transcript?callId=${encodeURIComponent(callId)}`);

/**
 * Turn an ApiError into something a person can act on. Every string here names
 * the NEXT STEP, because "unauthorized" tells somebody nothing about what to
 * do with their afternoon.
 */
export function explain(err: unknown): string {
  if (!(err instanceof ApiError)) return 'Something went wrong.';
  switch (err.code) {
    case 'network_unreachable': return 'Could not reach the server. Check your connection and try again.';
    case 'not_signed_in':       return 'Your session has expired. Sign in again.';
    case 'forbidden':           return 'Your account does not have access to this.';
    case 'not_authorized':      return 'That Google account is not on the admin list.';
    case 'invalid_credential':  return 'Google could not verify that sign-in. Try again.';
    case 'google_not_configured': return 'Google sign-in is not configured on this deployment (GOOGLE_CLIENT_ID).';
    case 'auth_not_configured': return 'Sign-in is not configured on this deployment (SESSION_SECRET).';
    case 'store_not_configured': return 'The database is not configured on this deployment (FIREBASE_SERVICE_ACCOUNT).';
    case 'account_disabled':    return 'That account has been disabled.';
    default:                    return err.message || 'Something went wrong.';
  }
}
