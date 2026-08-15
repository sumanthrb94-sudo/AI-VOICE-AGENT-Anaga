'use client';

/* ===========================================================================
   "Can this deployment place a real call?" — and if not, exactly what to set.

   Two panels and a banner:
     ProvenanceBanner   where the numbers on this page came from
     ReadinessPanel     the verdict, and the blockers as an actionable list
     WiringPanel        the per-integration detail behind that verdict
   =========================================================================== */

import * as React from 'react';
import { ShieldCheck, ShieldAlert, Plug, CircleCheck, TriangleAlert } from 'lucide-react';
import { Badge } from '@/components/ui/primitives';
import { Panel, PanelHead, PanelBody, Note, Code, StatusRow, LoadingRows } from './panels';
import { blockerInfo, formatStamp, type StoreProvenance, type Wiring } from './types';

/* ------------------------------------------------------------ provenance */

/**
 * THE HONESTY BANNER.
 *
 * `store.durable === false` means every count on this page came from
 * api/_lib/events.js — a per-instance ring buffer that is emptied on cold
 * start and is NOT shared with a second concurrent instance. Showing those
 * numbers as if they were totals is precisely the failure this system exists
 * to avoid, so the banner is not dismissible and it is the first thing on the
 * page.
 */
export function ProvenanceBanner({ store }: { store: StoreProvenance }) {
  if (store.durable) {
    return (
      <Note tone="ok" title="Backed by the durable store">
        <p>
          Counts and calls below come from{' '}
          <Code>{store.backend}</Code>
          {store.projectId ? <> project <Code>{store.projectId}</Code></> : null}, holding{' '}
          <span className="tabular">{store.held}</span> events in this page&rsquo;s window.
          {store.reachable ? null : ' The store is currently unreachable, so this page may be stale.'}
        </p>
      </Note>
    );
  }

  return (
    <Note tone="warn" title="Live view, not history — these numbers are partial">
      <p>
        Every count on this page comes from an in-process ring buffer holding{' '}
        <span className="tabular">{store.held}</span> of{' '}
        <span className="tabular">{store.capacity}</span> events since this instance started{' '}
        {formatStamp(store.instanceStartedAt)}. It is emptied on cold start, and a second
        concurrent instance keeps its own — so this is not a total, it is what one machine
        happens to remember. Set <Code>FIREBASE_SERVICE_ACCOUNT</Code> for durable history.
      </p>
      {store.storeError ? (
        <p className="mt-1">
          The configured store reported: <Code>{store.storeError}</Code>
        </p>
      ) : null}
    </Note>
  );
}

/* -------------------------------------------------------------- readiness */

export function ReadinessPanel({ wiring }: { wiring: Wiring | null }) {
  return (
    <Panel aria-labelledby="readiness-h">
      <PanelHead
        id="readiness-h"
        icon={wiring && wiring.canDial ? ShieldCheck : ShieldAlert}
        title="Readiness"
        hint="Whether this deployment can lawfully place a call right now. The gate fails closed — unconfigured means no dial."
        action={
          wiring ? (
            <Badge tone={wiring.canDial ? 'ok' : 'bad'}>
              {wiring.canDial ? 'Ready to dial' : `${wiring.blockers.length} blocker${wiring.blockers.length === 1 ? '' : 's'}`}
            </Badge>
          ) : null
        }
      />
      <PanelBody>
        {!wiring ? (
          <LoadingRows rows={3} />
        ) : wiring.canDial ? (
          <Note tone="ok" title="Every gate dependency is configured">
            <p>
              Leads that clear compliance will be queued to the dialler. Blockers, if any appear,
              will be listed here with the environment variable that clears them.
            </p>
          </Note>
        ) : (
          <ol className="space-y-3">
            {wiring.blockers.map((code) => {
              const b = blockerInfo(code);
              return (
                <li
                  key={code}
                  className="rounded-[var(--radius-md)] border border-[var(--color-line)] bg-[var(--color-elevated)] p-4"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <TriangleAlert
                      aria-hidden
                      className={
                        b.kind === 'compliance'
                          ? 'h-4 w-4 shrink-0 text-[var(--color-bad)]'
                          : 'h-4 w-4 shrink-0 text-[var(--color-warn)]'
                      }
                    />
                    <p className="text-[length:var(--text-sm)] font-semibold text-[var(--color-text)]">
                      {b.title}
                    </p>
                    <Badge tone={b.kind === 'compliance' ? 'bad' : 'warn'}>
                      {b.kind === 'compliance' ? 'compliance' : 'wiring'}
                    </Badge>
                  </div>
                  <p className="mt-1.5 text-pretty text-[length:var(--text-xs)] leading-relaxed text-[var(--color-text-dim)]">
                    {b.fix}
                  </p>
                  {b.env.length ? (
                    <p className="mt-2 flex flex-wrap items-center gap-1.5">
                      <span className="text-[length:var(--text-xs)] text-[var(--color-text-faint)]">Set</span>
                      {b.env.map((e) => (
                        <Code key={e}>{e}</Code>
                      ))}
                    </p>
                  ) : null}
                  <p className="mt-2 text-[length:var(--text-xs)] text-[var(--color-text-faint)]">
                    Reported as <Code>{code}</Code>
                  </p>
                </li>
              );
            })}
          </ol>
        )}
      </PanelBody>
    </Panel>
  );
}

/* ----------------------------------------------------------------- wiring */

function State({ ok, label }: { ok: boolean; label: string }) {
  return (
    <Badge tone={ok ? 'ok' : 'warn'}>
      {ok ? <CircleCheck aria-hidden className="h-3 w-3" /> : <TriangleAlert aria-hidden className="h-3 w-3" />}
      {label}
    </Badge>
  );
}

export function WiringPanel({ wiring, store }: { wiring: Wiring | null; store: StoreProvenance | null }) {
  const rows: Array<{ name: string; ok: boolean; detail: React.ReactNode }> = React.useMemo(() => {
    if (!wiring) return [];
    const { meta, crm, compliance, dialQueue } = wiring;
    return [
      {
        name: 'Meta Lead Ads',
        ok: meta.appSecret && meta.pageAccessToken,
        detail: meta.appSecret
          ? meta.pageAccessToken
            ? `Graph ${meta.graphVersion}`
            : 'no page access token'
          : 'no app secret',
      },
      {
        name: 'CRM',
        ok: crm.configured && crm.provider !== 'none',
        detail: crm.provider,
      },
      {
        name: 'DND registry scrub',
        ok: compliance.dndScrub,
        detail: compliance.dndScrub ? 'configured' : 'unconfigured — every dial is blocked',
      },
      {
        name: 'Do-not-call register',
        ok: compliance.suppressionList,
        detail: compliance.suppressionList
          ? `durable · ${compliance.suppressionBackend}`
          : 'this instance only — opt-outs are lost on restart',
      },
      {
        name: 'Dial queue',
        ok: dialQueue.configured,
        detail: dialQueue.configured
          ? dialQueue.signed
            ? 'signed'
            : 'unsigned — set DIAL_QUEUE_SECRET'
          : 'no consumer — nothing dials',
      },
      {
        name: 'Compliance mode',
        ok: compliance.mode === 'strict',
        detail: compliance.mode === 'strict' ? 'strict' : 'dev — unverified checks pass',
      },
      {
        name: 'Calling window',
        ok: true,
        detail: `${compliance.callingWindowIST} IST`,
      },
      {
        name: 'Consent window',
        ok: true,
        detail: `${compliance.consentWindowDays} days`,
      },
      {
        name: 'Event store',
        ok: store ? store.durable : false,
        detail: store
          ? store.durable
            ? `${store.backend}${store.reachable ? '' : ' — unreachable'}`
            : 'in-process ring buffer'
          : '—',
      },
    ];
  }, [wiring, store]);

  return (
    <Panel aria-labelledby="wiring-h">
      <PanelHead
        id="wiring-h"
        icon={Plug}
        title="Wiring"
        hint="What each dependency reports about itself. Values are never returned by the API — only whether they are set."
      />
      <PanelBody>
        {!wiring ? (
          <LoadingRows rows={6} />
        ) : (
          <ul className="-my-1">
            {rows.map((r) => (
              <StatusRow
                key={r.name}
                state={<State ok={r.ok} label={r.ok ? 'ready' : 'todo'} />}
                name={r.name}
                detail={r.detail}
              />
            ))}
          </ul>
        )}
      </PanelBody>
    </Panel>
  );
}
