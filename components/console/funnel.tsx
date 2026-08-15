'use client';

/* ===========================================================================
   The pipeline: leads in → compliance verdict → queued → outcomes.

   Every number is api/_lib/events.js › rollup(). Two rules it inherits:

   1. A rate with no denominator is `null` on the wire and an em dash here.
      Nobody has a 0% book rate before their first call — they have no rate.
   2. The bars are decoration. The count and the percentage are printed as
      text on every stage, and each track carries its own aria-label, so the
      panel is readable with no colour and no bar at all.
   =========================================================================== */

import * as React from 'react';
import { Funnel as FunnelIcon, Inbox } from 'lucide-react';
import { Panel, PanelHead, PanelBody, EmptyState, Code, Stat, LoadingRows } from './panels';
import type { Funnel } from './types';

interface Stage {
  name: string;
  n: number;
  /** ok = a stage you want people to reach. */
  tone: 'ok' | 'neutral' | 'bad';
  note: string;
}

export function FunnelPanel({ funnel }: { funnel: Funnel | null }) {
  const stages: Stage[] = React.useMemo(() => {
    if (!funnel) return [];
    const c = funnel.counts;
    return [
      { name: 'Leads received', n: c.received, tone: 'neutral', note: 'intake accepted the lead' },
      { name: 'Refused by the gate', n: c.blocked, tone: 'bad', note: 'never dialled' },
      { name: 'Passed compliance', n: Math.max(0, c.received - c.blocked), tone: 'ok', note: 'lawful to dial' },
      { name: 'Queued to dial', n: c.queued, tone: 'neutral', note: 'handed to the dialler' },
      { name: 'Call completed', n: c.completed, tone: 'neutral', note: 'outcome reported back' },
      { name: 'Site visit booked', n: c.booked, tone: 'ok', note: 'handed to a human closer' },
    ];
  }, [funnel]);

  const top = funnel?.counts.received || 0;

  return (
    <Panel aria-labelledby="funnel-h">
      <PanelHead
        id="funnel-h"
        icon={FunnelIcon}
        title="Pipeline"
        hint="Derived from pipeline events only. Percentages are of leads received."
      />

      <PanelBody className="space-y-5">
        {!funnel ? (
          <LoadingRows rows={6} />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat
                label="Received"
                value={String(funnel.counts.received)}
                foot={
                  Object.keys(funnel.bySource).length
                    ? Object.entries(funnel.bySource).map(([k, v]) => `${k} ${v}`).join(' · ')
                    : 'no source yet'
                }
                muted={funnel.counts.received === 0}
              />
              <Stat
                label="Reached dial"
                value={String(funnel.counts.queued)}
                foot={funnel.dialRate == null ? 'no leads yet' : `${funnel.dialRate}% of leads received`}
                muted={funnel.counts.queued === 0}
              />
              <Stat
                label="Completed"
                value={String(funnel.counts.completed)}
                foot={
                  funnel.avgScore == null
                    ? 'no completed calls yet'
                    : `average intent ${funnel.avgScore}/100`
                }
                muted={funnel.counts.completed === 0}
              />
              <Stat
                label="Booked"
                value={funnel.bookRate == null ? '—' : String(funnel.counts.booked)}
                foot={
                  funnel.bookRate == null
                    ? 'no completed calls yet'
                    : `${funnel.bookRate}% of ${funnel.counts.completed} completed`
                }
                muted={funnel.bookRate == null}
              />
            </div>

            {funnel.counts.received === 0 ? (
              <EmptyState icon={Inbox} title="No leads yet">
                Nothing has entered the pipeline in this window. Push one through{' '}
                <Code>POST /api/leads/intake</Code> — or connect the Meta Lead Ads webhook — and
                every stage below fills in.
              </EmptyState>
            ) : (
              <ul className="space-y-3">
                {stages.map((s) => {
                  const pct = top ? Math.round((s.n / top) * 100) : 0;
                  const fill = {
                    ok: 'bg-[var(--color-ok-500)]',
                    bad: 'bg-[var(--color-bad-500)]',
                    neutral: 'bg-[var(--color-accent-fill)]',
                  }[s.tone];
                  return (
                    <li key={s.name}>
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                        <span className="text-[length:var(--text-sm)] text-[var(--color-text)]">{s.name}</span>
                        <span className="tabular text-[length:var(--text-sm)] font-semibold text-[var(--color-text)]">
                          {s.n}
                        </span>
                        <span className="tabular text-[length:var(--text-xs)] text-[var(--color-text-dim)]">
                          {pct}%
                        </span>
                        <span className="ml-auto text-[length:var(--text-xs)] text-[var(--color-text-dim)]">
                          {s.note}
                        </span>
                      </div>
                      <div
                        role="img"
                        aria-label={`${s.name}: ${s.n} of ${top}, ${pct} percent`}
                        className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-elevated)]"
                      >
                        <div
                          className={`h-full rounded-full ${fill} transition-[width] duration-300 ease-[var(--ease-out-soft)]`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            {funnel.counts.received > 0 && funnel.counts.completed === 0 ? (
              <p className="text-pretty text-[length:var(--text-xs)] leading-relaxed text-[var(--color-text-dim)]">
                Nothing has reported back yet. A finished call arrives at{' '}
                <Code>POST /api/calls/outcome</Code> and lands in the calls table below.
              </p>
            ) : null}
          </>
        )}
      </PanelBody>
    </Panel>
  );
}
