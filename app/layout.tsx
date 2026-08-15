import type { Metadata, Viewport } from 'next';
import { Inter, Noto_Sans_Telugu, Noto_Sans_Devanagari } from 'next/font/google';
import './globals.css';

// next/font downloads these at BUILD time and self-hosts them, so the deployed
// page makes no request to fonts.googleapis.com. That matters for three
// reasons: no third-party request on a page that will carry a session cookie,
// no render-blocking round trip on an Indian mobile connection, and no layout
// shift when the face swaps in.
const inter = Inter({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
});

// NOT OPTIONAL. Anaga speaks Telugu and Hindi, and the app renders her actual
// lines — the disclosure, the flow greets, the voice sampler. Inter has no
// Indic coverage, so without these the product's own sample text falls back to
// whatever the OS has, at a different optical size, and the Telugu demo looks
// broken to precisely the people it is for.
const telugu = Noto_Sans_Telugu({
  subsets: ['telugu'],
  variable: '--font-telugu',
  display: 'swap',
});

const devanagari = Noto_Sans_Devanagari({
  subsets: ['devanagari'],
  variable: '--font-devanagari',
  display: 'swap',
});

export const metadata: Metadata = {
  metadataBase: new URL('https://ai-voice-agent-anaga.vercel.app'),
  title: {
    default: 'Anaga — autonomous voice AI for property sales',
    template: '%s · Anaga',
  },
  description:
    'Anaga calls your property leads in Telugu, Hindi and English, qualifies them against a versioned script, books site visits, and hands warm prospects to your closers. Built by Modcon Builders.',
  openGraph: {
    title: 'Anaga — autonomous voice AI for property sales',
    description:
      'She discloses that she is an AI, qualifies the lead, books the site visit, and takes the opt-out. Telugu, Hindi and English.',
    type: 'website',
  },
  robots: {
    index: true,
    follow: true,
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#08090d' },
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
  ],
  width: 'device-width',
  initialScale: 1,
  // NEVER maximumScale=1 or userScalable=false. Blocking pinch-zoom on a page
  // that renders Telugu and Devanagari at 14px is an accessibility failure
  // aimed squarely at the users who most need to zoom.
  viewportFit: 'cover',
};

// Theme resolution has to happen BEFORE first paint or the page flashes the
// wrong colour scheme. This is the one inline script in the app; it is tiny,
// synchronous, and reads only localStorage plus the OS preference.
const THEME_INIT = `
(function(){try{
  var t=localStorage.getItem('anaga-theme');
  if(!t){t=matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';}
  if(t==='light')document.documentElement.setAttribute('data-theme','light');
}catch(e){}})();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${telugu.variable} ${devanagari.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body>
        {/* Every page gets a skip link. The console in particular puts a lot of
            navigation before its first table. */}
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50
                     focus:rounded-md focus:bg-[var(--color-elevated)] focus:px-4 focus:py-2
                     focus:text-sm focus:text-[var(--color-text)] focus:shadow-lg"
        >
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
