---
summary: >
  Passwordless sign-in by emailed code in @_linked/auth: sendSigninCode(email) emails an
  eight-digit code and a link carrying it, signinWithCode(email, code) redeems it once, marks the
  email verified and signs in (creating the person at the configured WebID for a new email), with
  two rate-limit rules, a dev log line, useAuth() methods and SigninWithCodeForm.
---

# 008 — Sign-in by emailed code

## Outcome

Any Linked app can sign users in without a password: the user types their email, receives an
eight-digit code and a link carrying it, and signs in with either the link or the typed code (the
code lets a link opened on one device be used on another). It is a method next to password; the
existing methods, their tokens and rate limits are unchanged. webid.email's sign-in pages (W4)
and Create Now's `local`-mode test (C1) use it, reading the code from the dev log line.

Step A5 of [plan 001](../plans/001-webid-signin-track.md#a5--emailed-sign-in-code-and-link),
implementing its contract 5. PR [#123](https://github.com/linked-fw/auth/pull/123). Design: arch-08 §Verified email decides the WebID and §Dev-mode identity, and
plan 063 decision 9, in Create Now.

## Public API

Server (`AuthBackendProvider`, both declared `'public'`):

- `sendSigninCode(email)` → `true` for every well-formed email (account or not, sent or not), or
  `{error: 'Invalid email format'}`, or the rate-limited result. Emails the code and the link
  `${SITE_ROOT}/auth/signin-code?email=<encoded>&code=<code>`. A new request replaces the earlier
  code. A failed send removes the stored code again.
- `signinWithCode(email, code)` → the normal `AuthenticationResult` (session, tokens) or
  `{error: INVALID_SIGNIN_CODE_MESSAGE, action: 'invalid_code'}` for a wrong, expired, used code
  or one tried with another email; or the rate-limited result. Case and surrounding spaces in the
  email and spaces/dashes in the code are ignored.
- `INVALID_SIGNIN_CODE_MESSAGE` is exported from `backend.ts`.

Client:

- `useAuth().sendSigninCode(email)` → `true | SigninCodeError`.
- `useAuth().signinWithCode(email, code)` → the auth response (and updates auth, like
  `signinWithPassword`) or `SigninCodeError`; it never throws on a refused code.
- `SigninCodeError = {error, action?, retryAfter?}` in `src/types/auth.ts`.
- `SigninWithCodeForm` (`@_linked/auth/components/SigninWithCodeForm`, registered in
  `src/index.ts`; props `onLoggedIn`, `email`, `className`): asks for the email, sends the code,
  asks for the code, showing (read-only) the email it was sent to. Mounted at `/auth/signin-code`
  it is also the link's page: it fills in the code from the URL, asks the user to **type their
  email**, and signs in **when the user presses Sign in**, never on its own. After sign-in it
  shows "You are signed in." (for the link route, where no `onLoggedIn` is set).

```tsx
const auth = useAuth();
await auth.sendSigninCode(email);
const result = await auth.signinWithCode(email, code);
if ('error' in result) showError(result.error); // 'invalid_code' | 'rate_limited'
```

Environment:

| Variable | Meaning |
|---|---|
| `AUTH_SIGNIN_CODE_TTL` | code lifetime in seconds, default 900 (15 minutes); read once at startup |
| `AUTH_RATE_LIMIT_SIGNIN_CODE_REQUEST_<IP\|ACCOUNT>` | override the request rule |
| `AUTH_RATE_LIMIT_SIGNIN_CODE_<IP\|ACCOUNT>` | override the check rule |
| `DEV_AUTH=true` (and no email provider) | the code and link go to the log |

Dev log line (the one place a code is logged on purpose):

```
[@_linked/auth] dev: signin-code link: https://app.test/auth/signin-code?email=ada%40example.test&code=12345678 (code 12345678)
```

## How it works

### Storage

`TOKEN_KINDS.signinCode` in `src/helpers/credentialToken.ts`, next to `reset` and `verify`, with
its own three `AuthCredential` properties (ontology `auth:` + shape): `signinCode` (hash),
`signinCodeExpiresAt`, `signinCodeConsumeMarker`. Its own kind means a reset link and a code on
the same credential never consume each other.

**One secret, bound to the email, keyed.** The token is
`signinCodeSecret(email, code)` = HMAC-SHA256 of `code\n<normalizedEmail>\n<code>` under a key
derived from `JWT_SECRET` (`keyedDigest` in `src/helpers/signinCode.ts`); the credential stores
`hashToken` of it, as for every token kind. The key matters: a plain hash of an email and eight
digits is reversed by trying every code once the email is known, so a copy of the store would
have given away every live code; reset and verification tokens (160 random bits) never had this
problem. A new `JWT_SECRET` ends outstanding codes. Because the token covers the email:

- a lookup by hash is a lookup by email then a compare, as a short code requires (a plain hash
  lookup across all credentials would let any guess match anyone's code);
- two people holding the same digits never collide;
- the existing atomic `consumeCredentialToken` machinery (DELETE/INSERT with a random consume
  marker, one winner among concurrent calls) works unchanged. `consumeCredentialTokenRecord` is
  its new sibling that also returns the credential id; `consumeCredentialToken` wraps it.

The link carries the same code as the email text, so `signinWithCode(email, code)` serves both.
Rejected: a long link token plus a short code (two secrets, two consume paths, and a link that
does not fit contract 5's `signinWithCode(email, code)`).

### Which credential holds the code (`storeSigninCode`, `src/backend.ts`)

As `sendResetPasswordLink` finds a credential: the credential of the person at
`Auth.webIdFor(email)`; else of the person of the `UserAccount` with that email (created for that
person if it has none). For an email with **no person or account**, a **pending credential**
holds the code: no `credentialOf`, no `email`, and `signinCodeEmailHash = signinCodeEmailKey(email)`
(the same keyed HMAC, with an `email` prefix).

- No lookup by email (signup's `emailAlreadyRegistered`, password sign-in, reset, OAuth's
  `findAccountForOAuthEmail`) reads `signinCodeEmailHash`, so requesting a code for someone's
  email never blocks their signup or bends their Google sign-in, and no existing code changed.
- Only a keyed hash of the address is stored, so the store keeps no address of someone who never
  signed in, and a list of addresses does not reverse it without the server secret.
- A second request finds the pending credential by the hash and replaces its code.

Rejected along the way: a credential of the not-yet-created person (a Google sign-in would match
it by email and create an account for a person node that does not exist; signup would refuse the
email), and a credential of nobody with `email` set (signup refuses an email any credential
holds, an existing tested rule).

### Signing in (`signinWithCode`)

1. Rate limit `signinCode` by IP and by the email, before anything is looked up.
2. Consume the code atomically. Refused → `invalid_code`. A wrong code, or one tried with another
   email, leaves the right one working; an expired one is used up.
3. A pending credential resolves its person at sign-in, the same way `storeSigninCode` would:
   the person at the WebID if it exists by now, else the person of the account with the email,
   else a new one at the WebID. The credential is attached to it and gets `email`.
4. Existing person: `dropUnprovenAccess` (below), `markEmailVerified`, `getOrCreateAccount`,
   `Auth.onSigninSuccessful`.
   New person: `Auth.login` creates the person (`givenName: ''`, as OAuth without a name), marks
   the email verified on the attached credential, creates the account with the email.

### The first proof of an email ends unproven access (`dropUnprovenAccess`)

Sign-up signs in without verifying the email, so someone may register the owner's email with a
password of their own and wait (pre-account hijacking). When a code sign-in reaches a person
whose email is not verified yet (`personEmailVerified` false), before marking it verified:

- every `passwordHash` on the person's credentials is removed (the owner sets a password through
  a reset link if they want one);
- every session of the person's accounts is revoked (`revokeAllSessionsForAccount`).

The new session is created after this, so it survives. A person whose email is already verified
keeps both. A legitimate user who signed up with a password and never opened the verification
link loses that password on their first code sign-in; that is the price of not being able to
tell them from someone who registered their email.

### Rate limits (`src/utils/rateLimit.ts`)

| Rule | Calls | Per IP | Per account (email) |
|---|---|---|---|
| `signinCodeRequest` | `sendSigninCode` | 10 / hour | 3 / hour |
| `signinCode` | `signinWithCode` | 10 / minute | 5 / 15 minutes |

With eight digits and 5 checks per 15 minutes per email (480 a day), guessing one targeted email's
code succeeds with about 5·10⁻⁶ a day. A wrong guess does not end the code, so the `signinCode`
account limit is the only per-email bound: the readme says never to turn it off.

### Email (`src/utils/email.ts`)

`sendAuthEmail`'s purpose gains `'signin-code'` (type `AuthEmailPurpose`) and an optional `code`
printed in the dev line. A failed send's log now redacts the link's `token` **and** `code`
parameters, the code, and the URL-encoded address, besides the address and the link.

## Files

| File | Responsibility |
|---|---|
| `src/helpers/signinCode.ts` (new) | `SIGNIN_CODE_LENGTH = 8`, `generateSigninCode` (`crypto.randomInt`), `normalizeSigninCode`, `normalizeSigninEmail`, `keyedDigest` (private), `signinCodeSecret`, `signinCodeEmailKey`, `signinCodeFields` |
| `src/helpers/credentialToken.ts` | `TOKEN_KINDS.signinCode`, `DEFAULT_SIGNIN_CODE_TTL`, `consumeCredentialTokenRecord`; `hashToken` comment |
| `src/ontologies/auth.ts`, `src/shapes/AuthCredential.ts` | `signinCode`, `signinCodeExpiresAt`, `signinCodeConsumeMarker`, `signinCodeEmailHash` |
| `src/backend.ts` | `sendSigninCode`, `signinWithCode`, `storeSigninCode`, `personOfAccountEmail`, `dropUnprovenAccess`, `signinCodeMessage` (the email; the code is in the body, not the subject), `INVALID_SIGNIN_CODE_MESSAGE`; `declareCallable` |
| `src/utils/rateLimit.ts` | the two rules |
| `src/utils/email.ts` | purpose, dev line with code, redaction |
| `src/types/auth.ts` | `SigninCodeError` |
| `src/hooks/useAuth.tsx` | `sendSigninCode`, `signinWithCode` |
| `src/components/SigninWithCodeForm.tsx` + `.module.css`, `src/index.ts` | the form / link page |
| `readme.md` | *Sign in with an emailed code* (keyed hashes, the first proof of an email, never turning the per-email limit off), RPC table, rate-limit rows, dev log lines, *Setup sign-in by code* |
| `docs/backlog/004-signin-code-hardening.md` | the two deferred follow-ups |
| `.changeset/signin-code.md` | minor |

## Tests

- `test/signin-code.test.mjs` (new, 22): session and `emailVerifiedAt`; the first proof of an
  email removes unverified passwords and revokes earlier sessions, a verified person keeps both;
  codes are keyed (the stored value is not the plain hash, and another `JWT_SECRET` refuses the
  code); loose email/code matching; wrong code, other email, empty/missing code, malformed email
  refused without using the code up; single use; expiry (15 minutes, used up); a second request
  replaces the first; a reset link and a code do not consume each other; unknown email → same
  answer, pending credential with only a keyed email hash, sign-in creates person + account and
  attaches the credential; a second request reuses the pending credential; signup not blocked by
  a pending code; legacy person found by account email; a pending code after the email got a
  person elsewhere or at the WebID (no second person); configured derivation (HMAC test vector);
  request and check rate limits; the DEV_AUTH log line; failed send removes the code (account and
  no-account cases).
- `test/signin-code-form.test.mjs` (new, 3, jsdom): the link fills in the code, leaves the email
  to be typed and signs in only on a press (nothing called on load, nothing without an email); a
  link made from someone else's email signs in with the typed email; the typed flow shows the
  email read-only on the code step.
- `test/log-hygiene.test.mjs` (+1): a failed code email logs neither the address (plain or
  encoded) nor the code.
- `test/webid.test.mjs`: `Auth.webIdFor(` call sites in the built backend 5 → 7, plus a case per
  new method. `test/exposure.test.mjs`: the two methods in the public surface.
- `test/integration/signin-code.fuseki.test.mjs` (new, 4, real Fuseki): a new email creates person,
  account and session with `emailVerified: true`, the code works once, a second code reaches the
  same account; a code on an unverified password account verifies it, removes the password and
  revokes the signup's session while the code session refreshes; five concurrent sign-ins with one
  code → exactly one wins; a pending code does not block signup.

Totals on `main` with A1 and A3 merged: `npm test` 419/419; `npm run test:integration` 38/38.

## Review

Two independent reviews. The first (inside the step) led to eight-digit codes, a hashed pending
email, resolving a stale pending code's person, and a link page that never signs in on its own.
The second (master plan) found three medium issues, all fixed in this PR:

1. Unkeyed hashes: a store dump gave away every live code (an eight-digit search per known email)
   and reversed pending emails with a list of addresses → keyed HMAC for both.
2. Pre-account hijacking through an unverified password signup → `dropUnprovenAccess`.
3. Login CSRF: a link made from an attacker's email and live code signed the victim in to the
   attacker's account → the link page takes the email from the user, never from the URL.

And three low ones: the code is no longer in the email subject, the readme warns against turning
off the per-email check limit, and the code placeholder has eight digits.

## Known limitations and follow-ups

Deferred, in [backlog 004](../backlog/004-signin-code-hardening.md):

- **Wrong guesses do not end a code.** Guessing is bounded by the per-email check limit and the
  lifetime only.
- **Pending credentials are never removed**, including those whose code was removed after a
  failed send.

Accepted:

- `markEmailVerified` marks every credential of the person verified, as for the other methods.
- Two concurrent first requests for a new email can create two pending credentials; each code
  stays single use and expires.
- The dev log needs `DEV_AUTH=true` as well as no email provider (as for reset and verification
  links); contract 5 already says so.
