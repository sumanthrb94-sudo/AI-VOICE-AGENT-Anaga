// api/integrations/firestore-verify.js
//
// POST /api/integrations/firestore-verify
//
// A deployment-time certificate for the EXISTING Firestore connection. Health
// can prove that an account can authenticate and list collections; it cannot
// prove that the account may write call records or clean up afterwards. This
// endpoint performs one write-read-delete probe in the existing events
// collection and returns booleans only.
//
// It is intentionally authenticated with INTEGRATIONS_API_KEY. A public endpoint
// that writes a Firestore row on demand would be a cost and audit-log abuse path.

import { authorize, requireMethod } from '../_lib/integrations/http.js';
import { limited, log, requestId } from '../_lib/guard.js';
import { verifyStorePersistence } from '../_lib/store.js';

export default async function handler(req, res) {
  if (!requireMethod(req, res, 'POST')) return;
  if (limited(req, res, { bucket: 'firestore_verify', limit: Number(process.env.RATE_LIMIT_FIRESTORE_VERIFY || 5) })) return;

  const rid = requestId(req);
  const auth = authorize(req);
  if (!auth.ok) {
    log('firestore_verify_unauthorized', { rid, reason: auth.error });
    return res.status(auth.status).json({ error: auth.error });
  }

  const store = await verifyStorePersistence();
  log(store.verified ? 'FIRESTORE_PERSISTENCE_VERIFIED' : 'FIRESTORE_PERSISTENCE_FAILED', {
    rid,
    backend: store.backend,
    durable: store.durable === true,
    verified: store.verified === true,
    cleaned: store.cleaned === true,
    projectId: store.projectId || null,
    error: store.error || null,
  });

  const result = {
    ok: store.verified === true,
    store: {
      backend: store.backend,
      durable: store.durable === true,
      verified: store.verified === true,
      cleaned: store.cleaned === true,
      projectId: store.projectId || null,
      error: store.error || null,
    },
  };
  return res.status(result.ok ? 200 : 503).json(result);
}
