---
date: 2026-10-09
summary: >
  Why @_linked/auth went from 3.0.0 to 3.0.6 in a week. A review of the sign-in paths found
  Apple identity tokens accepted for any app, Facebook sign-in trusting a client-supplied email,
  password reset links that never expired, a bcrypt cost of 4 and a password change that did not
  ask for the current password. Each was fixed in its own patch release. 3.0.6 stops the server
  dispatching auth's internal provider methods over HTTP and fixes the `types` entry. Lists the
  open items (Apple nonce, matching accounts by email, no rate limit) and what consumers must
  configure. The rate limit item was closed in 3.2.0 (see the section on it). From 3.3.0 auth
  declares its whole RPC surface, so apps in `rpcExposure: 'enforce'` need no declarations of
  their own (see the section on it).
---

# 001 — Sign-in security review, 3.0.1 to 3.0.6

This report is for whoever maintains `@_linked/auth` next. It records why a run of patch
releases happened, what each one found, and what was decided, including what was deliberately
left open. The CHANGELOG says what changed; this says why.

The work was part of a wider dependency and checkout maintenance effort across the `linked-fw`
packages. Create Now keeps the sibling report for it ("Dependency and checkout maintenance",
report 074 in the Create Now repository's `docs/reports/`), which covers the Renovate backlog
and the test breakage described under *Also in this period*.

## How the fixes were shipped

Each fix was released on its own so a consumer could take them one at a time. Each is a patch:
none changes an API a consumer calls, though several make a request that used to succeed fail.
(3.0.5, #87, only declared the `react` peer dependency and is not part of this review.)

## What was found and fixed

### 3.0.1 (linked-fw/auth#79): Apple tokens were accepted for any app

`jwt.verify(identityToken, publicKey)` was called with no options. The signature was checked,
but not who the token was for, so a genuine Apple identity token issued to **any** app signed in
here.

Now the verification pins `algorithms: ['RS256']`, `issuer: 'https://appleid.apple.com'` and an
`audience` read from `APPLE_CLIENT_ID` (the Services ID, used on the web) and
`APPLE_CLIENT_ID_IOS` (the app's bundle ID). Each may be a comma-separated list. **It fails
closed:** with neither variable set, every Apple sign-in is refused. `email_verified` is
enforced, and the helper returns `null` rather than throwing, so a bad token is a refused
sign-in rather than a 500.

### 3.0.2 (#81): Facebook sign-in trusted the client's email

`signinOAuth` verified Google and Apple tokens, but had no verification branch for Facebook. The
email the client sent went straight to `Auth.login`, so anyone could sign in as any account by
naming its email. Consumers expose `signinOAuth` publicly (it has to run before there is a
session), so this was reachable by anyone.

Decision: only providers in `VERIFIED_OAUTH_PROVIDERS = ['google', 'apple']` are accepted, and
the email is taken only from the verified token, never from the request. Facebook stays off
until it has real token verification. That is the scope of the open PR #32.

### 3.0.3 (#83): password reset links never expired

A reset link worked forever and could be used more than once, and the raw token was stored, so
anyone who could read the store could reset any password with an outstanding link.

Now a link is single-use (the token is consumed when used, valid or not), expires after
`AUTH_PASSWORD_RESET_TTL` seconds (default 3600), and only its SHA-256 hash is stored. Tokens
stored by earlier releases have no expiry recorded and are treated as expired. Changing the
password while signed in clears any outstanding link. The expiry is a new ontology term,
`forgotPasswordTokenExpiresAt`; it is additive, like `sessionStartedAt`, so no migration is
needed.

In the same release `signinDev` stopped storing an email supplied by the client.

### 3.0.4 (#85): weak password hashing, password change without the current password

- **bcrypt cost raised from 3 to 10** (`PASSWORD_HASH_COST`). bcrypt clamps 3 to its minimum of
  4, so every stored hash is cost 4. Measured on an M1 Pro with native bcrypt 6: cost 4 takes
  about 1.4 ms per hash, cost 10 about 86 ms. 10 is the usual default and still cheap for a
  sign-in.
- **Stored hashes are upgraded on sign-in.** After a successful password check, a hash with
  `getRounds < 10` is replaced by a cost-10 hash of the password just verified. A failure there
  is logged and never blocks the sign-in; the next sign-in tries again. There is no other way to
  upgrade a bcrypt hash, since the password is only known at sign-in.
- **Changing a password without a reset token now requires `currentPassword`.** Before, a
  signed-in session alone was enough, so a stolen session could take over the account for good.
  In the UI the no-token path is `EditPasswordButton` → `CreateNewPasswordForm`; the email path
  carries the reset token and does not ask. An account with no password yet (OAuth only) is
  sent to the email flow instead.
- **A `files` list was added to package.json**, so the tarball carries only `lib`, the readme
  and the CHANGELOG (132 files → 121).

### 3.0.6 (this release): internal provider methods, and `types`

**Provider methods the server must never dispatch.** 3.0.4 added `upgradePasswordHash(credential,
plainPassword)` to the backend provider for the re-hash above. It is only called from
`signinWithPassword`, after the password check. But every instance method of a backend provider
is reachable over `/call/@_linked/auth/<method>` unless something says otherwise, and in the
server's default `warn` exposure mode an undeclared method runs. TypeScript's `protected` does
nothing at runtime. So anyone could have called it with any credential id and set that
credential's password. Create Now caught this with its exposure test, which blocks it on its own
side, but other consumers had no such list.

`@_linked/server-utils` 1.9 added the mechanism for this: `declareInternal(cls, methods)` (or the
`@internal()` decorator) in `@_linked/server-utils/utils/callable`. The server answers 501 for
an internal method in every exposure mode, the declaration is inherited by subclasses (an
app's override stays internal), and backend-to-backend calls are not affected. auth now declares
its own internal methods at the bottom of `backend.ts` and `shapes/AuthCredentialProvider.ts`,
and requires `@_linked/server-utils` `^1.9.0` (it was `^1.8.0`, which did not have the module).

The rule used to choose them: a method that acts on a credential, person or account named by
its arguments, with no check of who is asking, and that no frontend calls.

| Provider | Method | Exposed, it would |
|---|---|---|
| `AuthBackendProvider` | `upgradePasswordHash` | set any credential's password |
| `AuthBackendProvider` | `getPasswordForUser` | return any person's password hash |
| `AuthBackendProvider` | `getOrCreateAccount` | create an account for any WebID |
| `AuthBackendProvider` | `loadAccountForSession` | return any account's email |
| `AuthBackendProvider` | `loadUserForSession` | return any person's name and phone number |
| `AuthCredentialProvider` | `createNewCredential` | add a password to any person |

`resetPassword` reaches `createNewCredential` through `AuthCredential.createNewCredential`, a
backend-to-backend `Server.call`, which keeps working. `test/exposure.test.mjs` checks these
declarations, and that the methods auth's frontend calls are not internal.

Left undeclared on purpose (all three resolved in 3.3.0, see *3.3.0: auth declares its RPC surface*):

- `hasAuthCredential` tells whether any person has a password. It is an account-enumeration leak
  rather than a takeover, and `AuthCredential.hasAuthCredential` is a client-side wrapper for it,
  so a consumer may call it from a browser. It should probably become internal, with callers
  moved to `userHasAuthCredential` (which answers for the signed-in user only).
- `checkSignin`, `validateRequestToken`, `refreshSession`, `getTokenFromRequest`,
  `getTokenCandidates` and `getRefreshTokenFromRequest` act on the caller's own request or
  tokens. Reachable, they give a caller nothing it does not already have. A consumer may still
  declare them internal (Create Now does).
- auth does not yet declare its **callable** methods (`declareCallable` / `@callable`). Until it
  does, a server in `enforce` mode answers 501 for sign-in unless the app declares them, as
  Create Now does.

**`types`.** package.json had `"types": "index.d.ts"`, a file that has never been in the
tarball. It now points at `lib/esm/index.d.ts`, the same file the `exports` map's `types`
condition uses. Only tools that ignore `exports` read this field.

## Also in this period

- #78 fixed the tests for server-utils ≥ 1.9, which reads `provider.request` and `response`
  from a per-call request context, so assigning them in a test stopped working. The
  `test/serving.mjs` helper runs a test's calls inside a request context. This unblocked the
  lockfile maintenance PR #77.
- google-auth-library 11 (#74) and jwks-rsa 4 (#76) were checked to behave identically to the
  versions they replaced: 16 Google and 12 Apple checks, including a real Google ID token from
  the OAuth Playground.
- **google-auth-library 11 requires Node ≥ 22.**

## 3.0.7: OAuth hardening ported from PR #32

PR #32 (abdipramana, with commits by René) predated 3.0.1–3.0.6 and could no longer be rebased
without undoing them. What `main` still lacked was ported onto 3.0.6 as five commits in one PR:

- **Tokens and emails stay out of the log.** google-auth-library puts the raw JWT in its error
  message (`Invalid token signature: <jwt>`), and auth logged it, along with whole OAuth payloads,
  emails and serialized users. Errors are now logged as constant lines and ids only.
- **The session cookie had an illegal name.** `@_linked/auth` fails `cookie.serialize`, so any
  request that wrote `req.session` never finished. It is now `linked.auth`
  (`SESSION_COOKIE_NAME`).
- **Removing an account removes every credential and identity token** of it, and async
  `onAccountWillBeRemoved` listeners are awaited. Where duplicate credential rows exist, the one
  with a password hash is used.
- **OAuth sign-in is by the provider's subject, and attaching to an existing email account only
  happens when it is safe.** Before, an attacker could create a password account with a
  victim's email (sign-up does not verify it); the victim's later Google sign-in landed in that
  account, whose password the attacker still knew. Now a sign-in whose email matches an account
  that has a password, or another link at the same provider, returns
  `{error, action: 'sign_in_to_link'}`: the user signs in the way they did before and links the
  provider from inside the session with `linkOAuthIdentity`. Identity tokens are no longer
  stored, only the subject link. `useAuth().signinOAuth` returns `{error, action}`.
- **Apple sign-in can carry a server-issued, single-use nonce** (`createOAuthNonce`), checked
  against the token's `nonce` claim (hashed for native, verbatim for web) and consumed on use.
  `AUTH_APPLE_NONCE=optional` (default) checks it when present; `required` refuses tokens
  without one. A nonce taken from the client, as in #32, can be copied out of the token itself,
  so it had to be issued by the server.

Facebook verification from #32 was not shipped. Its helper needs an account rule first: Facebook
gives no `email_verified`, so a Facebook-only account must not receive the email-derived WebID,
or the email's owner can lose the account to whoever created the Facebook link.

## Known open items

- **Facebook sign-in** stays refused until verification ships with the account rule above.
- **Apple nonce is optional by default**; switch to `AUTH_APPLE_NONCE=required` once every
  client sends one.
- **`signinDev` accepts any WebID when the token has no `sub`.** It is dev-only and left as is
  on purpose.
- ~~**No rate limit on password attempts.**~~ Addressed in 3.2.0, see below.
- **Single-use reset is not atomic.** The store has no compare-and-swap, so two requests racing
  with the same token can both succeed.

## 3.2.0: rate limits

The open item "no rate limit on password attempts" is closed. Every call that checks a
credential, sends an email or creates something is now limited by client IP and, where it names
an account, by that account: `signinWithPassword`, `createAccount`, `sendResetPasswordLink`,
`resetPassword` (with a token, and the signed-in change that checks the current password), the
refresh-token exchange in `validateToken`, `signinOAuth`, `linkOAuthIdentity`, `signinTemporary`
and `hasAuthCredential`. The defaults and settings are in the readme (*Rate limits*);
`AUTH_RATE_LIMIT=off` turns them off.

Decisions:

- **The account key is the email as typed, normalized, counted before any lookup**, so a limited
  answer is the same for an account that exists and one that does not. (The unlimited answers of
  `signinWithPassword` and `sendResetPasswordLink` still differ between the two; that is a
  separate enumeration issue.)
- **Every attempt counts, refused ones included,** and the count is taken with one atomic
  increment, so concurrent requests cannot overshoot the limit. The price is that someone who
  knows an email can keep that account's password sign-in limited (5 a minute by default) from
  many addresses. That stops when they stop; it does not lock the account, and OAuth and reset
  links are not affected.
- **The answer is in-band** (`{error, action: 'rate_limited', retryAfter}`, plus `Retry-After`),
  not an HTTP 429: `Server.call` resolves a non-2xx response as `undefined`, which the existing
  forms would not show. `hasAuthCredential` returns a boolean, so it fails with 429.
- **In-memory counters, per process**, with a `setRateLimitStore` interface for a shared store.
  The client IP is Express's `request.ip`, so a deployment behind a proxy must set `trust proxy`.

## 3.3.0: auth declares its RPC surface

The three items left undeclared in 3.0.6 are closed. auth now declares every method of both
providers, callable or internal, so a server in `rpcExposure: 'enforce'` keeps sign-in working
without the app declaring anything (Create Now had been declaring auth's whole table itself).
The table is in the readme (*RPC surface*).

- **Callable.** What auth's frontend calls: sign-in, sign-up, recovery, `validateToken` and
  `signout` are `public` (they run before there is a session, or after the access token
  expired); `linkOAuthIdentity`, `removeAccount`, `userHasAuthCredential` and `userHasPassword`
  are `user`.
- **`hasAuthCredential` is internal,** and the client wrapper `AuthCredential.hasAuthCredential`
  is removed: nothing called it, and it answered for any person. `userHasAuthCredential` /
  `userHasPassword` answer for the signed-in user.
- **`checkSignin`, `validateRequestToken`, `refreshSession`, `getTokenFromRequest`,
  `getTokenCandidates` and `getRefreshTokenFromRequest` are internal.** No client code calls
  them; the client refreshes through `validateToken`.
- A dead call in `SigninWithPasswordForm` to `signinDevelopment`, a method that does not exist,
  is removed.

`test/exposure.test.mjs` runs each method through the server's own gates in `enforce` mode, reads
every `Server.call` in `src/` and checks it reaches a callable method at the intended level, and
fails when a provider method is added without a declaration.

## For consumers

- **Set `APPLE_CLIENT_ID` (web) and/or `APPLE_CLIENT_ID_IOS` (iOS) wherever Apple sign-in is
  used.** Without them, from 3.0.1 on, every Apple sign-in fails. The PeaceGame data shows Apple
  users; Create Now does not use Apple sign-in.
- **Facebook sign-in is refused** from 3.0.2 on.
- **From 3.0.7, handle `action: 'sign_in_to_link'`** from `signinOAuth`: ask the user to sign
  in with their existing method, then call `linkOAuthIdentity`. Apps with an RPC exposure list
  declare `linkOAuthIdentity: 'user'`, `createOAuthNonce: 'public'` and
  `userHasPassword: 'user'`.
- **The session cookie is `linked.auth` from 3.0.7.** Nothing could set the old name, so no
  session is lost.
- **A password change form must send the current password** from 3.0.4 on, unless it carries a
  reset token.
- **On 3.0.4 or 3.0.5, an app with an RPC exposure list should list `upgradePasswordHash` as
  internal.** From 3.0.6 on, auth declares it (and the others above) itself; an app's own
  declaration of the same method is harmless.
- **3.0.6 needs `@_linked/server-utils` 1.9 or later.** An app pinned to 1.8 would get a second
  copy of server-utils.
- **From 3.3.0, an app needs no declarations for auth's methods** in `rpcExposure: 'enforce'`;
  its own copies are harmless and can go. Code that called `AuthCredential.hasAuthCredential`
  from a browser must use `userHasAuthCredential` / `userHasPassword`. Wrap the store holding
  auth's shapes (including `UsedOAuthNonce`) with `withAccess({read: 'none', write: 'none'})`.
- **From 3.2.0, behind a reverse proxy, set Express's `trust proxy`** to the proxies in front of
  the app, or every client shares the proxy's rate limit budget. Run several instances with a
  shared `setRateLimitStore` for global limits, and set `AUTH_RATE_LIMIT=off` in test runs that
  sign in more often than a person would. A form may show `retryAfter` when `action` is
  `rate_limited`.
