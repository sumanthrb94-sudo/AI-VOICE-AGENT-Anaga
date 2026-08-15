'use client';

/* ===========================================================================
   The event stream — what the pipeline decided, in order.

   Rows come from api/_lib/events.js. Every payload was masked at the record
   site (api/_lib/pipeline.js writes `result.lead.phone`, which leadSummary()
   has already masked), so `e.phone` is rendered as received and never touched.
   =========================================================================== */

import * as React from 'react';
import { ScrollText, Inbox } from 'lucide-react';
import { Badge } from '@/components/ui/primitives';
import { Panel, PanelHead, PanelBody, EmptyState, Code, TableScroll, LoadingRows } from './panels';
import { formatClock, humanReason, type PipelineEvent, type Tone } from './types';

interface EventSpec {
  label: string;
  tone: Tone;
}

function spec(e: PipelineEvent): EventSpec {
  switch (e.type) {
    case 'lead.received': return { label: 'received', tone: 'neutral' };
    case 'lead.blocked': return { label: 'blocked', tone: 'bad' };
    case 'call.queued':
      // A queue call that did not queue is a failure wearing a success's name.
      return e.queued === false ? { label: 'not queued', tone: 'bad' } : { label: 'queued', tone: 'warn' };
    case 'call.completed':
      return e.disposition === 'opt-out'
        ? { label: 'opt-out', tone: 'bad' }
        : { label: 'completed', tone: 'ok' };
    case 'lead.optout': return { label: 'opt-out', tone: 'bad' };
    case 'recording.erased': return { label: 'recording erased', tone: 'warn' };
    default: return { label: e.type, tone: 'neutral' };
  }
}

function detail(e: PipelineEvent): string {
  if (e.type === 'lead.blocked') return humanReason(e.reason);
  if (e.type === 'call.queued') {
    return e.queued ? e.callId || 'queued' : humanReason(e.reason || 'not queued');
  }
  if (e.type === 'call.completed') {
    const bits: string[] = [];
    if (e.disposition) bits.push(e.disposition);
    if (Number.isFinite(e.score)) bits.push(`intent ${e.score}/100`);
    if (e.coverage != null) bits.push(`${e.coverage}% qualified`);
    if (e.durationSec) bits.push(`${e.durationSec}s`);
    if (e.reviewedBy === 'heuristic') bits.push('fallback review');
    // Loud: a completed call whose conversation was not kept cannot be evidenced.
    if (e.transcriptStored === false) bits.push('transcript NOT stored');
    return bits.join(' · ') || '—';
  }
  if (e.type === 'recording.erased') return e.ok ? 'erased' : `erase failed: ${e.error || 'unknown'}`;
  return e.campaign || e.source || '—';
}

export function EventsPanel({ events }: { events: PipelineEvent[] | null }) {
  return (
    <Panel aria-labelledby="events-h">
      <PanelHead
        id="events-h"
        icon={ScrollText}
        title="Recent activity"
        count={events && events.length ? `${events.length}` : null}
        hint="Newest first. Lead intake, compliance verdicts, dial hand-offs and call outcomes."
      />

      {!events ? (
        <PanelBody><LoadingRows rows={5} /></PanelBody>
      ) : events.length === 0 ? (
        <PanelBody>
          <EmptyState icon={Inbox} title="No activity yet">
            Nothing has passed through the pipeline in this window. A lead posted to{' '}
            <Code>POST /api/leads/intake</Code> produces the first three rows here — received, a
            compliance verdict, and a dial hand-off.
          </EmptyState>
        </PanelBody>
      ) : (
        <TableScroll label="Recent pipeline events">
          <table className="w-full min-w-[40rem] border-collapse text-left">
            <thead>
              <tr className="border-b border-[var(--color-line)]">
                {['Time', 'Event', 'Lead', 'Number', 'Detail'].map((h) => (
                  <th
                    key={h}
                    scope="col"
                    className="px-4 py-2.5 text-[length:var(--text-xs)] font-medium uppercase tracking-[0.06em] text-[var(--color-text-dim)]"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {events.map((e, i) => {
                const s = spec(e);
                return (
                  <tr
                    key={`${e.at}-${e.type}-${i}`}
                    className="border-b border-[var(--color-line-soft)] last:border-b-0"
                  >
                    <td className="tabular whitespace-nowrap px-4 py-2.5 text-[length:var(--text-xs)] text-[var(--color-text-dim)]">
                      {formatClock(e.at)}
                    </td>
                    <td className="px-4 py-2.5">
                      <Badge tone={s.tone}>{s.label}</Badge>
                    </td>
                    <td className="px-4 py-2.5 text-[length:var(--text-xs)] text-[var(--color-text)]">
                      {e.name || '—'}
                    </td>
                    {/* Already masked at the record site. Never widened here. */}
                    <td className="tabular whitespace-nowrap px-4 py-2.5 font-mono text-[length:var(--text-xs)] text-[var(--color-text-dim)]">
                      {e.phone || '—'}
                    </td>
                    <td className="px-4 py-2.5 text-[length:var(--text-xs)] text-[var(--color-text-dim)]">
                      {detail(e)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableScroll>
      )}
    </Panel>
  );
}
