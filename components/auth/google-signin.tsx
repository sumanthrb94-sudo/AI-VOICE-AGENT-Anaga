'use client';

/* ===========================================================================
   The real Google Identity Services button.

   ── WHY THE CLIENT ID COMES OVER THE WIRE ────────────────────────────────
   It is fetched from /api/integrations/health, never hardcoded and never read
   from a NEXT_PUBLIC_ env var. Two reasons, and the second is the important
   one:

   1. A Google OAuth client id is PUBLIC by design. Google restricts it by
      authorised JavaScript ORIGIN, not by secrecy — a stolen client id is
      useless from any origin the owner has not listed. So there is nothing to
      protect here, which is exactly why the server publishes it.
   2. This frontend is a STATIC EXPORT. A NEXT_PUBLIC_ variable is substituted
      at BUILD time and frozen into the bundle, so the same artefact could not
      be promoted from preview to production — you would have to rebuild to
      change a value that is not even secret. Reading it at runtime means one
      build, any environment, and rotating the OAuth client is a redeploy of
      the API alone.

   ── WHY THE SCRIPT IS LOADED HERE AND NOT IN THE LAYOUT ──────────────────
   accounts.google.com/gsi/client in <head> would put a third-party request on
   every marketing page, for a button that exists on exactly one route.

   ── WHY THE BUTTON IS GOOGLE'S, NOT OURS ─────────────────────────────────
   Google's branding terms require their rendered button. We size and place it;
   we do not repaint it, and we never fake one that calls the same handler.
   =========================================================================== */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { CircleAlert, RefreshCw, ShieldOff } from 'lucide-react';
import {
  ApiError,
  explain,
  getHealth,
  signInWithGoogle,
  type SessionUser,
} from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/primitives';

/* ------------------------------------------------------- GIS, typed by hand */

interface GisCredentialResponse {
  credential?: string;
}

interface GisIdApi {
  initialize(config: {
    client_id: string;
    callback: (response: GisCredentialResponse) => void;
    auto_select?: boolean;
    cancel_on_tap_outside?: boolean;
    itp_support?: boolean;
    ux_mode?: 'popup' | 'redirect';
  }): void;
  renderButton(
    parent: HTMLElement,
    options: {
      type?: 'standard' | 'icon';
      theme?: 'outline' | 'filled_blue' | 'filled_black';
      size?: 'small' | 'medium' | 'large';
      text?: 'signin_with' | 'signup_with' | 'continue_with' | 'signin';
      shape?: 'rectangular' | 'pill' | 'circle' | 'square';
      logo_alignment?: 'left' | 'center';
      width?: number;
    },
  ): void;
  disableAutoSelect(): void;
}

declare global {
  interface Window {
    google?: { accounts?: { id?: GisIdApi } };
  }
}

const GIS_SRC = 'https://accounts.google.com/gsi/client';

/** Google's own limits for renderButton width. */
const MIN_W = 200;
const MAX_W = 400;

/**
 * Google's largest button is 40px tall. The house rule is a 44px touch floor,
 * and we may not restyle Google's markup — so the whole rendered button is
 * scaled uniformly instead, which keeps their proportions and logo intact.
 * 40 × 1.1 = 44.
 */
const SCALE = 1.1;

/**
 * One in-flight load, shared. Two components mounting at once must not append
 * two <script> tags, and a failed load must be retryable — hence clearing the
 * cached promise on rejection.
 */
let gisPromise: Promise<void> | null = null;

function loadGis(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('no_window'));
  if (window.google?.accounts?.id) return Promise.resolve();
  if (gisPromise) return gisPromise;

  const attempt = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GIS_SRC}"]`);
    const el = existing ?? document.createElement('script');

    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };

    // THREE WAYS THIS FAILS, and a blocked script must hit one of them:
    //   • the request is refused           → 'error' fires
    //   • the blocker returns an empty 200 → 'load' fires with no window.google
    //   • the request is black-holed       → neither fires, so: a timeout.
    // Without the third case an ad blocker leaves a spinner turning forever,
    // which tells the user nothing and blames nobody.
    const timer = window.setTimeout(() => finish(new Error('gis_timeout')), 12_000);

    el.addEventListener('load', () => {
      finish(window.google?.accounts?.id ? undefined : new Error('gis_unavailable'));
    });
    el.addEventListener('error', () => finish(new Error('gis_blocked')));

    if (!existing) {
      el.src = GIS_SRC;
      el.async = true;
      el.defer = true;
      document.head.appendChild(el);
    }
  });

  gisPromise = attempt.catch((err: unknown) => {
    gisPromise = null; // let Retry mean retry
    throw err;
  });
  return gisPromise;
}

/* ------------------------------------------------------------------ props */

export interface GoogleSignInProps {
  /**
   * From getHealth().signIn.clientId. Pass it when the caller has already
   * fetched health (the login page has, to render its preconditions) so the
   * endpoint is not hit twice; omit it and this component fetches its own.
   */
  clientId?: string | null;
  /** Where to go once the session cookie is set. */
  redirectTo?: string;
  onSignedIn?: (user: SessionUser) => void;
  /** Fired alongside the inline message, for callers that want to react. */
  onError?: (message: string) => void;
}

type Phase = 'preparing' | 'ready' | 'submitting' | 'done' | 'unavailable';

export function GoogleSignIn({
  clientId,
  redirectTo = '/console',
  onSignedIn,
  onError,
}: GoogleSignInProps) {
  const router = useRouter();
  const wrapRef = React.useRef<HTMLDivElement | null>(null);
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const drawnKey = React.useRef<string>('');

  const [phase, setPhase] = React.useState<Phase>('preparing');
  const [error, setError] = React.useState<string | null>(null);
  const [hint, setHint] = React.useState<string | null>(null);
  const [attempt, setAttempt] = React.useState(0);

  /* --- draw ------------------------------------------------------------- */

  const draw = React.useCallback(() => {
    const gis = window.google?.accounts?.id;
    const wrap = wrapRef.current;
    const host = hostRef.current;
    if (!gis || !wrap || !host) return;

    const box = wrap.getBoundingClientRect().width || 320;
    // floor, not round: the button is then scaled up by SCALE, and rounding up
    // first is how you get half a pixel of overflow at the widest size.
    const width = Math.floor(Math.min(MAX_W, Math.max(MIN_W, box / SCALE)));
    // The page theme is set on <html data-theme> before first paint. An
    // outline button on near-black reads as a grey rectangle; filled_black on
    // white reads as a hole.
    const dark = document.documentElement.getAttribute('data-theme') !== 'light';

    const key = `${width}:${dark}`;
    if (key === drawnKey.current) return; // ResizeObserver fires on observe()
    drawnKey.current = key;

    host.replaceChildren();
    gis.renderButton(host, {
      type: 'standard',
      theme: dark ? 'filled_black' : 'outline',
      size: 'large',
      text: 'signin_with',
      shape: 'rectangular',
      logo_alignment: 'left',
      width,
    });
  }, []);

  /* --- the credential comes back here ----------------------------------- */

  // Held in a ref so GIS — initialised once — always calls the current
  // closure rather than the one from first render.
  const onCredential = React.useCallback(
    async (response: GisCredentialResponse) => {
      const credential = response?.credential;
      if (!credential) {
        setError('Google did not return a sign-in token. Try again.');
        setPhase('ready');
        return;
      }

      setPhase('submitting');
      setError(null);
      setHint(null);

      try {
        const { user } = await signInWithGoogle(credential);
        setPhase('done');
        onSignedIn?.(user);
        // The Set-Cookie has already landed by the time this resolves, so a
        // client-side nav is enough — no full reload needed to "pick up" the
        // session, and no white flash.
        router.replace(redirectTo);
      } catch (err) {
        const message = explain(err);
        const code = err instanceof ApiError ? err.code : '';

        // THE DISTINCTION THAT MATTERS. A verified Google account that is not
        // on the allowlist is not a failed sign-in — the identity was proved.
        // Telling this person to "try again" would have them retype nothing,
        // repeatedly. The fix is somebody else's env var, so say so.
        setHint(
          code === 'not_authorized'
            ? 'The account signed in to Google correctly — it is simply not on this deployment’s admin list. An owner adds it to ADMIN_EMAILS; it works on the next attempt.'
            : code === 'account_disabled'
              ? 'An owner disabled this account. That decision overrides the admin list.'
              : null,
        );
        setError(message);
        setPhase('ready');
        onError?.(message);
        // Otherwise the next click silently re-submits the same rejected
        // account without ever showing the chooser.
        window.google?.accounts?.id?.disableAutoSelect();
      }
    },
    [onError, onSignedIn, redirectTo, router],
  );

  const handlerRef = React.useRef(onCredential);
  handlerRef.current = onCredential;

  /* --- config → script → button ----------------------------------------- */

  React.useEffect(() => {
    let alive = true;
    setPhase('preparing');
    setError(null);
    setHint(null);
    drawnKey.current = '';

    (async () => {
      let id = clientId ?? null;

      if (!id) {
        try {
          const health = await getHealth();
          id = health.signIn?.clientId ?? null;
        } catch (err) {
          if (!alive) return;
          setPhase('unavailable');
          setError(explain(err));
          setHint('The client id is read from /api/integrations/health at runtime, so the sign-in button cannot render until the API answers.');
          return;
        }
      }
      if (!alive) return;

      if (!id) {
        setPhase('unavailable');
        setError('Google sign-in is not configured on this deployment.');
        setHint('GOOGLE_CLIENT_ID is not set, so there is no OAuth client to sign in against.');
        return;
      }

      try {
        await loadGis();
      } catch {
        if (!alive) return;
        setPhase('unavailable');
        setError('Google’s sign-in script could not load.');
        setHint('Something is blocking accounts.google.com — usually an ad blocker, a privacy extension, or a network filter. Allow that host for this site and retry.');
        return;
      }
      if (!alive) return;

      const gis = window.google?.accounts?.id;
      if (!gis) {
        setPhase('unavailable');
        setError('Google’s sign-in script loaded but did not start.');
        setHint('A content blocker can serve an empty file in place of the real one. Allow accounts.google.com for this site and retry.');
        return;
      }

      gis.initialize({
        client_id: id,
        callback: (response) => void handlerRef.current(response),
        // No auto sign-in and no One Tap on this page. This is an admin
        // console: choosing an account should be deliberate, and a surprise
        // prompt on load is exactly the pattern people dismiss on reflex.
        auto_select: false,
        cancel_on_tap_outside: true,
        itp_support: true,
        ux_mode: 'popup',
      });

      setPhase('ready');
      // After paint, so the wrapper has a real measured width.
      requestAnimationFrame(() => {
        if (alive) draw();
      });
    })();

    return () => {
      alive = false;
    };
  }, [clientId, attempt, draw]);

  /* --- keep it the right size and the right theme ----------------------- */

  React.useEffect(() => {
    if (phase === 'preparing' || phase === 'unavailable') return;
    const wrap = wrapRef.current;
    if (!wrap) return;

    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => draw()) : null;
    ro?.observe(wrap);

    // The theme toggle rewrites <html data-theme> at runtime; the button has
    // to follow or it sits there in last session's colours.
    const mo = new MutationObserver(() => draw());
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    return () => {
      ro?.disconnect();
      mo.disconnect();
    };
  }, [phase, draw]);

  /* --- render ------------------------------------------------------------ */

  if (phase === 'unavailable') {
    return (
      <div className="space-y-4">
        <div
          role="alert"
          aria-live="assertive"
          className="flex gap-3 rounded-[var(--radius-md)] border border-[var(--color-line)] bg-[var(--color-elevated)] p-4"
        >
          <ShieldOff className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-warn)]" aria-hidden />
          <div className="min-w-0">
            <p className="text-[length:var(--text-sm)] font-medium text-[var(--color-text)]">{error}</p>
            {hint ? (
              <p className="mt-1.5 text-pretty text-[length:var(--text-sm)] leading-relaxed text-[var(--color-text-dim)]">
                {hint}
              </p>
            ) : null}
          </div>
        </div>
        <Button variant="secondary" className="w-full" onClick={() => setAttempt((n) => n + 1)}>
          <RefreshCw className="h-4 w-4" aria-hidden />
          Retry
        </Button>
      </div>
    );
  }

  const busy = phase === 'submitting' || phase === 'done';

  // NOTE the margins are per-child rather than a `space-y` on the parent: the
  // live region below is always mounted (a region present before its content
  // changes is announced far more reliably than one inserted with the message
  // already inside it), and a parent gap would give that empty div 12px of
  // height — a visible shift on every load, to reserve nothing.
  return (
    <div>
      {/* min-h reserves the button's exact box, so nothing below it moves when
          Google's markup lands. */}
      <div ref={wrapRef} className="relative min-h-12">
        {phase === 'preparing' ? (
          <Skeleton className="h-12 w-full" />
        ) : null}

        <div
          className={[
            'flex justify-center transition-opacity duration-200',
            phase === 'preparing' ? 'pointer-events-none absolute inset-0 opacity-0' : '',
            // A second click while the first credential is in flight would
            // open a second popup and a second POST.
            busy ? 'pointer-events-none opacity-50' : '',
          ].join(' ')}
        >
          <div
            ref={hostRef}
            style={{ transform: `scale(${SCALE})`, transformOrigin: 'center' }}
            aria-busy={busy || undefined}
          />
        </div>
      </div>

      {busy ? (
        <p aria-live="polite" className="mt-3 flex items-center justify-center gap-2 text-[length:var(--text-sm)] text-[var(--color-text-dim)]">
          <span
            aria-hidden
            className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
          />
          {phase === 'done' ? 'Signed in. Opening the console…' : 'Checking that account against the admin list…'}
        </p>
      ) : null}

      {/* One live region for sign-in failures. assertive because the person is
          waiting on this exact answer. */}
      <div role="alert" aria-live="assertive" className={error ? 'mt-3' : undefined}>
        {error ? (
          <div className="flex gap-2.5 rounded-[var(--radius-md)] border border-[var(--color-bad-500)]/40 bg-[var(--color-bad-500)]/10 p-3.5">
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-bad)]" aria-hidden />
            <div className="min-w-0">
              <p className="text-[length:var(--text-sm)] font-medium text-[var(--color-text)]">{error}</p>
              {hint ? (
                <p className="mt-1 text-pretty text-[length:var(--text-sm)] leading-relaxed text-[var(--color-text-dim)]">
                  {hint}
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
