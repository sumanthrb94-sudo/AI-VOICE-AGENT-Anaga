// api/auth.js
//
// One serverless function for the whole auth surface. The four routes still
// exist as four URLs — /api/auth/login, /logout, /me, /bootstrap — they are
// rewritten onto this handler in vercel.json.
//
// WHY: Vercel's Hobby plan allows 12 serverless functions per deployment, and
// adding login took the repo to 15. The build failed outright, which is the
// right failure (a partial deploy of an auth system would be far worse) but it
// is a packaging limit, not an architectural one. Collapsing four handlers that
// share every dependency into one function costs nothing at runtime — they were
// already four cold starts of the same imports.
//
// The URLs are deliberately unchanged. A platform quota is not a reason to
// break an API contract, and `action` is derived from the path so a caller
// never has to know this happened. The handlers themselves are untouched in
// api/_lib/routes/ — under _lib because Vercel does not turn those into
// functions, which is the entire trick.

import loginHandler from './_lib/routes/auth-login.js';
import logoutHandler from './_lib/routes/auth-logout.js';
import meHandler from './_lib/routes/auth-me.js';
import bootstrapHandler from './_lib/routes/auth-bootstrap.js';

const ROUTES = {
  login: loginHandler,
  logout: logoutHandler,
  me: meHandler,
  bootstrap: bootstrapHandler,
};

export default async function handler(req, res) {
  // The rewrite supplies `action`; the path is the fallback so a direct hit on
  // /api/auth/login still works if a rewrite is ever missing or mis-ordered.
  // Getting this wrong fails closed — an unknown action is a 404, never a
  // default route into something privileged.
  // Both sources are matched EXACTLY against the table, and the path is parsed
  // with an anchored pattern rather than by taking the last segment. Popping
  // the last segment resolved "/api/auth/../bootstrap" to "bootstrap" — the
  // traversal survived because pop() does not care what came before it. That
  // reached the one handler here that can create an owner. It is independently
  // protected by BOOTSTRAP_TOKEN and by refusing once an account exists, so it
  // was not a way in; it was a dispatcher that answered a question nobody
  // should have been able to ask.
  const known = (v) => (typeof v === 'string' && Object.hasOwn(ROUTES, v) ? v : null);

  const path = String(req.url || '').split('?')[0];
  const m = /^\/api\/auth\/([a-z]+)\/?$/.exec(path);

  const action = known(String(req.query?.action || '').toLowerCase())
    || known(m ? m[1].toLowerCase() : null);

  const route = action ? ROUTES[action] : null;
  if (!route) {
    return res.status(404).json({ error: 'not_found', actions: Object.keys(ROUTES) });
  }
  return route(req, res);
}
