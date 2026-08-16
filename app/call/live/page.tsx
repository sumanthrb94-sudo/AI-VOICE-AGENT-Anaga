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

      <Link
        href="/call"
        className="mt-6 w-fit text-[length:var(--text-sm)] text-[var(--color-text-dim)] underline underline-offset-4 transition-colors hover:text-[var(--color-text)]"
      >
        The turn-by-turn version, for comparison
      </Link>

      <p className="mt-6 text-[length:var(--text-xs)] leading-relaxed text-[var(--color-text-faint)]">
        Your microphone stays open for the whole call, and audio is sent to the recogniser as it is
        captured. Nothing is stored by this page. Say “don’t call me” at any point — the opt-out is
        taken before anything else in the turn, and it overrides whatever she was about to do next.
      </p>
    </main>
  );
}
