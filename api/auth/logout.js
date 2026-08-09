// api/auth/logout.js
//
// POST /api/auth/logout — clears the session cookie.
//
// POST, not GET: a GET logout can be fired by any <img> on any page, which is
// a nuisance attack that logs people out mid-call.

import { requireMethod } from '../_lib/integrations/http.js';
import { clearCookie } from '../_lib/auth.js';

export default async function handler(req, res) {
  if (!requireMethod(req, res, 'POST')) return;
  res.setHeader('Set-Cookie', clearCookie());
  return res.status(200).json({ ok: true });
}
