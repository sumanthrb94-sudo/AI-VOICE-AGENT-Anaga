'use client';

/* ===========================================================================
   Finished calls, and one call's transcript on demand.

   The list payload deliberately carries NO transcripts (api/console/summary.js
   and api/_lib/callview.js). A response holding fifty conversations is an
   exfiltration shape. One transcript is fetched at a time, by callId, and the
   server logs each read — so opening the dialog below is an auditable act, and
   the UI does not pre-fetch them "to feel fast".

   Phone numbers arrive masked from the API and are rendered exactly as
   received: no reconstruction, no title attribute, no full number anywhere.
   =========================================================================== */

import * as React from 'react';
import { motion } from 'motion/react';
import { PhoneCall, X, Ban, Database, FileText, Mic } from 'lucide-react';
import { getCall, explain, ApiError } from '@/lib/api';
import { Badge } from '@/components/ui/primitives';
import { Button } from '@/components/ui/button';
import { Panel, PanelHead, PanelBody, EmptyState, Code, Note, TableScroll, LoadingRows } from './panels';
import {
  bandTone, dispositionTone, formatDuration, formatStamp, isOptOut,
  type CallView, type StoreProvenance,
} from './types';

/* ------------------------------------------------------------------ table */

export function CallsPanel({
  calls, store,
}: {
  calls: CallView[] | null;
  store: StoreProvenance | null;
}) {
  const [open, setOpen] = React.useState<CallView | null>(null);
  // Where focus goes back to when the dialog closes. Losing focus to <body> is
  // how a keyboard user gets dumped at the top of a long console.
  const returnTo = React.useRef<HTMLButtonElement | null>(null);

  return (
    <Panel aria-labelledby="calls-h">
      <PanelHead
        id="calls-h"
        icon={PhoneCall}
        title="Finished calls"
        count={calls && calls.length ? `${calls.length}` : null}
        hint="Score, band and outcome for each completed call. Transcripts are fetched one at a time and every read is logged."
      />

      {!calls ? (
        <PanelBody><LoadingRows rows={4} /></PanelBody>
      ) : calls.length === 0 ? (
        <PanelBody>
          {/* "No calls yet" and "no database" mean opposite things. */}
          {store && !store.durable ? (
            <Note tone="warn" title="Calls are not being kept">
              <p>
                Finished calls come from the durable store only — an event buffer holds summaries,
                not conversations. Until <Code>FIREBASE_SERVICE_ACCOUNT</Code> is set, a completed
                call is reviewed, scored and then discarded, and nothing can be evidenced later.
              </p>
            </Note>
          ) : (
            <EmptyState icon={PhoneCall} title="No finished calls yet">
              A call reported to <Code>POST /api/calls/outcome</Code> appears here with its score,
              disposition and transcript.
            </EmptyState>
          )}
        </PanelBody>
      ) : (
        <TableScroll label="Finished calls">
          <table className="w-full min-w-[46rem] border-collapse text-left">
            <thead>
              <tr className="border-b border-[var(--color-line)]">
                {['Time', 'Outcome', 'Lead', 'Number', 'Potency', 'Length', 'Transcript'].map((h) => (
                  <th
                    key={h}
                    scope="col"
                    className="px-4 py-2.5 text-[length:var(--text-xs)] font-medium uppercase tracking-[0.06em] text-[var(--color-text-dim)]"
                  >
                    {h === 'Transcript' ? <span className="sr-only">{h}</span> : h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {calls.map((c) => {
                const optOut = isOptOut(c);
                return (
                  <tr
                    key={c.callId || `${c.at}-${c.lead.phoneMasked}`}
                    className={
                      optOut
                        ? 'border-b border-[var(--color-line-soft)] bg-[var(--color-bad-500)]/8 last:border-b-0'
                        : 'border-b border-[var(--color-line-soft)] last:border-b-0'
                    }
                  >
                    <td className="tabular whitespace-nowrap px-4 py-3 text-[length:var(--text-xs)] text-[var(--color-text-dim)]">
                      {formatStamp(c.startedAt || c.at)}
                    </td>

                    <td className="px-4 py-3">
                      {optOut ? (
                        <div className="space-y-1">
                          <Badge tone="bad">
                            <Ban aria-hidden className="h-3 w-3" />
                            opt-out
                          </Badge>
                          {c.disposition && c.disposition !== 'opt-out' ? (
                            <p className="text-[length:var(--text-xs)] text-[var(--color-text-dim)]">
                              agent said &ldquo;{c.disposition}&rdquo; — overridden
                            </p>
                          ) : null}
                        </div>
                      ) : (
                        <Badge tone={dispositionTone(c.disposition)}>{c.disposition || 'unknown'}</Badge>
                      )}
                    </td>

                    <td className="px-4 py-3 text-[length:var(--text-sm)] text-[var(--color-text)]">
                      {c.lead.name || '—'}
                      {c.lead.source ? (
                        <span className="block text-[length:var(--text-xs)] text-[var(--color-text-dim)]">
                          {c.lead.source}
                        </span>
                      ) : null}
                    </td>

                    {/* Masked by the API. Rendered verbatim and nowhere else. */}
                    <td className="tabular whitespace-nowrap px-4 py-3 font-mono text-[length:var(--text-xs)] text-[var(--color-text-dim)]">
                      {c.lead.phoneMasked || '—'}
                    </td>

                    <td className="px-4 py-3">
                      {c.score == null ? (
                        <span className="text-[length:var(--text-sm)] text-[var(--color-text-dim)]">—</span>
                      ) : (
                        <div className="space-y-1">
                          <Badge tone={optOut ? 'bad' : bandTone(c.band)}>
                            <span className="tabular">{c.score}/100</span>
                            {c.band ? ` ${c.band}` : ''}
                          </Badge>
                          {c.scoring && c.scoring.of ? (
                            <p className="tabular text-[length:var(--text-xs)] text-[var(--color-text-dim)]">
                              {c.scoring.answered} of {c.scoring.of} answered
                            </p>
                          ) : null}
                        </div>
                      )}
                    </td>

                    <td className="tabular whitespace-nowrap px-4 py-3 text-[length:var(--text-xs)] text-[var(--color-text-dim)]">
                      {formatDuration(c.durationSec)}
                      {c.recordingRef ? (
                        <span className="mt-1 flex items-center gap-1 text-[var(--color-text-dim)]">
                          <Mic aria-hidden className="h-3 w-3" />
                          recorded
                        </span>
                      ) : null}
                    </td>

                    <td className="px-4 py-3">
                      {/* 44px even in a dense table. A transcript is the one
                          thing on this page somebody opens from a phone. */}
                      <Button
                        variant="secondary"
                        size="md"
                        className="px-3"
                        disabled={!c.callId}
                        onClick={(e) => {
                          returnTo.current = e.currentTarget;
                          setOpen(c);
                        }}
                        aria-label={`Open transcript for the call at ${formatStamp(c.startedAt || c.at)}`}
                      >
                        <FileText aria-hidden className="h-3.5 w-3.5" />
                        Open
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableScroll>
      )}

      {open ? (
        <TranscriptDialog
          call={open}
          onClose={() => {
            setOpen(null);
            returnTo.current?.focus();
          }}
        />
      ) : null}
    </Panel>
  );
}

/* ----------------------------------------------------------------- dialog */

function TranscriptDialog({ call, onClose }: { call: CallView; onClose: () => void }) {
  const [full, setFull] = React.useState<CallView | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const closeRef = React.useRef<HTMLButtonElement | null>(null);
  const panelRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    closeRef.current?.focus();

    // Esc closes, and Tab cycles WITHIN the dialog. `aria-modal` is a promise
    // to assistive tech that the rest of the page is inert; letting Tab walk
    // out into the console behind it breaks that promise silently.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !panelRef.current) return;
      const focusable = panelRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);

    // The page behind a bottom sheet must not scroll under the thumb.
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  React.useEffect(() => {
    let live = true;
    setFull(null);
    setError(null);
    if (!call.callId) {
      setError('This call has no id, so its transcript cannot be requested.');
      return;
    }
    getCall(call.callId)
      .then((r) => {
        if (live) setFull(r.call as CallView);
      })
      .catch((err: unknown) => {
        if (!live) return;
        // A 503 here is a WIRING fault, not a missing call: transcripts need
        // Firestore, and the operator needs the env var, not the word "error".
        setError(
          err instanceof ApiError && err.status === 404
            ? 'That call is no longer in the store.'
            : explain(err),
        );
      });
    return () => {
      live = false;
    };
  }, [call.callId]);

  const optOut = isOptOut(call);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-[var(--color-ink-950)]/70 p-0 sm:items-center sm:p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <motion.div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="transcript-h"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
        className="flex max-h-[88vh] w-full max-w-2xl flex-col rounded-t-[var(--radius-lg)] border border-[var(--color-line)] bg-[var(--color-surface)] shadow-[var(--shadow-card)] sm:rounded-[var(--radius-lg)]"
      >
        <div className="flex items-start justify-between gap-3 border-b border-[var(--color-line-soft)] px-5 py-4">
          <div className="min-w-0">
            <h2 id="transcript-h" className="text-[length:var(--text-sm)] font-semibold">
              Call transcript
            </h2>
            <p className="tabular mt-0.5 font-mono text-[length:var(--text-xs)] text-[var(--color-text-dim)]">
              {call.lead.phoneMasked || 'number withheld'} · {formatStamp(call.startedAt || call.at)} ·{' '}
              {formatDuration(call.durationSec)}
            </p>
          </div>
          <Button ref={closeRef} variant="ghost" size="icon" onClick={onClose} aria-label="Close transcript">
            <X aria-hidden className="h-4 w-4" />
          </Button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {optOut ? (
            <Note tone="bad" title="This call ended in an opt-out">
              <p>
                The number is on the do-not-call register and must not be dialled again. This
                overrides the disposition the agent reported.
              </p>
            </Note>
          ) : null}

          <div aria-live="polite" aria-busy={!full && !error}>
            {error ? (
              <Note tone="bad" title="Could not load the transcript">
                <p>{error}</p>
              </Note>
            ) : !full ? (
              <LoadingRows rows={5} />
            ) : (
              <div className="space-y-4">
                {full.scoring?.explain ? (
                  <p className="text-pretty text-[length:var(--text-xs)] leading-relaxed text-[var(--color-text-dim)]">
                    {full.scoring.explain}
                  </p>
                ) : null}

                {full.scoring?.fields?.length ? (
                  <TableScroll label="Score breakdown">
                    <table className="w-full min-w-[26rem] border-collapse text-left">
                      <thead>
                        <tr className="border-b border-[var(--color-line-soft)]">
                          {['Question', 'Answer', 'Weight', 'Points'].map((h) => (
                            <th
                              key={h}
                              scope="col"
                              className="px-3 py-2 text-[length:var(--text-xs)] font-medium uppercase tracking-[0.06em] text-[var(--color-text-dim)]"
                            >
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {full.scoring.fields.map((f) => (
                          <tr key={f.id} className="border-b border-[var(--color-line-soft)] last:border-b-0">
                            <td className="px-3 py-2 text-[length:var(--text-xs)] text-[var(--color-text)]">
                              {f.label}
                            </td>
                            <td className="px-3 py-2 text-[length:var(--text-xs)] text-[var(--color-text-dim)]">
                              {f.answered ? f.bucket : 'not answered'}
                            </td>
                            <td className="tabular px-3 py-2 text-[length:var(--text-xs)] text-[var(--color-text-dim)]">
                              {f.weight}
                            </td>
                            <td className="tabular px-3 py-2 text-[length:var(--text-xs)] text-[var(--color-text)]">
                              +{f.points}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableScroll>
                ) : null}

                {full.summary ? (
                  <p className="text-pretty text-[length:var(--text-sm)] leading-relaxed text-[var(--color-text)]">
                    {full.summary}
                  </p>
                ) : null}
                {full.nextAction ? (
                  <p className="text-[length:var(--text-sm)] text-[var(--color-text-dim)]">
                    <span className="text-[var(--color-text-dim)]">Next:</span> {full.nextAction}
                  </p>
                ) : null}

                {full.transcript && full.transcript.length ? (
                  <ol className="space-y-2">
                    {full.transcript.map((t, i) => (
                      <li
                        key={i}
                        className={
                          t.role === 'agent'
                            ? 'rounded-[var(--radius-sm)] border border-[var(--color-line-soft)] bg-[var(--color-elevated)] px-3 py-2'
                            : 'rounded-[var(--radius-sm)] border border-[var(--color-line)] px-3 py-2'
                        }
                      >
                        <p className="text-[length:var(--text-xs)] font-semibold uppercase tracking-[0.06em] text-[var(--color-text-dim)]">
                          {t.role === 'agent' ? 'Anaga' : 'Prospect'}
                        </p>
                        {/* React escapes this. It is speech transcribed from a
                            stranger on a phone call, rendered in an operator page. */}
                        <p className="mt-0.5 text-pretty text-[length:var(--text-sm)] leading-relaxed text-[var(--color-text)]">
                          {t.text}
                        </p>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <EmptyState icon={Database} title="No transcript was stored for this call">
                    The call was scored, but the conversation itself was not kept.
                  </EmptyState>
                )}

                {full.recordingRef ? (
                  <p className="text-pretty text-[length:var(--text-xs)] leading-relaxed text-[var(--color-text-dim)]">
                    A recording exists for this call. It is not reachable from here — playback is a
                    separate authenticated read against <Code>/api/calls/recording</Code> that logs
                    itself.
                  </p>
                ) : null}
              </div>
            )}
          </div>
        </div>
      </motion.div>
    </div>
  );
}
