# Signing in as admin

How `sumanthbolla97@gmail.com` gets to the dashboard, and what has to be true first.

There are two doors into the same session. Google sign-in is the one you want;
the email/password door already existed and still works.

---

## 0. Rotate the leaked key first

The service-account key `d33030dcb5b33ec7728c48130bb6d2c7af01ba37` for
`firebase-adminsdk-fbsvc@anaga-2c61c` was pasted into a chat and uploaded as a
file. **A Firebase admin key bypasses every Firestore security rule** — it can
read and write every document in the project regardless of what the rules say.
It is not a credential that can be "probably fine".

1. Firebase Console → ⚙ Project Settings → **Service accounts**
2. **Manage service account permissions** → opens Google Cloud IAM
3. Find `firebase-adminsdk-fbsvc@anaga-2c61c.iam.gserviceaccount.com` → **Keys**
4. **Delete** key `d33030dcb5…`, then **Add key → Create new key → JSON**
5. Put the new JSON in `FIREBASE_SERVICE_ACCOUNT` (below). Never in the repo.

Nothing in this repo has ever contained that key — `.gitignore` covers
`*-adminsdk-*.json` and `.secrets/`, and `git ls-files` confirms none is
tracked. The exposure is the chat and the upload, not the codebase.

---

## 1. Create the Google OAuth client

This is what makes the "Sign in with Google" button work. It is separate from
the Firebase admin key and much less dangerous — the client id is **public** by
design.

1. [Google Cloud Console → APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials?project=anaga-2c61c)
   (make sure the project selector says **anaga-2c61c**)
2. **Configure consent screen** if prompted — External, app name "Anaga",
   your support email. You do not need to submit it for verification: an
   unverified app still works for accounts you add as test users, and for
   everyone once you publish.
3. **Create Credentials → OAuth client ID → Web application**
4. **Authorised JavaScript origins** — add every origin the login page is
   served from. Google matches these exactly, so `https://` vs `http://` and a
   trailing slash both matter:

   ```
   https://ai-voice-agent-anaga.vercel.app
   http://localhost:3000
   ```

5. You do **not** need an authorised redirect URI. This uses Google Identity
   Services' token flow, which posts the credential back to the page rather
   than redirecting.
6. Copy the **Client ID**. It looks like
   `1234567890-abcdefg.apps.googleusercontent.com`.

> **Why not Firebase Auth, which this project already has?** Verifying "is this
> Google ID token real?" needs no privilege — the answer comes from Google's
> public signing keys. The Firebase admin SDK is an omnipotent credential, and
> using an omnipotent key for an unprivileged question is how keys end up in
> the wrong place. The admin key stays scoped to Firestore.
> See `api/_lib/google-identity.js`.

---

## 2. Set the environment variables

Vercel → your project → Settings → Environment Variables. All of these are
**Production + Preview**.

| Variable | Value | What breaks without it |
|---|---|---|
| `SESSION_SECRET` | 32+ random chars (`openssl rand -base64 48`) | Every login returns 503. Refused rather than signed with a weak secret — a guessable one lets anyone mint themselves an owner session. |
| `GOOGLE_CLIENT_ID` | the client id from step 1 | The Google button does not render, and the endpoint returns 503 rather than accepting anything. |
| `ADMIN_EMAILS` | `sumanthbolla97@gmail.com:owner` | Nobody can sign in. This is an **allowlist**, not a filter — an address not named here never gets an account at all. |
| `FIREBASE_SERVICE_ACCOUNT` | the **new** JSON from step 0, on one line | Sign-in returns 503. A session is stateless but the role is re-read from the user record on every request, so there is nowhere to keep the account. |

`ADMIN_EMAILS` takes a comma-separated list, and the role after the colon is
optional (`operator` if omitted, never `owner`):

```
ADMIN_EMAILS=sumanthbolla97@gmail.com:owner,ops@modcon.example:operator
```

Roles are ranked — `owner` ⊇ `operator` ⊇ `viewer`. Changing someone's role in
this variable takes effect on their **next sign-in**, so you can demote
somebody without touching a console.

---

## 3. Check it before you try to sign in

`/api/integrations/health` is public and now reports exactly which of the four
prerequisites is missing:

```bash
curl -s https://<your-deployment>/api/integrations/health | jq .signIn
```

```json
{
  "session": true,          // SESSION_SECRET is set and long enough
  "google":  true,          // GOOGLE_CLIENT_ID is set
  "clientId": "1234…apps.googleusercontent.com",
  "admins":  1,             // how many entries in ADMIN_EMAILS — never the addresses
  "store":   true           // Firestore is reachable
}
```

All four true → sign-in works. Any one false → that is your answer, and each
one fails differently at the login screen (a missing button, a 503, a 403), so
check here first rather than guessing from the symptom.

The allowlist is reported as a **count**, never as addresses. This endpoint is
unauthenticated, and a published list of who the admins are is a phishing
target.

---

## What happens when you sign in

```
browser                          server                       Google
   │
   │  Google Identity Services renders the button
   │  ────────────────────────────────────────────────────────►│
   │  ◄──────────────────────────── ID token (a signed JWT) ────│
   │
   │  POST /api/auth/google { credential }
   │  ─────────────────────►│
   │                        │  fetch Google's PUBLIC signing keys (cached)
   │                        │  ───────────────────────────────────────────►│
   │                        │  verify: signature, issuer, AUDIENCE,
   │                        │          expiry, email_verified
   │                        │  allowlist: is this address in ADMIN_EMAILS?
   │                        │  create-or-load the user record in Firestore
   │                        │  issue the SAME session a password login issues
   │  ◄──── Set-Cookie: anaga_session=…; HttpOnly; Secure; SameSite=Lax
   │
   │  every later request carries the cookie; role is re-read per request
```

The audience check is the one that matters most. A Google ID token issued to a
*different application* is still perfectly signed and perfectly valid — without
comparing `aud` to our own client id, anyone who can register a Google OAuth
client could sign in here as whoever they like. `scripts/test-google-auth.mjs`
forges exactly that token, plus eight other attacks (`alg:none`, wrong key,
expired, unverified address, wrong issuer, unknown key id, future-dated,
partial allowlist match), and asserts each is refused.

### It is a second front door, not a second auth system

Google sign-in mints **exactly** the session the password route mints: same
token format, same cookie, same expiry, same role model. Everything downstream
— `currentUser()`, `requireUser()`, `hasRole()`, the `pwChangedAt` revocation —
is untouched and cannot tell the two apart. There is no second code path to get
wrong later.

A Google-created account has **no** `passwordHash`. That is deliberate and
safe: `authenticate()` compares against a fixed dummy hash when a record has
none, so there is no password to guess and no empty string that verifies.

### Disabling somebody

Setting `disabled: true` on their user document wins over the allowlist. If it
did not, disabling someone would not disable them — which is the entire point
of being able to disable someone.

---

## The other door: email and password

Still there, still works, unchanged. Useful when you want an account that is
not tied to a Google identity.

One-time bootstrap, which refuses once **any** account exists:

```bash
curl -X POST https://<your-deployment>/api/auth/bootstrap \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"a long passphrase","name":"You","token":"<BOOTSTRAP_TOKEN>"}'
```

Needs `BOOTSTRAP_TOKEN` (16+ chars) in the environment as well. It is closed
three ways at once — one account existing shuts it, a missing token shuts it,
and no durable store shuts it — because the alternative is shipping with a
default admin password.

---

## Endpoints

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/api/auth/google` | POST | none (the token *is* the credential) | Google sign-in |
| `/api/auth/login` | POST | none | email + password |
| `/api/auth/me` | GET | session cookie | who am I, what role |
| `/api/auth/logout` | POST | session cookie | clear the cookie |
| `/api/auth/bootstrap` | POST | `BOOTSTRAP_TOKEN` | create the first owner, once ever |

All five are one serverless function (`api/auth.js` dispatches by path). Vercel
Hobby allows 12 and this repo is at exactly 12, so handlers live under
`api/_lib/routes/` — Vercel does not turn those into functions. Adding Google
sign-in cost **zero** additional functions.
