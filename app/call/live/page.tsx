import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { StreamingCall } from '@/components/call/streaming-call';

export const metadata = {
  title: 'Live call · Anaga',
  description: 'One socket for the whole call — she streams back while you are still talking.',
};

/* ===========================================================================
   /call/live — the streaming call, on our own domain.

   Separate from /call rather than a mode inside it, because they are two
   different transports with two different failure modes and one of them may
   not be deployed. /call posts a whole utterance and waits; this holds one
   socket open for the length of the call and needs a long-lived server, which
   is why it lives on Cloud Run and this page has to be told where that is.

   Folding them into one page with a toggle would mean a control that is
   sometimes inert for reasons the user cannot see.
   =========================================================================== */

export default function LiveCallPage() {
  return (
    <main id="main" className="mx-auto flex min-h-dvh w-full max-w-lg flex-col px-5 pb-8 pt-6">
      <Link
        href="/"
        className="mb-5 inline-flex w-fit items-center gap-1.5 text-[length:var(--text-sm)] text-[var(--color-text-dim)] transition-colors hover:text-[var(--color-text)]"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        Back
      </Link>

      <h1 className="text-[length:var(--text-2xl)] font-semibold tracking-[-0.02em]">
        Talk to Anaga, live
      </h1>
      <p className="mt-3 text-pretty text-[length:var(--text-sm)] leading-relaxed text-[var(--color-text-dim)]">
        One WebSocket for the whole call. Your words appear while you are still saying them, she
        stops the moment you start talking, and her voice streams back as it is made. She discloses
        that she is an AI before anything else — and if she cannot say that line, she hangs up
        rather than continuing.
      </p>

      <div className="mt-7">
        <StreamingCall />
      </div>

      {/* THE TRAPDOOR, CLOSED.
          /call is the older request/response engine: Web Speech, an open mic
          through her whole turn, and the echo that follows from it. It is kept
          for comparison, but it is NOT the product — and a plain link to it
          one tap below the live demo is how somebody ends up judging Anaga on
          the engine we replaced. vercel.json now redirects /call to here, so
          an old tab or bookmark lands on the real thing; ?legacy=1 is the way
          back for a deliberate comparison. */}
      <Link
        href="/call?legacy=1"
        className="mt-6 w-fit text-[length:var(--text-xs)] text-[var(--color-text-faint)] underline underline-offset-4 transition-colors hover:text-[var(--color-text-dim)]"
      >
        The older turn-by-turn engine, for comparison — not the live demo
      </Link>

      <p className="mt-6 text-[length:var(--text-xs)] leading-relaxed text-[var(--color-text-faint)]">
        Your microphone closes while Anaga is speaking and reopens the moment she stops, so a
        laptop speaker cannot feed her own voice back and make her interrupt herself. The panel
        shows which way the floor is pointing, and <em>Interrupt</em> cuts her off mid-sentence.
        On earphones there is no echo path at all — tick the box and the mic stays open the whole
        call, so you can talk over her. Nothing is stored by this page. Say “don’t call me” at any
        point — the opt-out is taken before anything else in the turn, and it overrides whatever
        she was about to do next.
      </p>
    </main>
  );
}
