'use client';

/* ===========================================================================
   Demo calls, with their transcripts.

   ── WHY THIS PANEL IS SEPARATE FROM "FINISHED CALLS" ─────────────────────
   That panel is the LEAD pipeline: a call placed to a number that passed the
   compliance gate, with a score, a disposition and a CRM writeback. A browser
   demo has none of those and must not be counted among them, or the funnel
   starts reporting conversations that were never leads.

   ── WHY TRANSCRIPTS AND NOT AUDIO ────────────────────────────────────────
   Recording needs a bucket, a region and a retention policy that nobody has
   configured yet, and `recording.configured` is false. The transcript is
   already written on every call and is most of the value: it is what she
   said, what they said, and whether the disclosure was actually delivered.

   The list never carries transcripts. They are fetched one call at a time,
   through the endpoint that LOGS the read — a transcript is what a prospect
   said, and who opened it is worth knowing.
   =========================================================================== */

import * as React from 'react';
import { FileText, Loader2, MessageSquare } from 'lucide-react';
import { getCall, getDemoCalls, type DemoCallSummary } from '@/lib/api';
import { Panel, PanelHead, PanelBody, EmptyState } from './panels';

type Turn = { role: string; text: string };

function when(ms: number | null) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('en-IN', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

export function DemoCallsPanel() {
  const [calls, setCalls] = React.useState<DemoCallSummary[] | null>(null);
  const [scope, setScope] = React.useState<'mine' | 'all'>('mine');
  const [open, setOpen] = React.useState<string | null>(null);
  const [turns, setTurns] = React.useState<Turn[] | null>(null);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    let alive = true;
    getDemoCalls(25)
      .then((r) => { if (alive) { setCalls(r.calls); setScope(r.scope); } })
      .catch(() => { if (alive) setCalls([]); });
    return () => { alive = false; };
  }, []);

  async function show(id: string) {
    if (open === id) { setOpen(null); setTurns(null); return; }
    setOpen(id);
    setTurns(null);
    setLoading(true);
    try {
      const r = await getCall(id);
      const c = r.call as { history?: Turn[] } | null;
      setTurns(Array.isArray(c?.history) ? c!.history! : []);
    } catch {
      setTurns([]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Panel>
      <PanelHead
        id="demo-calls"
        icon={MessageSquare}
        title="Demo calls"
        count={calls ? String(calls.length) : null}
        hint={scope === 'all'
          ? 'Every browser demo on this deployment. Transcripts are fetched one at a time and every read is logged.'
          : 'The demo calls you have held. Transcripts are fetched one at a time.'}
      />
      <PanelBody>
      {!calls?.length ? (
        <EmptyState icon={FileText} title="No demo calls yet">
          A call held at /call/live while signed in appears here with its transcript, and with
          what each turn actually cost the caller in waiting.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-[var(--color-line)]">
          {calls.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => show(c.id)}
                aria-expanded={open === c.id}
                className="flex w-full cursor-pointer items-center gap-3 py-3 text-left transition-colors hover:bg-[var(--color-elevated)]/50"
              >
                <span className="text-[length:var(--text-sm)] tabular-nums text-[var(--color-text-dim)]">
                  {when(c.startedAt ?? c.endedAt)}
                </span>
                <span className="rounded-full border border-[var(--color-line)] px-2 py-0.5 text-[length:var(--text-xs)] text-[var(--color-text-dim)]">
                  {c.lang}
                </span>
                <span className="text-[length:var(--text-sm)]">{c.turns} turns</span>
                {/* What the caller actually waited, per call. Not a benchmark —
                    the median of the turns in THIS conversation. */}
                {c.ttfaP50 !== null && (
                  <span className="ml-auto text-[length:var(--text-sm)] tabular-nums text-[var(--color-text-dim)]">
                    {c.ttfaP50}ms
                  </span>
                )}
                {c.by && (
                  <span className="text-[length:var(--text-xs)] text-[var(--color-text-faint)]">{c.by}</span>
                )}
              </button>

              {open === c.id && (
                <div className="pb-4">
                  {loading ? (
                    <span className="inline-flex items-center gap-2 text-[length:var(--text-sm)] text-[var(--color-text-dim)]">
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Fetching the transcript
                    </span>
                  ) : !turns?.length ? (
                    <p className="text-[length:var(--text-sm)] text-[var(--color-text-dim)]">
                      No transcript stored for this call.
                    </p>
                  ) : (
                    <ul className="flex flex-col gap-2">
                      {turns.map((t, i) => (
                        <li
                          key={i}
                          className={
                            'max-w-[85%] rounded-[var(--radius-md)] px-3 py-2 text-[length:var(--text-sm)] leading-relaxed ' +
                            (t.role === 'agent'
                              ? 'self-start bg-[var(--color-brand-700)]/20'
                              : 'self-end bg-[var(--color-elevated)]')
                          }
                        >
                          <span className="mb-0.5 block text-[length:var(--text-xs)] text-[var(--color-text-faint)]">
                            {t.role === 'agent' ? 'Anaga' : 'Caller'}
                          </span>
                          {t.text}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      </PanelBody>
    </Panel>
  );
}
