'use client';

/* ===========================================================================
   COMPLIANCE — the primary panel on this page.

   For an outbound dialler under Indian telecom regulation, "how many did we
   book" is the second question. The first is "did we call anybody we were not
   allowed to call, and is every opt-out we took actually going to hold?"

   Everything here is derived from fields the API really returns:
     funnel.counts.optOut          lead.optout + call.completed(opt-out) events
     funnel.counts.blocked         dials the gate refused
     funnel.blockReasons           why, per reason
     wiring.compliance             mode, scrub, register backend, windows
     calls[].optOut                the terminal flag on a finished call

   What is NOT here, deliberately: the contents of the do-not-call register.
   /api/console/summary does not expose it, and this console does not guess.
   =========================================================================== */

import * as React from 'react';
import { ShieldAlert, Ban, PhoneOff, Clock } from 'lucide-react';
import { Badge } from '@/components/ui/primitives';
import { Panel, PanelHead, PanelBody, Note, Code, EmptyState, LoadingRows, Stat } from './panels';
import {
  humanReason, reasonIsTerminal, isOptOut,
  type CallView, type Funnel, type StoreProvenance, type Wiring,
} from './types';

export function CompliancePanel({
  funnel, wiring, calls, store,
}: {
  funnel: Funnel | null;
  wiring: Wiring | null;
  calls: CallView[] | null;
  store: StoreProvenance | null;
}) {
  const reasons = React.useMemo(() => {
    if (!funnel) return [];
    return Object.entries(funnel.blockReasons).sort((a, b) => b[1] - a[1]);
  }, [funnel]);

  // Opt-outs visible two ways: as events counted in the rollup, and as the
  // terminal flag on the finished calls this page is holding. They can differ —
  // the calls list is the durable store, the count is the event window — so the
  // panel shows both rather than picking one and calling it the truth.
  const optOutCalls = React.useMemo(() => (calls || []).filter((c) => isOptOut(c)), [calls]);

  const durableRegister = wiring?.compliance.suppressionList === true;

  return (
    <Panel aria-labelledby="compliance-h" className="border-[var(--color-line)]">
      <PanelHead
        id="compliance-h"
        icon={ShieldAlert}
        title="Compliance"
        hint="Opt-outs, and every dial the gate refused. An opt-out is terminal — it overrides whatever the agent reported."
        action={
          wiring ? (
            <Badge tone={wiring.compliance.mode === 'strict' ? 'ok' : 'bad'}>
              {wiring.compliance.mode === 'strict' ? 'strict mode' : 'DEV MODE'}
            </Badge>
          ) : null
        }
      />

      <PanelBody className="space-y-5">
        {!funnel || !wiring ? (
          <LoadingRows rows={5} />
        ) : (
          <>
            {/* The one thing that must be loud if it is wrong. */}
            {durableRegister ? null : (
              <Note tone="bad" title="Opt-outs are not being kept">
                <p>
                  There is no durable do-not-call register on this deployment, so a number that
                  asks never to be called again is remembered only by the instance that heard it,
                  until that instance restarts. It can then be dialled again. Set{' '}
                  <Code>FIREBASE_SERVICE_ACCOUNT</Code> or <Code>SUPPRESSION_LIST_URL</Code> before
                  any real dialling.
                </p>
              </Note>
            )}

            {wiring.compliance.mode === 'dev' ? (
              <Note tone="bad" title="Compliance mode is dev — checks that cannot be verified are being waved through">
                <p>
                  In strict mode an unreachable DND scrub or register blocks the dial. In dev it
                  does not. Set <Code>COMPLIANCE_MODE=strict</Code> on any deployment that dials
                  real numbers.
                </p>
              </Note>
            ) : null}

            <div className="grid grid-cols-2 gap-3">
              <Stat
                label="Opt-outs"
                value={String(funnel.counts.optOut)}
                foot={
                  funnel.counts.optOut === 0
                    ? 'None in this window.'
                    : durableRegister
                      ? 'Each one is on the register and blocks future dials.'
                      : 'NOT durably suppressed — see above.'
                }
                muted={funnel.counts.optOut === 0}
              />
              <Stat
                label="Dials refused"
                value={String(funnel.counts.blocked)}
                foot={
                  funnel.counts.received
                    ? `${Math.round((funnel.counts.blocked / funnel.counts.received) * 100)}% of leads received`
                    : 'No leads received yet.'
                }
                muted={funnel.counts.blocked === 0}
              />
            </div>

            {/* Why the gate said no. */}
            <div>
              <h3 className="mb-2 text-[length:var(--text-xs)] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-dim)]">
                Why dials were refused
              </h3>
              {reasons.length === 0 ? (
                <EmptyState icon={Ban} title="Nothing refused">
                  Every lead in this window cleared the gate. Refusals appear here with the reason
                  the gate recorded.
                </EmptyState>
              ) : (
                <ul className="space-y-1.5">
                  {reasons.map(([reason, n]) => {
                    const terminal = reasonIsTerminal(reason);
                    return (
                      <li
                        key={reason}
                        className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[var(--radius-sm)] bg-[var(--color-elevated)] px-3 py-2"
                      >
                        <Badge tone={terminal ? 'bad' : 'warn'}>
                          <span className="tabular">{n}</span>
                        </Badge>
                        <span className="text-[length:var(--text-sm)] text-[var(--color-text)]">
                          {humanReason(reason)}
                        </span>
                        <span className="ml-auto text-[length:var(--text-xs)] text-[var(--color-text-dim)]">
                          {terminal ? 'the person’s choice' : 'failed closed'}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {/* Opt-outs on record, from the durable call list. */}
            <div>
              <h3 className="mb-2 text-[length:var(--text-xs)] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-dim)]">
                Opt-outs on finished calls
              </h3>
              {optOutCalls.length === 0 ? (
                <p className="text-[length:var(--text-xs)] leading-relaxed text-[var(--color-text-dim)]">
                  {store && !store.durable
                    ? 'No finished calls are being kept on this deployment, so an opt-out taken mid-call cannot be evidenced here.'
                    : 'No call in the stored history ended in an opt-out.'}
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {optOutCalls.map((c) => (
                    <li
                      key={c.callId || `${c.at}-${c.lead.phoneMasked}`}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[var(--radius-sm)] border border-[var(--color-bad-500)]/35 bg-[var(--color-bad-500)]/8 px-3 py-2"
                    >
                      <PhoneOff aria-hidden className="h-3.5 w-3.5 shrink-0 text-[var(--color-bad)]" />
                      {/* MASKED, and it stays masked. No title attribute, no full number. */}
                      <span className="tabular font-mono text-[length:var(--text-xs)] text-[var(--color-text)]">
                        {c.lead.phoneMasked || 'number withheld'}
                      </span>
                      <span className="text-[length:var(--text-xs)] text-[var(--color-text-dim)]">
                        do not call
                      </span>
                      {c.disposition && c.disposition !== 'opt-out' ? (
                        <span className="text-[length:var(--text-xs)] text-[var(--color-text-dim)]">
                          agent reported &ldquo;{c.disposition}&rdquo; — overridden
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* The standing rules, stated rather than assumed. */}
            <dl className="grid gap-2 border-t border-[var(--color-line-soft)] pt-4 text-[length:var(--text-xs)] sm:grid-cols-2">
              <div className="flex items-center gap-2">
                <Clock aria-hidden className="h-3.5 w-3.5 shrink-0 text-[var(--color-text-dim)]" />
                <dt className="text-[var(--color-text-dim)]">Calling window</dt>
                <dd className="tabular text-[var(--color-text)]">{wiring.compliance.callingWindowIST} IST</dd>
              </div>
              <div className="flex items-center gap-2">
                <Clock aria-hidden className="h-3.5 w-3.5 shrink-0 text-[var(--color-text-dim)]" />
                <dt className="text-[var(--color-text-dim)]">Consent valid for</dt>
                <dd className="tabular text-[var(--color-text)]">{wiring.compliance.consentWindowDays} days</dd>
              </div>
              <div className="flex items-center gap-2">
                <Ban aria-hidden className="h-3.5 w-3.5 shrink-0 text-[var(--color-text-dim)]" />
                <dt className="text-[var(--color-text-dim)]">DND scrub</dt>
                <dd className="text-[var(--color-text)]">
                  {wiring.compliance.dndScrub ? 'configured' : 'not configured'}
                </dd>
              </div>
              <div className="flex items-center gap-2">
                <Ban aria-hidden className="h-3.5 w-3.5 shrink-0 text-[var(--color-text-dim)]" />
                <dt className="text-[var(--color-text-dim)]">Register backend</dt>
                <dd className="text-[var(--color-text)]">{wiring.compliance.suppressionBackend}</dd>
              </div>
            </dl>

            <p className="text-pretty text-[length:var(--text-xs)] leading-relaxed text-[var(--color-text-dim)]">
              This panel shows opt-out <em>activity</em>, not the register&rsquo;s contents —{' '}
              <Code>/api/console/summary</Code> does not return the list, and numbers stay masked
              everywhere they appear.
            </p>
          </>
        )}
      </PanelBody>
    </Panel>
  );
}
