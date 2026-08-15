'use client';

/* ===========================================================================
   /login

   The sign-in form is the easy half. THE PRECONDITIONS ARE THE POINT.

   Four separate environment variables have to be set before anybody can sign
   in, they are set by four different people at four different times, and each
   one fails in a way that looks like a different problem from this page: a
   button that never appears, a 503, a 403, a spinner. Guessing which of the
   four is missing from the symptom is how an afternoon disappears.

   /api/integrations/health already reports all four — publicly and without
   leaking anything, because a boolean "SESSION_SECRET is set" tells an
   attacker nothing and the allowlist is reported as a COUNT, never as
   addresses. So this page asks, and when something is missing it names the
   variable and the fix instead of rendering a Google button that cannot work.

   ── A CLIENT COMPONENT, DELIBERATELY ─────────────────────────────────────
   Static export: there is no server to ask "is this person signed in?" before
   the HTML is sent. Everything here runs in the browser. No `metadata` export
   is possible from a client component, so the tab title is set below.
   =========================================================================== */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  AudioLines,
  CircleX,
  Database,
  KeyRound,
  RefreshCw,
  ShieldCheck,
  Users,
  WifiOff,
} from 'lucide-react';
import { explain, getHealth, getMe, type SessionUser, type SignInStatus } from '@/lib/api';
import { GoogleSignIn } from '@/components/auth/google-signin';
import { Button } from '@/components/ui/button';
import { Badge, Card, CardBody, Skeleton } from '@/components/ui/primitives';

const CONSOLE_PATH = '/console';

/* --------------------------------------------------------- preconditions */

interface Blocker {
  env: string;
  icon: React.ReactNode;
  breaks: string;
  fix: string;
  example?: string;
}

/**
 * Each false in `signIn` is a DIFFERENT missing variable with a DIFFERENT fix.
 * Listed in the order the server checks them, so the first row is the first
 * thing to go and do.
 */
function blockersFor(s: SignInStatus): Blocker[] {
  const out: Blocker[] = [];

  if (!s.session) {
    out.push({
      env: 'SESSION_SECRET',
      icon: <KeyRound className="h-4 w-4" aria-hidden />,
      breaks: 'Every sign-in returns 503. The server refuses to issue a session rather than sign one with a missing or short secret — a guessable secret lets anyone mint themselves an owner session.',
      fix: 'Set it to 32 or more random characters.',
      example: 'openssl rand -base64 48',
    });
  }

  if (!s.google || !s.clientId) {
    out.push({
      env: 'GOOGLE_CLIENT_ID',
      icon: <ShieldCheck className="h-4 w-4" aria-hidden />,
      breaks: 'There is no OAuth client to sign in against, so the Google button cannot render and the endpoint returns 503 rather than accepting anything.',
      fix: 'Google Cloud Console → Credentials → Create OAuth client ID → Web application. Add this exact origin under Authorised JavaScript origins — Google matches scheme, host and port literally. No redirect URI is needed.',
      example: typeof window === 'undefined' ? 'https://your-deployment' : window.location.origin,
    });
  }

  if (!s.store) {
    out.push({
      env: 'FIREBASE_SERVICE_ACCOUNT',
      icon: <Database className="h-4 w-4" aria-hidden />,
      breaks: 'Sign-in returns 503. A session is stateless but the role is re-read from the user record on every request, so without a durable store there is nowhere to keep the account.',
      fix: 'Paste the service-account JSON as a single line. Server-side environment only — never in the repo, never a NEXT_PUBLIC_ variable.',
    });
  }

  if (!s.admins) {
    out.push({
      env: 'ADMIN_EMAILS',
      icon: <Users className="h-4 w-4" aria-hidden />,
      breaks: 'Nobody can sign in. This is an allowlist, not a filter applied afterwards: an address that is not named here never gets an account at all, so every Google sign-in returns 403.',
      fix: 'Comma-separated, with an optional role after the colon (operator if omitted, never owner).',
      example: 'you@example.com:owner,ops@example.com:operator',
    });
  }

  return out;
}

/* -------------------------------------------------------------- the page */

type Session = 'checking' | 'anonymous' | 'signed-in';
type HealthState =
  | { phase: 'checking' }
  | { phase: 'ok'; signIn: SignInStatus }
  | { phase: 'unreported' }
  | { phase: 'error'; message: string };

export default function LoginPage() {
  const router = useRouter();
  const [session, setSession] = React.useState<Session>('checking');
  const [who, setWho] = React.useState<SessionUser | null>(null);
  const [health, setHealth] = React.useState<HealthState>({ phase: 'checking' });
  const [attempt, setAttempt] = React.useState(0);

  React.useEffect(() => {
    document.title = 'Sign in · Anaga';
  }, []);

  // Both requests start together: the health check is what decides what to
  // render, and waiting for it serially behind /auth/me would double the time
  // this page spends as a skeleton.
  React.useEffect(() => {
    let alive = true;
    setHealth({ phase: 'checking' });

    (async () => {
      try {
        const res = await getHealth();
        if (!alive) return;
        const signIn = res.signIn;
        setHealth(signIn ? { phase: 'ok', signIn } : { phase: 'unreported' });
      } catch (err) {
        if (!alive) return;
        setHealth({ phase: 'error', message: explain(err) });
      }
    })();

    (async () => {
      try {
        const res = await getMe();
        // /api/auth/me answers 200 with `user: null` for an anonymous visitor,
        // so a resolved promise is not a session. The user field is.
        const user = (res?.user ?? null) as SessionUser | null;
        if (!alive) return;
        if (user) {
          setWho(user);
          setSession('signed-in');
          router.replace(CONSOLE_PATH);
        } else {
          setSession('anonymous');
        }
      } catch {
        // Not signed in, or the API is unreachable. Either way this page is
        // where you belong; the health panel below reports the real problem.
        if (alive) setSession('anonymous');
      }
    })();

    return () => {
      alive = false;
    };
  }, [attempt, router]);

  const recheck = () => setAttempt((n) => n + 1);

  return (
    <main id="main" className="grid min-h-dvh place-items-center px-5 py-12 sm:px-6 sm:py-16">
      <div className="w-full max-w-md">
        {/* -------------------------------------------------------- brand */}
        <div className="mb-8 flex items-center gap-3">
          <span
            aria-hidden
            className="grid h-11 w-11 shrink-0 place-items-center rounded-[var(--radius-md)] bg-[var(--color-accent-fill)] text-[var(--color-on-accent)]"
          >
            <AudioLines className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <p className="text-[length:var(--text-lg)] font-semibold leading-tight tracking-[-0.01em]">
              Anaga
            </p>
            <p className="text-[length:var(--text-xs)] text-[var(--color-text-dim)]">
              Operations console · Modcon Builders
            </p>
          </div>
        </div>

        <Card>
          <CardBody className="space-y-6">
            <div>
              <h1 className="text-[length:var(--text-xl)] font-semibold leading-tight tracking-[-0.02em]">
                Sign in
              </h1>
              <p className="mt-2 text-pretty text-[length:var(--text-sm)] leading-relaxed text-[var(--color-text-dim)]">
                The console is limited to the admin allowlist. Use the Google account
                that is on it — there is no password to remember and none to leak.
              </p>
            </div>

            {/* The async area reserves EXACTLY the ready state's height — one
                button box — so the overwhelmingly common path (everything is
                configured) lands with nothing moving. Reserving the tallest
                state instead would leave a hole under the button on every
                healthy deployment, which is the same bug pointing the other
                way. The blocker list is longer and does grow the card; that is
                a real content change on a path you hit once. */}
            <div className="min-h-12">
              {session === 'checking' ? (
                <div aria-live="polite" aria-busy="true">
                  <span className="sr-only">Checking whether you are already signed in…</span>
                  <Skeleton className="h-12 w-full" />
                </div>
              ) : session === 'signed-in' ? (
                <p
                  aria-live="polite"
                  className="flex items-center gap-2 text-[length:var(--text-sm)] text-[var(--color-text-dim)]"
                >
                  <span
                    aria-hidden
                    className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
                  />
                  {who ? `Already signed in as ${who.email}. Opening the console…` : 'Already signed in. Opening the console…'}
                </p>
              ) : (
                <HealthArea state={health} onRetry={recheck} />
              )}
            </div>
          </CardBody>
        </Card>

        {/* --------------------------------------------------------- note */}
        <p className="mt-6 text-pretty text-[length:var(--text-xs)] leading-relaxed text-[var(--color-text-dim)]">
          Signing in sets an httpOnly session cookie that JavaScript cannot read, on
          this origin only. Your role is re-read on the server for every request, so
          removing an address from the allowlist takes effect immediately.
        </p>
      </div>
    </main>
  );
}

/* --------------------------------------------------------------- pieces */

function HealthArea({ state, onRetry }: { state: HealthState; onRetry: () => void }) {
  if (state.phase === 'checking') {
    return (
      <div aria-live="polite" aria-busy="true">
        <span className="sr-only">Checking whether this deployment can sign anybody in…</span>
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }

  // A health check that cannot be reached is NOT "Google is broken" and must
  // not render a button that would fail confusingly a second later.
  if (state.phase === 'error') {
    return (
      <Notice
        tone="warn"
        icon={<WifiOff className="h-5 w-5" aria-hidden />}
        title={state.message}
        body="The sign-in button is not shown until the API confirms it can work — a button that cannot succeed is worse than no button."
        action={
          <Button variant="secondary" className="w-full" onClick={onRetry}>
            <RefreshCw className="h-4 w-4" aria-hidden />
            Try again
          </Button>
        }
      />
    );
  }

  if (state.phase === 'unreported') {
    return (
      <Notice
        tone="warn"
        icon={<WifiOff className="h-5 w-5" aria-hidden />}
        title="This deployment does not report its sign-in status"
        body="The API answered but without a signIn block, which means it is older than the admin sign-in work. Deploy the current api/ before signing in."
        action={
          <Button variant="secondary" className="w-full" onClick={onRetry}>
            <RefreshCw className="h-4 w-4" aria-hidden />
            Check again
          </Button>
        }
      />
    );
  }

  const blockers = blockersFor(state.signIn);
  if (blockers.length > 0) return <Blocked blockers={blockers} onRetry={onRetry} />;

  return <GoogleSignIn clientId={state.signIn.clientId} redirectTo={CONSOLE_PATH} />;
}

function Blocked({ blockers, onRetry }: { blockers: Blocker[]; onRetry: () => void }) {
  return (
    <div className="space-y-4" role="alert" aria-live="polite">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="bad">
          <CircleX className="h-3 w-3" aria-hidden />
          {blockers.length} of 4 missing
        </Badge>
        <p className="text-[length:var(--text-sm)] font-medium text-[var(--color-text)]">
          Nobody can sign in yet
        </p>
      </div>

      <p className="text-pretty text-[length:var(--text-sm)] leading-relaxed text-[var(--color-text-dim)]">
        These are server-side environment variables. Set them where the API runs, then
        redeploy — the browser cannot fix any of them.
      </p>

      <ul className="space-y-3">
        {blockers.map((b) => (
          <li
            key={b.env}
            className="rounded-[var(--radius-md)] border border-[var(--color-line)] bg-[var(--color-elevated)] p-4"
          >
            <div className="flex items-center gap-2 text-[var(--color-bad)]">
              {b.icon}
              <code className="text-[length:var(--text-sm)] font-semibold tracking-tight text-[var(--color-text)]">
                {b.env}
              </code>
              <span className="text-[length:var(--text-xs)] text-[var(--color-text-dim)]">not set</span>
            </div>
            <p className="mt-2 text-pretty text-[length:var(--text-sm)] leading-relaxed text-[var(--color-text-dim)]">
              {b.breaks}
            </p>
            <p className="mt-2 text-pretty text-[length:var(--text-sm)] leading-relaxed text-[var(--color-text)]">
              {b.fix}
            </p>
            {b.example ? (
              <pre className="mt-2 overflow-x-auto rounded-[var(--radius-sm)] border border-[var(--color-line-soft)] bg-[var(--color-bg)] px-3 py-2 text-[length:var(--text-xs)] text-[var(--color-text-dim)]">
                <code>{b.example}</code>
              </pre>
            ) : null}
          </li>
        ))}
      </ul>

      {/* text-dim, not text-faint: --color-text-faint measures ~3.3:1 against
          --color-bg, which is under the 4.5:1 floor this project sets. Nothing
          a person is expected to read uses it. */}
      <p className="text-pretty text-[length:var(--text-xs)] leading-relaxed text-[var(--color-text-dim)]">
        The full walkthrough, including how to create the OAuth client, is in{' '}
        <code className="text-[var(--color-text)]">docs/ADMIN_SIGNIN_SETUP.md</code>. The live
        values are at{' '}
        <a
          className="text-[var(--color-accent)] underline-offset-4 hover:underline"
          href="/api/integrations/health"
        >
          /api/integrations/health
        </a>
        , which reports the allowlist as a count and never as addresses.
      </p>

      <Button variant="secondary" className="w-full" onClick={onRetry}>
        <RefreshCw className="h-4 w-4" aria-hidden />
        Check again
      </Button>
    </div>
  );
}

function Notice({
  tone,
  icon,
  title,
  body,
  action,
}: {
  tone: 'warn' | 'bad';
  icon: React.ReactNode;
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  const accent = tone === 'bad' ? 'text-[var(--color-bad)]' : 'text-[var(--color-warn)]';
  return (
    <div className="space-y-4">
      <div
        role="alert"
        aria-live="assertive"
        className="flex gap-3 rounded-[var(--radius-md)] border border-[var(--color-line)] bg-[var(--color-elevated)] p-4"
      >
        <span className={`mt-0.5 shrink-0 ${accent}`}>{icon}</span>
        <div className="min-w-0">
          <p className="text-[length:var(--text-sm)] font-medium text-[var(--color-text)]">{title}</p>
          <p className="mt-1.5 text-pretty text-[length:var(--text-sm)] leading-relaxed text-[var(--color-text-dim)]">
            {body}
          </p>
        </div>
      </div>
      {action}
    </div>
  );
}
