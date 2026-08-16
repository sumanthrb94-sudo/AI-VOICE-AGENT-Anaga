'use client';

/* ===========================================================================
   The operator console.

   One request drives the whole page: GET /api/console/summary. It returns the
   wiring status, the funnel rollup, the event stream, the finished calls and —
   the field this page is built around — `store`, which says whether any of
   those numbers are durable.

   Three things this component will not do:

   1. Render a number the API did not return. No seeded rows, no demo history,
      no placeholder chart. Empty means empty, and every empty state names the
      request that would fill it.
   2. Imply durability the backend does not have. `store.durable === false` is
      a banner, not a footnote.
   3. Poll a dead session. A 401 stops the timer instead of hammering the API
      every fifteen seconds from a tab nobody is looking at.
   =========================================================================== */

import * as React from 'react';
import { RefreshCw, LogOut, UserRound, Radio } from 'lucide-react';
import { getConsoleSummary, explain, ApiError, type SessionUser } from '@/lib/api';
import { Badge, Dot } from '@/components/ui/primitives';
import { Button } from '@/components/ui/button';
import { useSignOut } from '@/components/auth/session-gate';
import { Note } from './panels';
import { ProvenanceBanner, ReadinessPanel, WiringPanel } from './readiness';
import { CompliancePanel } from './compliance';
import { FunnelPanel } from './funnel';
import { CallsPanel } from './calls';
import { DemoCallsPanel } from './demo-calls';
import { EventsPanel } from './events';
import { formatClock, type ConsoleSummary } from './types';

const POLL_MS = 15_000;
const EVENT_LIMIT = 60;

type Status = 'loading' | 'ready' | 'refreshing' | 'error';

export function Dashboard({ user }: { user: SessionUser }) {
  const [data, setData] = React.useState<ConsoleSummary | null>(null);
  const [status, setStatus] = React.useState<Status>('loading');
  const [error, setError] = React.useState<string | null>(null);
  // A session that has ended, or a deployment whose auth is not configured,
  // will not start working because we asked it again in fifteen seconds.
  const [halted, setHalted] = React.useState(false);

  const signOut = useSignOut();
  const [signingOut, setSigningOut] = React.useState(false);

  const load = React.useCallback(async () => {
    setStatus((s) => (s === 'loading' ? 'loading' : 'refreshing'));
    try {
      // lib/api.ts returns Record<string, unknown> on purpose — it will not
      // assert a shape it cannot verify. ./types.tsx is where that assertion
      // is made, once, against the field names in api/console/summary.js.
      const raw = (await getConsoleSummary(EVENT_LIMIT)) as unknown as ConsoleSummary;
      setData(raw);
      setError(null);
      setStatus('ready');
    } catch (err) {
      setError(explain(err));
      setStatus('error');
      if (err instanceof ApiError && (err.status === 401 || err.status === 403 || err.status === 503)) {
        setHalted(true);
      }
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  React.useEffect(() => {
    if (halted) return;
    const tick = () => {
      // Refreshing a hidden tab burns an operator's rate limit for nobody.
      if (document.visibilityState === 'visible') void load();
    };
    const id = window.setInterval(tick, POLL_MS);
    return () => window.clearInterval(id);
  }, [load, halted]);

  const freshness =
    status === 'error'
      ? error || 'Could not refresh.'
      : status === 'loading'
        ? 'Loading…'
        : status === 'refreshing'
          ? 'Refreshing…'
          : data
            ? `Updated ${formatClock(data.generatedAt)}`
            : '';

  return (
    <div className="min-h-screen bg-[var(--color-bg)]">
      {/* ------------------------------------------------------------ header */}
      <header className="sticky top-0 z-40 border-b border-[var(--color-line)] bg-[var(--color-surface)]">
        <div className="mx-auto flex w-full max-w-[90rem] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-6 lg:px-8">
          <div className="flex min-w-0 items-center gap-2">
            <Radio aria-hidden className="h-4 w-4 shrink-0 text-[var(--color-accent)]" />
            <p className="text-[length:var(--text-sm)] font-semibold tracking-[-0.01em]">
              Anaga console
            </p>
          </div>

          {/* Freshness is the one thing on this page that changes by itself, so
              it is the one thing announced. */}
          <p
            aria-live="polite"
            className="flex items-center gap-1.5 text-[length:var(--text-xs)] text-[var(--color-text-dim)]"
          >
            <Dot tone={status === 'error' ? 'bad' : status === 'ready' ? 'ok' : 'neutral'} />
            <span className="tabular">{freshness}</span>
          </p>

          <div className="ml-auto flex flex-wrap items-center gap-2">
            <span className="flex min-w-0 items-center gap-2 text-[length:var(--text-xs)]">
              <UserRound aria-hidden className="h-3.5 w-3.5 shrink-0 text-[var(--color-text-dim)]" />
              <span className="min-w-0">
                <span className="block truncate text-[var(--color-text)]">{user.name || user.email}</span>
                {/* The address is confirmation, not identity — it is the first
                    thing to go when the header has to wrap on a phone. */}
                <span className="hidden truncate text-[var(--color-text-dim)] sm:block">{user.email}</span>
              </span>
              <Badge tone={user.role === 'owner' ? 'brand' : 'neutral'}>{user.role}</Badge>
            </span>

            {/* 44px, not the 36px table size: these are tapped on a phone. */}
            <Button
              variant="secondary"
              size="md"
              className="px-3"
              onClick={() => void load()}
              loading={status === 'refreshing' || status === 'loading'}
              aria-label="Refresh the console"
            >
              <RefreshCw aria-hidden className="h-3.5 w-3.5" />
              Refresh
            </Button>

            <Button
              variant="ghost"
              size="md"
              className="px-3"
              loading={signingOut}
              onClick={() => {
                setSigningOut(true);
                void signOut().finally(() => setSigningOut(false));
              }}
            >
              <LogOut aria-hidden className="h-3.5 w-3.5" />
              Sign out
            </Button>
          </div>
        </div>
      </header>

      {/* -------------------------------------------------------------- body */}
      <main id="main" className="mx-auto w-full max-w-[90rem] space-y-4 px-4 py-5 sm:px-6 sm:py-6 lg:px-8">
        {/* An error that stopped the page, stated where it happened. */}
        {status === 'error' ? (
          <Note tone="bad" title={halted ? 'This console has stopped refreshing' : 'Could not reach the console API'}>
            <p>{error}</p>
            {halted ? (
              <p className="mt-1">
                Nothing below will update until this is resolved. Anything still on screen is from
                the last successful read.
              </p>
            ) : null}
          </Note>
        ) : null}

        {/* WHERE THE NUMBERS CAME FROM — first, always, and never dismissible. */}
        {data ? (
          <ProvenanceBanner store={data.store} />
        ) : status !== 'error' ? (
          <div aria-hidden className="h-20 animate-pulse rounded-[var(--radius-md)] bg-[var(--color-surface)]" />
        ) : null}

        <ReadinessPanel wiring={data?.wiring ?? null} />

        <div className="grid gap-4 lg:grid-cols-12">
          {/* Compliance is first in reading order and first in the DOM. For a
              regulated outbound dialler it is the panel, not a footnote. */}
          <div className="lg:col-span-5">
            <CompliancePanel
              funnel={data?.funnel ?? null}
              wiring={data?.wiring ?? null}
              calls={data?.calls ?? null}
              store={data?.store ?? null}
            />
          </div>
          <div className="lg:col-span-7">
            <FunnelPanel funnel={data?.funnel ?? null} />
          </div>
        </div>

        <CallsPanel calls={data?.calls ?? null} store={data?.store ?? null} />

        {/* Browser demos, kept out of the lead pipeline above: they have no
            number, no compliance verdict and no CRM record, and counting them
            in the funnel would report conversations that were never leads. */}
        <DemoCallsPanel />

        <div className="grid gap-4 lg:grid-cols-12">
          <div className="lg:col-span-7">
            <EventsPanel events={data?.events ?? null} />
          </div>
          <div className="lg:col-span-5">
            <WiringPanel wiring={data?.wiring ?? null} store={data?.store ?? null} />
          </div>
        </div>

        <p className="pb-4 text-pretty text-[length:var(--text-xs)] leading-relaxed text-[var(--color-text-dim)]">
          Anaga qualifies leads and books site visits. She does not close — every booked visit is
          handed to a human. Phone numbers are masked by the API and are never unmasked in this
          console.
        </p>
      </main>
    </div>
  );
}
