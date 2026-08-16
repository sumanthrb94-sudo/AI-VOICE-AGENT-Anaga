'use client';

/* ===========================================================================
   /call — the live demo, HOSTING the existing audio engine rather than
   replacing it.

   WHAT IS DELIBERATELY NOT REWRITTEN.

   public/assets/mic.js and demo-call.js are vanilla and stay that way. Between
   them they carry the percentile noise floor, the hysteresis gate, the
   spectral speech test, the endpointer, half-duplex mic scheduling, barge-in
   and the phrase splitter — each arrived at by fixing a specific failure on
   real hardware, each with tests behind it (test-browser-demo.mjs,
   test-media.mjs, simulate-echo.mjs). Porting that to React would trade every
   one of those tests for a component tree and buy nothing: none of it renders.
   It is signal processing on the audio thread, which is where React should
   not be.

   THE SEAM. demo-call.js owns the interaction completely: it binds by element
   id, and it drives page state by toggling `in-call`, `ended` and `speaking`
   on <body>. So this component renders the markup it expects and then gets out
   of the way — there is NO React state for the call. Two systems both trying
   to own "is the call running" is how you get a re-render that wipes the
   transcript mid-sentence.

   The contract, read off demo-call.js rather than guessed:
     #dir #lang        segmented pickers of button[data-dir] / button[data-lang]
     #start #again #end #compose #say
     #log #level #state #ttfa #timer #sub #src #build
     #score #band #rows
     body.in-call · body.ended · body.speaking
   =========================================================================== */

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Mic, PhoneOff, RotateCcw, Send } from 'lucide-react';
import { Card } from '@/components/ui/primitives';

const LANGS = [
  { id: 'te-IN', native: 'తెలుగు', label: 'Telugu', lang: 'te' },
  { id: 'hi-IN', native: 'हिंदी', label: 'Hindi', lang: 'hi' },
  { id: 'en-IN', native: 'English', label: 'Indian English', lang: 'en' },
];

const DIRECTIONS = [
  { id: 'outbound', title: 'Outbound', blurb: 'They left a number on a Meta or Instagram ad' },
  { id: 'inbound', title: 'Inbound', blurb: 'They ring us after seeing the ad' },
];

const seg =
  'cursor-pointer rounded-[var(--radius-md)] border border-[var(--color-line)] bg-[var(--color-elevated)] ' +
  'p-3.5 text-left transition-colors duration-200 hover:border-[var(--color-ink-500)] ' +
  'aria-pressed:border-[var(--color-accent)] aria-pressed:bg-[var(--color-brand-700)]/20';

export default function CallPage() {
  const [engine, setEngine] = useState<'loading' | 'ready' | 'failed'>('loading');
  const once = useRef(false);

  useEffect(() => {
    if (once.current) return;
    once.current = true;

    // Loaded here rather than in the document head: these scripts construct an
    // AudioContext and ask for a microphone, which has no business happening
    // on a page somebody opened to read about the product.
    const load = (src: string) =>
      new Promise<void>((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.async = false; // demo-call.js expects createMic from mic.js
        s.onload = () => resolve();
        s.onerror = () => reject(new Error(src));
        document.body.appendChild(s);
      });

    load('/assets/mic.js')
      .then(() => load('/assets/demo-call.js'))
      .then(() => setEngine('ready'))
      .catch(() => setEngine('failed'));

    return () => {
      // Leaving mid-call must release the microphone. The engine hangs its own
      // teardown off the end button; clicking it is the supported way to stop.
      document.getElementById('end')?.click();
      document.body.classList.remove('in-call', 'ended', 'speaking');
    };
  }, []);

  return (
    <main id="main" className="mx-auto flex min-h-dvh w-full max-w-lg flex-col px-5 pb-8 pt-6">
      <Link
        href="/"
        className="mb-5 inline-flex w-fit items-center gap-1.5 text-[length:var(--text-sm)] text-[var(--color-text-dim)] transition-colors hover:text-[var(--color-text)] [body.in-call_&]:hidden"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        Back
      </Link>

      {/* ── SETUP ─────────────────────────────────────────────────────── */}
      <section className="setup flex-1">
        <h1 className="text-[length:var(--text-2xl)] font-semibold tracking-[-0.02em]">
          Talk to Anaga
        </h1>
        <p className="mt-3 text-pretty text-[length:var(--text-sm)] leading-relaxed text-[var(--color-text-dim)]">
          A real call, not a recording. Starting it opens your microphone and leaves it open — just
          talk, and interrupt her whenever you like. She discloses that she is an AI, qualifies the
          lead against the versioned script, and books a site visit or takes the opt-out.
        </p>

        <fieldset className="mt-7">
          <legend className="mb-3 text-[length:var(--text-xs)] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-faint)]">
            How the call starts
          </legend>
          <div id="dir" className="grid gap-2 sm:grid-cols-2">
            {DIRECTIONS.map((d, i) => (
              <button key={d.id} type="button" data-dir={d.id} aria-pressed={i === 0} className={seg}>
                <span className="block text-[length:var(--text-sm)] font-semibold">{d.title}</span>
                <span className="mt-0.5 block text-[length:var(--text-xs)] text-[var(--color-text-dim)]">
                  {d.blurb}
                </span>
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset className="mt-5">
          <legend className="mb-3 text-[length:var(--text-xs)] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-faint)]">
            Language
          </legend>
          <div id="lang" className="grid grid-cols-3 gap-2">
            {LANGS.map((l, i) => (
              <button key={l.id} type="button" data-lang={l.id} aria-pressed={i === 0} className={`${seg} text-center`}>
                {/* lang= so the Noto face applies — without it these render in
                    whatever the OS picked, at a different optical size, and the
                    Telugu demo looks broken to the people it is for. */}
                <span lang={l.lang} className="block text-[length:var(--text-base)] font-semibold">
                  {l.native}
                </span>
                <span className="mt-0.5 block text-[length:var(--text-xs)] text-[var(--color-text-dim)]">
                  {l.label}
                </span>
              </button>
            ))}
          </div>
        </fieldset>

        <button
          id="start"
          type="button"
          disabled={engine !== 'ready'}
          className="mt-7 h-13 w-full cursor-pointer rounded-full bg-[var(--color-accent-fill)] text-[length:var(--text-base)]
                     font-bold text-[var(--color-on-accent)] transition-colors duration-200
                     hover:bg-[var(--color-brand-400)] disabled:cursor-default disabled:opacity-45"
        >
          {engine === 'loading' ? 'Starting the engine…' : engine === 'failed' ? 'Engine failed to load' : 'Start the call'}
        </button>

        {engine === 'failed' && (
          <p role="alert" className="mt-3 text-[length:var(--text-xs)] text-[var(--color-bad)]">
            The call engine could not load. Reload the page; if it keeps failing, a content blocker
            may be stopping <code>/assets/demo-call.js</code>.
          </p>
        )}

        <p id="src" className="mt-4 min-h-4 text-[length:var(--text-xs)] leading-relaxed text-[var(--color-text-faint)]" />
        <p className="mt-1 text-[length:var(--text-xs)] text-[var(--color-text-faint)]">
          build <span id="build" className="tabular" />
        </p>
      </section>

      {/* ── THE CALL ──────────────────────────────────────────────────── */}
      <section className="call flex-1 flex-col">
        <div className="rounded-[var(--radius-xl)] bg-gradient-to-b from-[var(--color-elevated)] to-transparent px-4 pb-5 pt-7 text-center">
          <div className="avatar mx-auto grid h-20 w-20 place-items-center rounded-full bg-gradient-to-br from-[var(--color-accent-fill)] to-[var(--color-brand-300)] text-[length:var(--text-xl)] font-semibold text-[var(--color-on-accent)]" aria-hidden>
            <span lang="te">అ</span>
          </div>
          <p className="mt-3 text-[length:var(--text-lg)] font-semibold">Anaga</p>
          <p id="sub" className="mt-0.5 min-h-4 text-[length:var(--text-xs)] text-[var(--color-text-dim)]" />
          <p id="timer" className="tabular mt-2 min-h-4 text-[length:var(--text-sm)] text-[var(--color-ok)]" />
          {/* aria-live so a screen reader is told the call's state without
              having to go hunting for it. */}
          <p id="state" role="status" aria-live="polite" className="mt-1.5 min-h-4 text-[length:var(--text-xs)] text-[var(--color-warn)]" />
          <p id="ttfa" className="tabular mt-1 min-h-3.5 text-[length:var(--text-xs)] text-[var(--color-text-faint)]" />
          <div id="level" className="mt-3 flex h-6 items-end justify-center gap-[3px]" aria-hidden />
        </div>

        {/* aria-atomic=false so only the new line is announced, not the
            entire transcript every time one arrives. */}
        <div
          id="log"
          className="flex flex-1 flex-col gap-2 overflow-y-auto py-3"
          aria-live="polite"
          aria-atomic="false"
          aria-label="Live transcript"
        />

        <div id="compose" className="flex gap-2 border-t border-[var(--color-line)] pt-3">
          <label htmlFor="say" className="sr-only">Type a reply instead of speaking</label>
          <input
            id="say"
            type="text"
            placeholder="…or type your reply"
            className="h-11 min-w-0 flex-1 rounded-full border border-[var(--color-line)] bg-[var(--color-elevated)]
                       px-4 text-[length:var(--text-sm)] text-[var(--color-text)]
                       placeholder:text-[var(--color-text-faint)] focus:border-[var(--color-accent)]"
          />
          <button
            type="submit"
            aria-label="Send reply"
            className="grid h-11 w-11 cursor-pointer place-items-center rounded-full border border-[var(--color-line)] bg-[var(--color-elevated)] transition-colors hover:border-[var(--color-ink-500)]"
          >
            <Send className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <div className="flex items-center justify-center gap-3 py-4">
          <span className="grid h-13 w-13 place-items-center rounded-full border border-[var(--color-line)] bg-[var(--color-elevated)] text-[var(--color-text-dim)]" aria-hidden>
            <Mic className="h-5 w-5" />
          </span>
          <button
            id="end"
            type="button"
            aria-label="End call"
            className="grid h-13 w-13 cursor-pointer place-items-center rounded-full bg-[var(--color-bad-500)] text-white transition-colors hover:bg-[var(--color-bad-400)]"
          >
            <PhoneOff className="h-5 w-5" aria-hidden />
          </button>
        </div>
      </section>

      {/* ── OUTCOME ───────────────────────────────────────────────────── */}
      <section className="outcome">
        <Card>
          <div className="p-5">
            <div className="flex items-baseline gap-3">
              <b id="score" className="tabular text-[length:var(--text-3xl)] leading-none" />
              <span className="text-[length:var(--text-xs)] text-[var(--color-text-dim)]">lead score</span>
              <span id="band" className="ml-auto rounded-full border border-[var(--color-brand-700)] bg-[var(--color-brand-700)]/25 px-2.5 py-0.5 text-[length:var(--text-xs)] font-semibold text-[var(--color-accent)]" />
            </div>
            <div id="rows" className="mt-4 text-[length:var(--text-sm)]" />
            <button
              id="again"
              type="button"
              className="mt-4 h-11 w-full cursor-pointer rounded-full border border-[var(--color-line)] bg-[var(--color-elevated)] text-[length:var(--text-sm)] font-semibold transition-colors hover:border-[var(--color-ink-500)]"
            >
              <RotateCcw className="mr-1.5 inline h-4 w-4" aria-hidden />
              Run another call
            </button>
          </div>
        </Card>
      </section>

      {/* Hidden mid-call: an invitation to leave is not what you want on
          screen while the microphone is open. */}
      <Link
        href="/call/live"
        className="mt-6 text-[length:var(--text-sm)] text-[var(--color-accent)] underline underline-offset-4 transition-opacity hover:opacity-80 [body.in-call_&]:hidden"
      >
        Try the streaming version — she replies while you are still talking
      </Link>
    </main>
  );
}
