// api/auth/me.js
//
// GET /api/auth/me — who is signed in, and what this deployment can do.
//
// The page calls this on load to decide between the sign-in form and the app.
// It answers 200 with `user: null` rather than 401 for an anonymous visitor:
// "nobody is signed in" is a normal answer to this question, and a 401 here
// would put a scary error in the console on every first visit.

import { requireMethod } from '../integrations/http.js';
import { currentUser, authConfigured } from '../auth.js';
import { anyUserExists, storeBackend } from '../store.js';

export default async function handler(req, res) {
  if (!requireMethod(req, res, 'GET')) return;

  const configured = authConfigured();
  const store = storeBackend();
  const user = configured && store === 'firestore' ? await currentUser(req) : null;

  // `needsBootstrap` tells the page to offer first-account setup instead of a
  // sign-in form nobody can pass yet.
  let needsBootstrap = false;
  if (configured && store === 'firestore' && !user) {
    const any = await anyUserExists();
    needsBootstrap = any.ok && !any.any;
  }

  return res.status(200).json({
    ok: true,
    user,
    auth: {
      configured,
      // Named separately so the UI can say WHICH piece is missing rather than
      // "something is wrong".
      store,
      usable: configured && store === 'firestore',
      needsBootstrap,
    },
  });
}
