// scripts/dev-server.mjs
//
// Run the REAL API and the REAL site locally, so a question about behaviour can
// be answered by asking it instead of by reading the code and guessing.
//
// This did not exist, and its absence is why "why is every voice female?" took
// an argument rather than a curl. Vercel's routing was only reproducible by
// deploying, which meant every hypothesis cost a push, a build, a promote and a
// human re-testing on a phone.
//
//   node --experimental-detect-module scripts/dev-server.mjs
//   curl localhost:3000/api/tts
//   curl -X POST localhost:3000/api/tts -d '{"text":"hi","gender":"male"}' \
//        -H 'content-type: application/json'
//
// It mounts every file under api/ the way Vercel does — including the rewrites
// in vercel.json, so /api/auth/login reaches the dispatcher exactly as it does
// in production. If routing breaks here, it breaks there.
//
// ── VENDORS ───────────────────────────────────────────────────────────────
// With no keys it runs against the real providers and they fail, which is
// honest but not useful offline. STUB_VENDORS=1 intercepts outbound vendor
// calls and returns plausible audio, recording exactly what was ASKED FOR —
// which is the half of the voice question that is ours. What a vendor does with
// a correct request is the vendor's half, and no local server can answer it.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = new URL('../', import.meta.url).pathname.replace(/\/$/, '');
const WEB = path.join(ROOT, 'web');
const PORT = Number(process.env.PORT || 3000);

// ---------------------------------------------------------------------------
// vendor stubs — record the request, return something shaped like audio
// ---------------------------------------------------------------------------
/** A real, decodable WAV: `seconds` of silence, 16-bit mono. */
function silentWav(seconds, rate) {
  const n = Math.round(seconds * rate);
  const pcm = Buffer.alloc(n * 2);            // even length — the bug above
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

export const vendorCalls = [];
if (process.env.STUB_VENDORS === '1') {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    let body = null;
    try { body = init.body ? JSON.parse(init.body) : null; } catch { /* form data */ }

    // The BRAIN. Stubbed for the same reason the vendors are: what we ask it is
    // ours to get right, what it answers is Google's. Note the URL carries the
    // key, so only the path is recorded.
    if (/generativelanguage\.googleapis/.test(u)) {
      vendorCalls.push({ url: u.split('?')[0], body });
      // A brain that is down is the common case, not the exotic one — quota,
      // a retired model name, a missing key. It has to be testable.
      if (process.env.STUB_LLM_FAIL === '1') {
        return new Response('{"error":{"message":"stubbed outage"}}', {
          status: 503, headers: { 'content-type': 'application/json' },
        });
      }
      const said = process.env.STUB_LLM_SAY
        || 'మీరు ఉండటానికా, లేక పెట్టుబడి కోసమా చూస్తున్నారు?';
      // A SUPERSET of both contracts. /turn and /summary ask the same provider
      // for different JSON, and one stub shape meant whichever endpoint the test
      // was not written for silently got an object full of holes — a summary
      // that scores 0 on every call looks like a scoring bug, not a stub.
      const payload = JSON.stringify({
        say: said, end: false, disposition: 'qualifying',
        interested: true,
        qualification: { purpose: 'end-use', budget: 'in-range', config: '3bhk', timeline: '0-3m' },
        summary: 'Stubbed summary for local runs.',
        nextAction: 'Book the site visit.',
        comment: 'Stub.',
      });
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: payload }] } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }

    // SPEECH TO TEXT. Multipart, so the body is not JSON — record the URL and
    // answer with a transcript the test can assert on.
    if (/sarvam\.ai\/speech-to-text/.test(u)) {
      vendorCalls.push({ url: u.split('?')[0], body: null });
      return new Response(JSON.stringify({
        request_id: 'stub',
        transcript: process.env.STUB_STT_TEXT || 'నాకు మూడు బెడ్‌రూమ్‌లు కావాలి',
        language_code: 'te-IN',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }

    if (/sarvam\.ai|texttospeech\.googleapis|translate_tts|voicestudio|indicf5/.test(u)
        || /gpu|10\.0\.0/.test(u)) {
      vendorCalls.push({ url: u.split('?')[0], body });

      // A VALID, PLAYABLE clip — not four bytes of MP3 header. A stub whose
      // audio a browser refuses to decode fails the page for a reason that has
      // nothing to do with the page, which is worse than no stub at all: it
      // reports a bug that is not there.
      // Built rather than pasted: a hand-written 1-sample clip had an odd
      // `data` length for 16-bit audio, so Chromium refused to decode it and
      // the page reported "no supported source" — a stub failing the thing it
      // was meant to exercise.
      const wav = silentWav(0.25, 16000);

      // Sarvam's BATCH endpoint answers JSON; its stream endpoint answers raw
      // bytes. Match whichever was called, or the adapter parses the wrong shape.
      if (/sarvam\.ai\/text-to-speech$/.test(u.split('?')[0])) {
        return new Response(JSON.stringify({ audios: [wav.toString('base64')] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(wav, { status: 200, headers: { 'content-type': 'audio/wav' } });
    }
    return realFetch(url, init);
  };
}

// ---------------------------------------------------------------------------
// routing — mirrors Vercel: api/**/*.js are functions, _lib is not
// ---------------------------------------------------------------------------
function routeTable() {
  const out = new Map();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== '_lib') walk(p); continue; }
      if (!e.name.endsWith('.js')) continue;
      out.set('/' + path.relative(ROOT, p).replace(/\.js$/, ''), p);
    }
  };
  walk(path.join(ROOT, 'api'));
  return out;
}

/** vercel.json rewrites, applied the way the platform applies them. */
function rewrites() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
    return (cfg.rewrites || []).map((r) => ({
      // "/api/auth/:action" -> a matcher that captures the named params
      re: new RegExp('^' + r.source.replace(/:([a-zA-Z]+)/g, '(?<$1>[^/]+)') + '$'),
      destination: r.destination,
    }));
  } catch { return []; }
}

const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
};

export function createDevServer() {
  const routes = routeTable();
  const rules = rewrites();

  return http.createServer(async (req, res) => {
    let [pathname, search = ''] = req.url.split('?');
    const query = Object.fromEntries(new URLSearchParams(search));

    // rewrites first, exactly like the platform
    for (const r of rules) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      let dest = r.destination;
      for (const [k, v] of Object.entries(m.groups || {})) dest = dest.replaceAll(`:${k}`, v);
      const [dp, dq = ''] = dest.split('?');
      Object.assign(query, Object.fromEntries(new URLSearchParams(dq)));
      // The handler still sees the ORIGINAL url — Vercel does not rewrite it
      // away, and api/auth.js falls back to parsing it.
      pathname = dp;
      break;
    }

    const file = routes.get(pathname);
    if (file) {
      let raw = '';
      for await (const c of req) raw += c;
      let body = raw;
      if ((req.headers['content-type'] || '').includes('json')) {
        try { body = raw ? JSON.parse(raw) : {}; } catch { body = raw; }
      }

      // The Vercel req/res shape, minimally and honestly.
      const vreq = Object.assign(Object.create(Object.getPrototypeOf(req)), req, {
        query, body, url: req.url, method: req.method, headers: req.headers,
      });
      const vres = {
        statusCode: 200,
        _headers: {},
        status(c) { this.statusCode = c; return this; },
        setHeader(k, v) { this._headers[k] = v; return this; },
        json(o) { this.setHeader('content-type', 'application/json'); this._end(JSON.stringify(o)); return this; },
        send(o) { this._end(typeof o === 'string' ? o : JSON.stringify(o)); return this; },
        end(o) { this._end(o || ''); return this; },
        _end(payload) { res.writeHead(this.statusCode, this._headers); res.end(payload); },
      };

      try {
        const mod = await import(pathToFileURL(file).href);
        await mod.default(vreq, vres);
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'handler_threw', detail: String(err && err.stack || err).slice(0, 900) }));
      }
      return;
    }

    // static
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
    const sf = path.join(WEB, rel);
    if (sf.startsWith(WEB) && fs.existsSync(sf) && fs.statSync(sf).isFile()) {
      res.writeHead(200, { 'content-type': MIME[path.extname(sf)] || 'application/octet-stream' });
      res.end(fs.readFileSync(sf));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found', path: pathname }));
  });
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('dev-server.mjs');
if (invokedDirectly) {
  const server = createDevServer();
  server.listen(PORT, () => {
    const n = routeTable().size;
    console.log(`vaak dev server  http://localhost:${PORT}`);
    console.log(`  ${n} api routes (Vercel Hobby allows 12)`);
    console.log(`  vendors: ${process.env.STUB_VENDORS === '1' ? 'STUBBED' : 'live (needs real keys + egress)'}`);
  });
}
