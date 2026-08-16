'use client';

/* ===========================================================================
   The streaming call, on the site.

   ── WHY THIS IS REACT AND /call IS NOT ───────────────────────────────────
   app/call hosts demo-call.js untouched, because that file binds by element
   id and drives page state through <body> classes — wrapping it would mean two
   systems both owning "is the call running".

   live.js is not like that. It takes two callbacks and returns three methods,
   so there is no DOM contract to honour and no reason to hand it the page.
   React owns the markup; live.js owns the socket and the audio thread. The
   seam is four events wide.

   ── WHY THE URL IS FETCHED AND NOT BUILT IN ──────────────────────────────
   The agent is a long-lived process on Cloud Run — a serverless function
   cannot hold a socket open for the length of a call — so its address is not
   this origin. It comes from /api/integrations/health at runtime, like the
   OAuth client id, so one static export works in preview and production
   without a rebuild.

   When there is no agent deployed the answer is null, and this component says
   so plainly rather than opening a socket to nothing: a WebSocket to a host
   that is not there does not fail fast, it fails several seconds later as a
   close event carrying no reason, which reads as "the call broke".
   =========================================================================== */

import * as React from 'react';
import { Loader2, Mic, PhoneOff, Radio, TriangleAlert } from 'lucide-react';
import { getHealth, saveDemoCall, type AgentStatus } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/primitives';

/* ------------------------------------------------- live.js, typed by hand */

interface LiveCall {
  start: (lang: string, direction: string) => Promise<boolean>;
  stop: () => void;
  isLive: () => boolean;
}

type ServerEvent = {
  type: string;
  text?: string;
  role?: string;
  final?: boolean;
  lang?: string;
  // The bridge's own meter, emitted once when the call ends. Numeric units
  // only — no audio, no transcript, no phone number.
  usage?: unknown;
  // turn_timing. Numbers the bridge already computes, carried so the console
  // can report what a caller waited rather than what a benchmark measured.
  ttfa?: number;
  ttfaFromSpeech?: number;
  llm?: number;
  tts?: number;
};

declare global {
  interface Window {
    ANAGA_AGENT_URL?: string;
    createLiveCall?: (o: {
      onEvent?: (e: ServerEvent) => void;
      onState?: (s: string, detail?: string) => void;
    }) => LiveCall;
  }
}

const LANGS = [
  { id: 'te-IN', native: 'తెలుగు', label: 'Telugu', tag: 'te' },
  { id: 'hi-IN', native: 'हिंदी', label: 'Hindi', tag: 'hi' },
  { id: 'en-IN', native: 'English', label: 'Indian English', tag: 'en' },
];

type Line = { who: 'anaga' | 'you'; text: string; partial?: boolean };

export function StreamingCall() {
  const [agent, setAgent] = React.useState<AgentStatus | null | 'loading'>('loading');
  const [state, setState] = React.useState<'idle' | 'connecting' | 'live' | 'ended' | 'error'>('idle');
  const [detail, setDetail] = React.useState('');
  const [lang, setLang] = React.useState('te-IN');
  const [lines, setLines] = React.useState<Line[]>([]);
  const call = React.useRef<LiveCall | null>(null);
  const tail = React.useRef<HTMLDivElement>(null);
  // Kept in refs, not state: they are written from socket callbacks on every
  // turn and nothing renders from them, so putting them in state would
  // re-render the transcript on each timing event for no visible reason.
  const startedAt = React.useRef<number | null>(null);
  const timings = React.useRef<Array<{ ttfa: number | null; ttfaFromSpeech?: number | null; llm?: number | null; tts?: number | null }>>([]);
  const lines_ = React.useRef<Line[]>([]);
  const usage = React.useRef<unknown>(null);
  const saved = React.useRef(false);
  lines_.current = lines;

  /** Write the call down, once, against the signed-in account.
   *
   *  Nothing recorded browser calls at all: the bridge emitted transcripts and
   *  timings to this page and the page dropped them when the tab closed. So a
   *  console on a deployment where calls had been held read zero of everything.
   *
   *  Best effort by design. A failed write must never surface as a failed
   *  CALL — the conversation happened either way, and a signed-out visitor
   *  gets a 401 here, which is not an error worth showing them. */
  const persist = React.useCallback(() => {
    if (saved.current) return;
    const history = lines_.current
      .filter((l) => !l.partial)
      .map((l) => ({ role: l.who === 'anaga' ? ('agent' as const) : ('user' as const), text: l.text }));
    if (!history.length) return;
    saved.current = true;
    void saveDemoCall({
      lang, startedAt: startedAt.current, history,
      timings: timings.current, usage: usage.current,
    }).catch(() => { /* not signed in, or the store is down. The call still happened. */ });
  }, [lang]);

  /* Where to dial, and whether there is anywhere to dial at all. */
  React.useEffect(() => {
    let alive = true;
    getHealth()
      .then((h) => { if (alive) setAgent(h.agent ?? { url: null, streaming: false }); })
      .catch(() => { if (alive) setAgent({ url: null, streaming: false }); });
    return () => { alive = false; };
  }, []);

  /* Hanging up on unmount is not optional — the microphone stays open
     otherwise, and the browser's recording indicator stays lit on a page the
     user believes they have left. */
  React.useEffect(() => () => { call.current?.stop(); persist(); }, [persist]);

  React.useEffect(() => {
    tail.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [lines]);

  function record(e: ServerEvent) {
    setLines((prev) => {
      // Partial transcripts REPLACE the trailing partial rather than appending.
      // Appending is how you get the same sentence six times, growing by a word.
      if (e.type === 'partial' && e.text) {
        const next = prev.slice();
        if (next.length && next[next.length - 1].partial) next.pop();
        next.push({ who: 'you', text: e.text, partial: true });
        return next;
      }
      if (e.type === 'transcript' && e.text) {
        const next = prev.filter((l) => !l.partial);
        next.push({ who: 'you', text: e.text });
        return next;
      }
      if ((e.type === 'say' || e.type === 'agent') && e.text) {
        return [...prev.filter((l) => !l.partial), { who: 'anaga', text: e.text }];
      }
      return prev;
    });
  }

  async function begin() {
    const url = typeof agent === 'object' && agent ? agent.url : null;
    if (!url) return;

    setLines([]);
    setDetail('');
    setState('connecting');

    // Told where to dial BEFORE the script loads: live.js reads the global at
    // connect time, but setting it first means a reload of this component can
    // never race the script tag.
    window.ANAGA_AGENT_URL = url;

    if (!window.createLiveCall) {
      try {
        await new Promise<void>((resolve, reject) => {
          const s = document.createElement('script');
          s.src = '/assets/live.js';
          s.async = false;
          s.onload = () => resolve();
          s.onerror = () => reject(new Error('live.js'));
          document.body.appendChild(s);
        });
      } catch {
        setState('error');
        setDetail('the call engine could not be loaded');
        return;
      }
    }
    if (!window.createLiveCall) {
      setState('error');
      setDetail('the call engine loaded but did not register');
      return;
    }

    startedAt.current = Date.now();
    timings.current = [];
    usage.current = null;
    saved.current = false;

    call.current = window.createLiveCall({
      onEvent: (e) => {
        // Numbers only, and only the ones the bridge already computes. This is
        // what lets the console show what a caller actually waited through
        // rather than what a benchmark said.
        // WHAT THE CALL COST, counted rather than asked for. Sarvam publishes
        // no balance endpoint, so spend is derived from units this pipeline
        // metered itself and the rates in CALL_COST_*.
        if (e.type === 'usage') usage.current = e.usage ?? null;
        if (e.type === 'turn_timing') {
          timings.current.push({
            ttfa: typeof e.ttfa === 'number' ? e.ttfa : null,
            ttfaFromSpeech: typeof e.ttfaFromSpeech === 'number' ? e.ttfaFromSpeech : null,
            llm: typeof e.llm === 'number' ? e.llm : null,
            tts: typeof e.tts === 'number' ? e.tts : null,
          });
        }
        record(e);
      },
      onState: (s, d) => {
        if (s === 'live') setState('live');
        else if (s === 'closed') { setState((was) => (was === 'live' ? 'ended' : was)); persist(); }
        else if (s === 'error') { setState('error'); setDetail(d || 'the call failed'); persist(); }
      },
    });

    // OUTBOUND: she speaks first, and the first thing she says is the
    // disclosure. That is the leg this product actually runs.
    const ok = await call.current.start(lang, 'outbound');
    if (!ok) setState((was) => (was === 'connecting' ? 'error' : was));
  }

  function hangUp() {
    call.current?.stop();
    call.current = null;
    setState('ended');
    // stop() closes the socket locally, so onState('closed') may never fire.
    persist();
  }

  /* ------------------------------------------------------------- rendering */

  if (agent === 'loading') {
    return (
      <Card className="p-5">
        <div className="flex items-center gap-2.5 text-[length:var(--text-sm)] text-[var(--color-text-dim)]">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          Looking for the call service
        </div>
      </Card>
    );
  }

  if (!agent?.url) {
    return (
      <Card className="p-5">
        <div className="flex gap-3">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-warn)]" aria-hidden />
          <div>
            <p className="text-[length:var(--text-sm)] font-semibold">
              No streaming call is deployed
            </p>
            <p className="mt-1.5 text-[length:var(--text-sm)] leading-relaxed text-[var(--color-text-dim)]">
              The site knows how to hold a live call, but no agent service is configured for this
              deployment. Set <code className="font-mono text-[length:var(--text-xs)]">ANAGA_AGENT_URL</code>{' '}
              to the Cloud Run socket and redeploy the API. The turn-by-turn demo works regardless.
            </p>
          </div>
        </div>
      </Card>
    );
  }

  const busy = state === 'connecting' || state === 'live';

  return (
    <div className="flex flex-col gap-5">
      <fieldset disabled={busy} className="disabled:opacity-50">
        <legend className="mb-3 text-[length:var(--text-xs)] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-faint)]">
          Language
        </legend>
        <div className="grid grid-cols-3 gap-2">
          {LANGS.map((l) => (
            <button
              key={l.id}
              type="button"
              onClick={() => setLang(l.id)}
              aria-pressed={lang === l.id}
              className={
                'cursor-pointer rounded-[var(--radius-md)] border border-[var(--color-line)] ' +
                'bg-[var(--color-elevated)] p-3.5 text-center transition-colors duration-200 ' +
                'hover:border-[var(--color-ink-500)] disabled:cursor-not-allowed ' +
                'aria-pressed:border-[var(--color-accent)] aria-pressed:bg-[var(--color-brand-700)]/20'
              }
            >
              {/* lang= so the Noto face applies — without it these render in
                  whatever the OS picked and the Telugu demo looks broken to
                  the people it is for. */}
              <span lang={l.tag} className="block text-[length:var(--text-base)] font-semibold">
                {l.native}
              </span>
              <span className="mt-0.5 block text-[length:var(--text-xs)] text-[var(--color-text-dim)]">
                {l.label}
              </span>
            </button>
          ))}
        </div>
      </fieldset>

      <div className="flex items-center gap-3">
        {state !== 'live' ? (
          <Button onClick={begin} disabled={state === 'connecting'} className="flex-1">
            {state === 'connecting' ? (
              <><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Connecting</>
            ) : (
              <><Mic className="h-4 w-4" aria-hidden /> {state === 'ended' ? 'Call again' : 'Start the call'}</>
            )}
          </Button>
        ) : (
          <Button onClick={hangUp} variant="danger" className="flex-1">
            <PhoneOff className="h-4 w-4" aria-hidden /> End the call
          </Button>
        )}

        {state === 'live' && (
          <span className="inline-flex items-center gap-2 text-[length:var(--text-sm)] text-[var(--color-text-dim)]">
            <Radio className="h-4 w-4 animate-pulse text-[var(--color-accent)]" aria-hidden />
            Live
          </span>
        )}
      </div>

      {state === 'error' && (
        <p role="alert" className="text-[length:var(--text-sm)] text-[var(--color-bad)]">
          {detail || 'the call failed'}
        </p>
      )}

      {lines.length > 0 && (
        <Card className="max-h-[24rem] overflow-y-auto p-4">
          <ul className="flex flex-col gap-3">
            {lines.map((l, i) => (
              <li
                key={i}
                className={
                  'max-w-[85%] rounded-[var(--radius-md)] px-3.5 py-2.5 text-[length:var(--text-sm)] leading-relaxed ' +
                  (l.who === 'anaga'
                    ? 'self-start bg-[var(--color-brand-700)]/20 text-[var(--color-text)]'
                    : 'self-end bg-[var(--color-elevated)] text-[var(--color-text)]') +
                  (l.partial ? ' opacity-60' : '')
                }
              >
                <span className="mb-1 block text-[length:var(--text-xs)] text-[var(--color-text-faint)]">
                  {l.who === 'anaga' ? 'Anaga' : 'You'}
                </span>
                {l.text}
              </li>
            ))}
          </ul>
          <div ref={tail} />
        </Card>
      )}
    </div>
  );
}
