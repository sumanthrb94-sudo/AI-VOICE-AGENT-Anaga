// api/_lib/routes/auth-agent-token.js
//
// GET /api/auth/agent-token — a ticket to open ONE call socket.
//
// Vercel knows who is signed in; Cloud Run does not, and cannot, because the
// session cookie is host-only and the agent is a different origin. So the
// browser asks here and carries the answer there. See shared/agent-token.js
// for why this is not a session and not an authorisation decision about
// anything except "may open a socket".

import { requireMethod } from '../integrations/http.js';
import { limited, log, requestId } from '../guard.js';
import { currentUser, hasRole } from '../auth.js';
import { mintAgentToken, agentTokenConfigured } from '../../../shared/agent-token.js';

export default async function handler(req, res) {
  if (!requireMethod(req, res, 'GET')) return;

  // NOT CONFIGURED IS NOT AUTHORISED. Returning something the agent will not
  // check would be worse than returning nothing: the page would appear to be
  // protected while the socket stayed open to the world.
  if (!agentTokenConfigured()) {
    return res.status(503).json({
      error: 'agent_token_not_configured',
      detail: 'Set AGENT_TOKEN_SECRET here and on the agent. Until both have it, '
            + 'the socket is open to anyone who knows the URL.',
    });
  }

  let user = null;
  try { user = await currentUser(req); } catch { user = null; }
  if (!user) return res.status(401).json({ error: 'not_signed_in' });

  // `demo` is the floor: holding a call is the whole reason that role exists.
  if (!hasRole(user, 'demo')) return res.status(403).json({ error: 'forbidden', need: 'demo' });

  // A token is cheap to mint and a call is not. This bounds how fast one
  // account can start calls, which is the spend this whole mechanism exists to
  // control — an authenticated abuser is still an abuser.
  if (limited(req, res, { bucket: 'agent_token', limit: Number(process.env.RATE_LIMIT_AGENT_TOKEN || 30) })) return;

  const token = mintAgentToken(user);
  log('agent_token_minted', { rid: requestId(req), role: user.role });

  // Never cached. It is a bearer credential with a short life, and a proxy
  // holding one would hand it to the next person through.
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ token, expiresInMs: 5 * 60 * 1000 });
}
