'use client';

/* ===========================================================================
   /console — the operator surface.

   STATIC EXPORT. There is no server component doing a request-time fetch here
   and there cannot be: next.config.ts sets `output: 'export'`, so this page is
   HTML on a CDN and every byte of data below is fetched in the browser with
   the session cookie.

   Auth is not this file's job. SessionGate resolves the session, handles the
   401, and hands down a user that is already known to hold at least `viewer` —
   so nothing underneath has to ask "am I allowed to render this?".
   =========================================================================== */

import { SessionGate } from '@/components/auth/session-gate';
import { Dashboard } from '@/components/console/dashboard';

export default function ConsolePage() {
  return <SessionGate role="viewer">{(user) => <Dashboard user={user} />}</SessionGate>;
}
