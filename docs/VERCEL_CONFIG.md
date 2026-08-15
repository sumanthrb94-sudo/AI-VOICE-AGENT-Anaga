# Why vercel.json looks like this

Every key in `vercel.json` is load-bearing and at least two of them are one
edit away from a broken deployment. This file is the reasoning, kept out of the
JSON because **`vercel.json` has a closed schema — an unknown key fails the
deployment before the build runs, so there is no build log to read.** That has
already happened once in this repo: an explanatory `_regions` array was added
alongside `regions`, and the deploy died with no output.

## `"framework": null` — pinned, not omitted

Vercel would otherwise detect Next.js from `package.json` and hand the build to
`@vercel/next`. That builder is fine, but it changes how the root `api/`
directory is treated, and **`api/` is the entire backend**: twelve serverless
functions that place phone calls, run the compliance gate, and write to the
CRM. Pinning `framework: null` keeps Vercel in "Other" mode, where the build is
exactly `buildCommand` → `outputDirectory` and `api/**/*.js` is handled the
same way it is in the deployments that already work today.

This is a deliberate choice of the boring option. The Next.js builder can
coexist with a root `api/` — its framework definition has no `ignoreRuntimes` —
but "can" is doing a lot of work in a sentence about a system that dials real
phone numbers.

## Twelve functions, and no room for a thirteenth

Vercel Hobby allows **12 serverless functions per deployment**. This repo emits
exactly 12 — every successful deployment's metadata reads
`lambdaRuntimeStats: {"nodejs":12}`. There is zero headroom, and the wall has
already been hit once (commit `0486817`, "Four auth routes broke the deploy;
collapse them behind a rewrite").

Two consequences that are easy to trip over:

**`api/_lib/**` is not counted.** Vercel's function detector skips any path
containing `/_`, and it does so *before* the `functions` glob in this file is
consulted — so `"api/**/*.js"` cannot accidentally resurrect them. This is why
`api/auth.js` is one function that dispatches five routes out of
`api/_lib/routes/`, and why adding Google sign-in cost nothing.

**The cap is enforced at DEPLOY, not at build.** An over-limit deployment
prints `Build Completed`, then `Deploying outputs...`, and only then goes to
ERROR. `next build` succeeding locally proves nothing about the cap. If you add
an endpoint, deploy a preview and check.

The frontend is a **static export** (`output: 'export'` in `next.config.ts`)
precisely because it emits **zero** functions. 0 + 12 = 12. An SSR page, a
route handler, a server action, or middleware would each emit at least one and
put the deployment over.

## `outputDirectory: "out"`, and the `public/` trap

`next build` with `output: 'export'` writes to `out/`. Both `out/` and
`public/` are gitignored build artifacts:

- `public/` is **staged** by `scripts/prepare-public.mjs` (a `prebuild` hook)
  from `web/assets/`, then copied verbatim into `out/` by Next.
- `out/` is what Vercel serves.

`web/` remains the tracked source for the hand-written audio engine, because
`caller-agent/src/agent/server.js` serves that directory for the local dev loop
and the Playwright suites load it from there.

Note that `prepare-public.mjs` copies **no HTML**. `public/index.html` would
collide with the `out/index.html` that `app/page.tsx` exports, and Next fails
the build on that collision rather than silently choosing one.

## `installCommand` was removed

It used to be `echo 'no install step (static site)'`, which was true when the
repo had zero dependencies. It no longer does. Leaving it would mean Vercel
never installs `next`, and the build fails at the first import.

## Header order

Vercel merges every matching `headers` rule. The blanket `/(.*)` no-cache rule
is listed **first** and the specific ones after it, so that under
last-match-wins the immutable rule applies to `/_next/static/**`, and under
first-match-wins the worst case is merely that content-hashed assets are
re-validated more often than necessary. Either way nothing serves stale HTML,
which is the failure that actually matters.

`/_next/static/**` filenames contain a content hash, so `immutable` is safe
there and nowhere else.

## `cleanUrls` and `trailingSlash`

`cleanUrls: true` serves `out/login.html` at `/login` and redirects
`/login.html` → `/login`. `trailingSlash: false` matches `trailingSlash: false`
in `next.config.ts` — if those two ever disagree you get a redirect loop, so
they are changed together or not at all.

## The rewrites

Both exist to save function slots, not for aesthetics:

- `/api/auth/:action` → `/api/auth?action=:action` — five auth routes, one
  function.
- `/api/calls/recording` → `/api/calls/transcript?action=recording` — two
  endpoints, one function.

The handlers behind them parse `action` from an anchored pattern and match it
**exactly** against a table, so an unknown action is a 404 and never a default
route into something privileged. `/api/auth/../bootstrap` was once resolved to
`bootstrap` by a `pop()` on the path segments; it is not any more.

## If you are moving to Pro

The function cap disappears. At that point the static-export constraint is a
choice rather than a requirement, and SSR, route handlers and middleware all
become available — switching is a change to `next.config.ts` plus whichever
pages you want to move. Nothing here paints you into a corner.

Vercel's Hobby plan is also documented as being for personal, non-commercial
projects. This is a commercial product.
