'use client';

/* ===========================================================================
   SessionGate — a CLIENT-SIDE UX guard.

   ┌───────────────────────────────────────────────────────────────────────┐
   │ THIS IS NOT THE SECURITY BOUNDARY. Do not treat it as one.            │
   │                                                                       │
   │ The frontend is `output: 'export'` — a static export. There is no     │
   │ middleware, no server component, no route handler, nothing that runs  │
   │ on a server before the HTML reaches the browser. Every byte of this   │
   │ file is downloaded and executed by whoever asks for it, signed in or  │
   │ not, and anyone can skip it with devtools.                            │
   │                                                                       │
   │ What it is FOR: a signed-out person who lands on /console gets sent   │
   │ to /login instead of staring at a dashboard whose every panel is a    │
   │ 401. That is a UX job, and it is the only job this component has.     │
   │                                                                       │
   │ The REAL boundary is server-side and is already built: every data     │
   │ endpoint calls `authorizeRead()` in api/_lib/integrations/http.js,    │
   │ which re-reads the session cookie AND re-reads the user's role from   │
   │ the store on every single request. Deleting this component would      │
   │ leak exactly nothing; the console would simply render empty panels.   │
   │                                                                       │
   │ Corollary for whoever adds a page later: never put a secret, a rate,  │
   │ a key or an unfiltered record in the bundle and rely on this gate to  │
   │ hide it. It hides nothing.                                            │
   └───────────────────────────────────────────────────────────────────────┘

   ── API (stable — the console is built against it) ───────────────────────

     <SessionGate>
       {(user) => <Dashboard user={user} />}
     </SessionGate>

     <SessionGate role="operator">
       {(user) => <DangerZone user={user} />}
     </SessionGate>

     const signOut = useSignOut();
     <Button onClick={signOut}>Sign out</Button>

   `children` is a render prop, not a node: the resolved SessionUser is only
   available after an async check, and a render prop makes that dependency
   impossible to forget. There is no context to read and no possibility of
   rendering a child before the user exists.

   States, in order of how often you will see them:
     checking → skeleton that reserves layout. No redirect yet: bouncing to
                /login before the answer arrives would log out every visitor
                on a slow connection.
     signed in → children(user)
     not signed in / 401 → router.replace('/login')
     below `role` → an explicit "your account is X, this needs Y" panel. NOT a
                redirect: sending an authenticated viewer to a login page they
                have already passed is a loop, and it misnames the problem.
     network error / 503 → inline retry. A dropped connection is NOT a logout
                and must never be shown as one.
   =========================================================================== */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Lock, RefreshCw, ShieldAlert, WifiOff } from 'lucide-react';
import {
  ApiError,
  explain,
  getMe,
  signOut as signOutRequest,
  type Role,
  type SessionUser,
} from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardBody, Skeleton } from '@/components/ui/primitives';

/** owner ⊇ operator ⊇ viewer — the same ranking the server enforces. */
const RANK: Record<Role, number> = { viewer: 1, operator: 2, owner: 3 };

type GateState =
  | { phase: 'checking' }
  | { phase: 'in'; user: SessionUser }
  | { phase: 'out' }
  | { phase: 'error'; message: string };

export interface SessionGateProps {
  /** Rendered only once a real session is confirmed. */
  children: (user: SessionUser) => React.ReactNode;
  /** Minimum role. Omit to accept any signed-in user. */
  role?: Role;
}

export function SessionGate({ children, role }: SessionGateProps): React.ReactElement {
  const router = useRouter();
  const [state, setState] = React.useState<GateState>({ phase: 'checking' });
  const [attempt, setAttempt] = React.useState(0);

  React.useEffect(() => {
    let alive = true;
    setState({ phase: 'checking' });

    (async () => {
      try {
        const res = await getMe();

        // A RESOLVED PROMISE IS NOT PROOF OF A SESSION. /api/auth/me answers
        // 200 with `user: null` for an anonymous visitor on purpose — "nobody
        // is signed in" is a normal answer to "who am I", and a 401 there
        // would put a red error in the console on every first visit. So the
        // user field decides, not the status code.
        const user = (res?.user ?? null) as SessionUser | null;
        if (!alive) return;
        setState(user ? { phase: 'in', user } : { phase: 'out' });
      } catch (err) {
        if (!alive) return;

        // An expired or missing session — the one case that redirects.
        if (err instanceof ApiError && (err.status === 401 || err.code === 'not_signed_in')) {
          setState({ phase: 'out' });
          return;
        }

        // Everything else: a dropped connection, or a 503 from a deployment
        // missing SESSION_SECRET / FIREBASE_SERVICE_ACCOUNT. None of those
        // mean "you are logged out", and redirecting on them would send
        // somebody to a login page that cannot possibly work — or bounce them
        // between /console and /login forever.
        setState({ phase: 'error', message: explain(err) });
      }
    })();

    return () => {
      alive = false;
    };
  }, [attempt]);

  // Navigation is a side effect, so it belongs here rather than in render.
  React.useEffect(() => {
    if (state.phase === 'out') router.replace('/login');
  }, [state.phase, router]);

  if (state.phase === 'checking') {
    return <GateSkeleton label="Checking your session…" />;
  }

  if (state.phase === 'out') {
    // The replace() above is already in flight. Keep the skeleton rather than
    // flashing an empty page or, worse, a "signed out" message that is gone
    // again in 80ms.
    return <GateSkeleton label="Taking you to sign-in…" />;
  }

  if (state.phase === 'error') {
    return (
      <GatePanel
        icon={<WifiOff className="h-5 w-5" aria-hidden />}
        title="Could not check your session"
        body={state.message}
        action={
          <Button variant="secondary" onClick={() => setAttempt((n) => n + 1)}>
            <RefreshCw className="h-4 w-4" aria-hidden />
            Try again
          </Button>
        }
      />
    );
  }

  if (role && RANK[state.user.role] < RANK[role]) {
    return (
      <GatePanel
        icon={<ShieldAlert className="h-5 w-5" aria-hidden />}
        title="Your account cannot open this"
        body={`You are signed in as ${state.user.role}. This needs ${role} or higher. An owner can change your role in ADMIN_EMAILS; it takes effect the next time you sign in.`}
        action={<SignOutButton />}
      />
    );
  }

  return <>{children(state.user)}</>;
}

/**
 * Sign out, then land on /login.
 *
 * The cookie is httpOnly, so only the server can clear it — this is a real
 * request, not a localStorage wipe. A failed request still navigates: the
 * person asked to leave, and stranding them on a console they no longer trust
 * is the worse outcome. The cookie is short-lived and the server re-checks it
 * on every request either way.
 */
export function useSignOut(): () => Promise<void> {
  const router = useRouter();
  return React.useCallback(async () => {
    try {
      await signOutRequest();
    } catch {
      /* Clearing a session that is already gone is not an error a human needs. */
    }
    router.replace('/login');
  }, [router]);
}

/* ------------------------------------------------------------------ pieces */

function SignOutButton() {
  const signOut = useSignOut();
  const [busy, setBusy] = React.useState(false);
  return (
    <Button
      variant="secondary"
      loading={busy}
      onClick={() => {
        setBusy(true);
        void signOut();
      }}
    >
      <Lock className="h-4 w-4" aria-hidden />
      Sign in as someone else
    </Button>
  );
}

/**
 * Reserves roughly the shape of a console page so the layout does not lurch
 * when the real thing lands. aria-busy + a live label so a screen reader is
 * told that something is happening rather than reading an empty document.
 */
function GateSkeleton({ label }: { label: string }) {
  return (
    <div
      aria-busy="true"
      aria-live="polite"
      className="mx-auto w-full max-w-6xl px-5 py-10 sm:px-8"
    >
      <span className="sr-only">{label}</span>
      <Skeleton className="h-7 w-44" />
      <Skeleton className="mt-3 h-4 w-64" />
      <div className="mt-8 grid gap-4 sm:grid-cols-3">
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
      </div>
      <Skeleton className="mt-4 h-64 w-full" />
    </div>
  );
}

function GatePanel({
  icon,
  title,
  body,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mx-auto grid w-full max-w-6xl place-items-center px-5 py-16 sm:px-8">
      <Card className="w-full max-w-md">
        <CardBody>
          {/* role="alert" + aria-live: this replaces a whole page of content,
              so it must be announced, not silently swapped in. */}
          <div role="alert" aria-live="polite" className="flex gap-3">
            <span className="mt-0.5 shrink-0 text-[var(--color-warn)]">{icon}</span>
            <div className="min-w-0">
              <h2 className="text-[length:var(--text-base)] font-semibold text-[var(--color-text)]">
                {title}
              </h2>
              <p className="mt-1.5 text-pretty text-[length:var(--text-sm)] leading-relaxed text-[var(--color-text-dim)]">
                {body}
              </p>
            </div>
          </div>
          {action ? <div className="mt-5">{action}</div> : null}
        </CardBody>
      </Card>
    </div>
  );
}
