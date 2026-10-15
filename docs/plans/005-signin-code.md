---
summary: >
  Passwordless sign-in by emailed code and link in @_linked/auth (step A5 of CN's master plan
  065): sendSigninCode(email) and signinWithCode(email, code), a client hook method and form,
  rate limits, the dev log line, readme and changeset.
status: Review
---

# 005 — Sign-in by emailed code

**Step:** A5 of [001 — WebID sign-in track](001-webid-signin-track.md#a5--emailed-sign-in-code-and-link),
implementing [contract 5](001-webid-signin-track.md#5-emailed-sign-in-code-a5--webidemail-w4).
The scope, files, pitfalls, tests and Verify checks are in that section; this doc adds the
tasks-mode decisions and the phases.

## Scope (from the sub-plan)

- `sendSigninCode(email)`: emails a short code plus a link carrying it. Single use, short expiry,
  rate-limited and enumeration-safe like `sendResetPasswordLink` (`true` for every well-formed
  email; a limited request gets the rate-limited result). With `DEV_AUTH` on and no email provider
  the code goes to the server log.
- `signinWithCode(email, code)`: checks the code against the email it was sent to, marks that
  email verified, finds or creates the Person (IRI from `Auth.webIdFor`) and its `UserAccount`,
  then the session. A wrong, expired or already-used code is refused with one message.
- `useAuth().sendSigninCode` / `useAuth().signinWithCode` and a form registered in `src/index.ts`.
- Readme: the two methods, their rate-limit rules and environment variables, the dev log line.
- A changeset (minor).

## Decisions (tasks mode, within contract 5)

1. **One secret: a 6-digit code, bound to the email.** The link carries the email and the same
   code (`{SITE_ROOT}/auth/signin-code?email=…&code=…`), so the link and the typed code are the
   same thing and `signinWithCode(email, code)` serves both. The credential stores
   `hashToken(normalisedEmail + '\n' + code)`. Because the hash covers the email, a lookup by hash
   *is* a lookup by email then a compare (the pitfall's requirement), two people holding the same
   code never collide, and the existing atomic `consumeCredentialToken` works unchanged with a new
   kind `signinCode`. Guessing is bounded by the per-email check limit and the short expiry, not
   by the hash (a 6-digit code is not a 160-bit token; the comment on `hashToken` says so).
   Rejected: a long link token plus a short code on the same credential (two secrets, two
   consume paths, and a link that does not fit `signinWithCode(email, code)`).
2. **Storage:** three new token properties on `AuthCredential` `signinCode`, `signinCodeExpiresAt`,
   `signinCodeConsumeMarker` (ontology + shape) and `TOKEN_KINDS.signinCode` with
   `AUTH_SIGNIN_CODE_TTL` (seconds, like the other TTLs; default 15 minutes). A new request
   overwrites the fields, so it replaces the earlier code. Reset and verify tokens are untouched.
3. **Which credential holds the code:** as `sendResetPasswordLink`: the person at
   `Auth.webIdFor(email)`'s credential, else the credential of the person of the `UserAccount`
   with that email (created if it has none). For an email with no person or account, a
   **pending credential** holds the code: no `credentialOf`, no `email`, and the email in its
   own property `signinCodeEmail`; a second request finds it by that property and replaces its
   code. The first code sign-in creates the person at `Auth.webIdFor(email)`, attaches the
   credential and moves the email to `email`. Keeping the email out of `email` means no existing
   lookup by email (signup's `emailAlreadyRegistered`, password sign-in, reset, OAuth's
   `findAccountForOAuthEmail`) ever sees a pending credential, so requesting a code for
   someone's email never blocks their signup or bends their Google sign-in, and no existing
   code or test changes. Rejected: (a) a credential of the not-yet-created person — a Google
   sign-in would match it by email and create an account for a person node that does not exist,
   and signup would refuse the email; (b) a credential of nobody with `email` set — signup
   refuses an email any credential holds (an existing, tested rule). `consumeCredentialToken`
   gains a sibling that also returns the credential id, which attaching needs.
4. **Code format:** eight digits (six before review finding 1) from `crypto.randomInt`; input is normalised by removing
   whitespace and `-`.
5. **Rate limits:** `signinCodeRequest` (as `passwordResetRequest`: 10/hour per IP, 3/hour per
   email) and `signinCode` (10/minute per IP, 5 per 15 minutes per email). Env overrides follow
   `AUTH_RATE_LIMIT_SIGNIN_CODE_REQUEST_*` / `AUTH_RATE_LIMIT_SIGNIN_CODE_*`.
6. **Email and dev log:** `sendAuthEmail`'s purpose gains `'signin-code'`; the dev line is
   `[@_linked/auth] dev: signin-code link: <url> (code <code>)`. A failed send's log redacts the
   link's `code` and the URL-encoded address as well as the token and address.
7. **New user:** created through `Auth.login` with `givenName: ''` (as OAuth without a name), an
   account with the normalised email, and the email marked verified on the existing credential.
8. **Client:** `SigninWithCodeForm` asks for the email, then the code; mounted at
   `/auth/signin-code` it reads `email` and `code` from the URL and shows them filled in, so it is
   also the link's page. It signs in on a press only (review finding 4: mail scanners).

## Phases

### Phase 1 — Backend: storage, rate limits, the two methods, unit tests

Tasks
- `src/ontologies/auth.ts`, `src/shapes/AuthCredential.ts`: the three token properties and
  `signinCodeEmail`.
- `src/helpers/credentialToken.ts`: `TOKEN_KINDS.signinCode`; `hashToken` comment.
- `src/helpers/signinCode.ts` (new): `generateSigninCode`, `normalizeSigninCode`,
  `normalizeSigninEmail`, `signinCodeSecret(email, code)`, `signinCodeFields(email, code, now)`.
- `src/helpers/credentialToken.ts`: `consumeCredentialTokenRecord` (returns the credential id
  and person); `consumeCredentialToken` wraps it.
- `src/utils/rateLimit.ts`: the two rules and defaults.
- `src/utils/email.ts`: purpose `'signin-code'`, optional `code` in the dev line, redaction.
- `src/backend.ts`: `sendSigninCode`, `signinWithCode`, `declareCallable` (both `'public'`).
- `test/exposure.test.mjs` SURFACE; `test/signin-code.test.mjs` (new, harness from
  `password-reset.test.mjs`); a log-hygiene case for a failed code email.

Validation
- `npx linked build && node --test test/signin-code.test.mjs test/exposure.test.mjs test/rate-limit.test.mjs test/log-hygiene.test.mjs`
  pass. The new test covers: session + `emailVerifiedAt` on success; wrong, expired, reused code
  refused with one message; a second request replaces the first; request and check limited;
  dev log line with code and link; same answer for an unknown email; a new email creates the
  person at `Auth.webIdFor(email)` and attaches the credential; signup is not blocked by a
  pending code.

**Done.** `npx linked build && npm test`: `# tests 342 # pass 342 # fail 0` (321 before; 16 in
`signin-code.test.mjs`, 1 in `log-hygiene.test.mjs`, 2 in `webid.test.mjs`, 2 exposure rows).
`test/webid.test.mjs`'s count of `Auth.webIdFor(` call sites in the built backend goes from 5 to
7 (the two new methods), and it gains a case per method.

### Phase 2 — Client: hook methods and form

Tasks
- `src/hooks/useAuth.tsx`: `sendSigninCode(email)`, `signinWithCode(email, code)` (updates auth
  like `signinWithPassword`; returns `{error, action?, retryAfter?}` instead of throwing).
- `src/components/SigninWithCodeForm.tsx` + `.module.css`; register in `src/index.ts`.
- `test/signin-code-form.test.mjs` (jsdom, harness from `verify-email-callback.test.mjs`): the
  link signs in once; typed code calls `signinWithCode`.

Validation
- `npx linked build && node --test test/signin-code-form.test.mjs test/useAuth.test.mjs` pass.

**Done.** `node --test test/signin-code-form.test.mjs test/useAuth.test.mjs` pass; `npm test`:
`# tests 344 # pass 344 # fail 0`. The result type `SigninCodeError` is in `src/types/auth.ts`.

### Phase 3 — Integration test, readme, changeset, Verify

Tasks
- `test/integration/signin-code.fuseki.test.mjs`: a code sign-in against a real dataset creates
  the person, account and session and marks the email verified; reuse is refused.
- `readme.md`: the methods, rate-limit rules and env variables, the dev log line, the link page.
- `.changeset/*.md` (minor).

Validation
- `npx linked build && npm test` and `npm run test:integration` (with `AUTH_TEST_FUSEKI_*`) pass.

**Done.** `test/integration/signin-code.fuseki.test.mjs` (4 tests, including 5 concurrent
sign-ins with one code: exactly one wins). `npm run test:integration` against local Fuseki:
`# tests 38 # pass 38 # fail 0`; `npm test`: `# tests 344 # pass 344 # fail 0`. Readme: *Sign in
with an emailed code*, the rate-limit rows, the dev log lines, *Setup sign-in by code*. The form
shows "You are signed in." after a sign-in, for the link's route where no `onLoggedIn` is given.

### Dependencies

Phase 2 needs phase 1's server methods; phase 3's integration test needs phase 1. Phases 2 and 3
touch different files and could run in parallel; they run in order here (one agent).

## Review

Independent review of `origin/main...HEAD` (3 commits). No critical findings; existing methods
unchanged; no step labels in code.

| # | Severity | Finding | Route |
|---|---|---|---|
| 1 | High | Wrong guesses never burn a code and anyone can keep a live code for any email: 5 checks per 15 min per email is 480 guesses/day against 10^6 codes (~0.05%/day per targeted email) | Within scope: 8 digits (decision 4 allowed 6–8 characters). Burning a code after N wrong guesses needs a new property and changes the method's contract: **follow-up** |
| 2 | Medium | Pending credentials keep the plaintext email of non-users and are never removed | Within scope: store a hash of the email. Removing expired pending credentials (a sweep): **follow-up** |
| 3 | Medium | A pending code used after the person was created another way (not at `Auth.webIdFor(email)`) creates a second person and account | Fix: when the consumed credential has no person, resolve the person as `storeSigninCode` does (person at the WebID, else the person of the account with the email) |
| 4 | Medium | Mail link scanners that run JS open the link and use the code up before the user clicks | Fix (decision 8 is this step's): the link prefills the code; the user presses Sign in |
| 5 | Low | `markEmailVerified` marks every credential of the person, as the spec's helper does | Left as is |
| 6 | Low | Two concurrent first requests for a new email can create two pending credentials | Left as is: each code stays single use and expires |
| 7 | Low (stale doc) | Readme says a refused code is not used up; an expired one is | Fix |
| 8 | Low | The link's "sign in once" ref does not survive a remount | Goes away with 4 |
| 9 | Low | `as any` casts copy `createAccount`'s pattern | Left as is |

## Iteration 1 — Ideation

### Gap 1 of 4: guessing (finding 1)
Approaches: (a) 8 digits; (b) burn the code after N wrong guesses (new counter property, atomic
increment, a wrong guess changes state); (c) tighter limits. (a) keeps the method's contract and
storage, costs two more digits to type, and cuts the odds 100x (~0.0005%/day per targeted email).
(b) is the stronger fix but a design change beyond contract 5 and the spec's rate-limit model.
Chosen: (a) now; (b) reported as a follow-up.

### Gap 2 of 4: plaintext emails of non-users (finding 2)
The pending credential's email is only used to find it again; signing in takes the email from the
request. Chosen: store `hashToken(email)` in `signinCodeEmailHash` (renamed from
`signinCodeEmail`). Cleanup of expired pending credentials is a follow-up.

### Gap 3 of 4: stale pending code after another signup (finding 3)
Chosen: when the consumed credential has no person, take the person at `Auth.webIdFor(email)` if
it exists, else the person of the `UserAccount` with the email, else create one at the WebID.

### Gap 4 of 4: link scanners (finding 4)
Approaches: auto sign-in (scanners spend the code) or a confirm click. Chosen: the link opens the
code step with the email and code filled in; the user presses Sign in. The `redeemed` ref goes.

## Iteration 1 — Plan

- `src/helpers/signinCode.ts`: `SIGNIN_CODE_LENGTH = 8`.
- `src/ontologies/auth.ts`, `src/shapes/AuthCredential.ts`: `signinCodeEmail` → `signinCodeEmailHash`.
- `src/backend.ts`: `storeSigninCode` writes/finds the hash; `signinWithCode` resolves the person
  for a pending credential through a shared helper.
- `src/components/SigninWithCodeForm.tsx`: no auto sign-in.
- Tests: 8 digits; a stale pending code after a signup elsewhere signs in to that person; a failed
  send for a new email; the form test clicks Sign in.
- `readme.md`: 8 digits, the hash, the click, the expired-code sentence.

## Iteration 1 — Phases

### Phase 4: review fixes
Validation: `npx linked build && npm test` and `npm run test:integration` pass.

**Done.** Code length 8; `signinCodeEmailHash` holds `hashToken(email)`; a pending code resolves
the person at sign-in (3 new unit tests: an account elsewhere, a person at the WebID, a failed
send for a new email); the form signs in on a press only. `npm test`: `# tests 347 # pass 347
# fail 0`; `npm run test:integration`: `# tests 38 # pass 38 # fail 0`.

## REVIEW

Re-review of the iteration-1 commit: findings 1–4 and 7 addressed (1 partly, as planned), no
regression; one stale JSDoc on `sendSigninCode` fixed. Only low findings remain (5, 6, 9, the
unsalted email hash). Report: [008](../reports/008-signin-code.md). Follow-ups for the master
plan: burn a code after N wrong guesses; sweep expired pending credentials. Ready for PR.
