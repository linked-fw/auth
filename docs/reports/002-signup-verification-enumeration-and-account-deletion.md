---
date: 2026-10-12
summary: >
  Released as 3.4.0 (minor). Sign-up now sends an email verification link and the session reports
  a soft `emailVerified` flag; sign-in and password reset give the same answer whether or not an
  account exists; createAccount refuses any existing person, account or credential for the email
  and checks a minimum password length on the server; reset and verification tokens are used up
  atomically; mail failures are caught (links logged under DEV_AUTH); emails are HTML-escaped; and
  removeAccount asks for a password or a fresh Google/Apple ID token. removeAccount's result is
  now `true | {error, action, …}`, so a truthy result no longer means deleted. Lists the accepted
  low risks and what consuming apps must change.
---

# 002 — Signup verification, enumeration and account deletion proof

This report is for whoever works on `@_linked/auth` next. It replaces plan 002 and records what
3.4.0 changed, why each design was chosen, and what was deliberately left open. The CHANGELOG
says what changed; this says why.

PR: [linked-fw/auth#108](https://github.com/linked-fw/auth/pull/108)

## Problem

Backlog 003 (now removed) listed what was left after 3.2.0; re-checked against 3.3.0:

- **Enumeration.** `signinWithPassword` had three answers ("This email is not registered", "No
  password found for this email", "Invalid email / password combination").
  `sendResetPasswordLink` answered an unknown email with "No password is associated…".
- **Signup.** `createAccount` refused only when a Person existed at `emailToWebID(email)`, did
  not check the password on the server, and had no email verification. The remaining risk was
  squatting: someone registers your email first. (Takeover through OAuth was already blocked:
  `decideEmailMatchedAccount` refuses to attach an OAuth sign-in to an account with a password.)
- **Mail.** `LinkedEmail.send` throws synchronously without a provider; `sendResetPasswordLink`
  did not catch it, after storing the token. An unused ZeptoMail client was built at startup.
- Reset tokens were not consumed atomically; `checkSignin`, `removeAccount` and
  `Auth.setAuthentication` read the request unguarded; `removeAccount` deleted with a session
  alone; `signinDev` accepted a verified token without `sub`.

## Decisions

**D1 — Email verification is a soft flag, not a gate.** Signup still signs the user in at once
and sends a verification email. Auth stores `emailVerifiedAt` and the session carries
`emailVerified`; each app decides what an unverified account may not do. A completed password
reset (the link came from the inbox) and a Google or Apple sign-in with a provider-verified email
that maps to the person also verify it. *Rejected: a hard gate* (no session until verified). It
would have let signup hide whether an account exists, but it is a breaking change and breaks
signup in any app that has not registered an email provider. A future gate can build on the
flag, and only a gate would let signup stop saying "in use" (D2).

**D2 — Signup still says "email already in use".** Signup signs the user in, so it cannot answer
the same for every case; its 10/hour per-IP limit makes it a slow probe. Sign-in and reset give
one answer each. `createAccount` refuses any existing Person, UserAccount or AuthCredential for
the email, and checks the password length before any lookup.

**D3 — `removeAccount` takes the proof in the same call.** `removeAccount({password})` or
`removeAccount({provider, source})`. A fresh ID token is the "recent sign-in" check, so sessions
need no sign-in timestamp. Accounts with nothing to check against delete with the session alone.
*Rejected: sign out, sign back in, redirect back* (the user clicks delete twice or the app stores
and replays the request). *Rejected: a session-age check* (new session state plus the same
redirect).

**D4 — Mail without a provider never fails the request.** Failures are caught. A failed reset
send clears the stored token; a failed signup send leaves the account created and unverified.
With `DEV_AUTH` on and no provider, the link is printed to the server log. ZeptoMail and its
dependency were removed.

**D5 — The optional backlog items are in.** The token consume is atomic, and `signinDev`
refuses a token without `sub` (`{error: 'Invalid token'}`).

**Request guards.** `checkSignin` reads `this.request?.linkedAuth`. `Auth.setAuthentication`
and `updateSessionData` touch `request.linkedAuth` only when there is a request, and still return
the linkedAuth object and set the query context. `removeAccount`, `getReauthenticationMethods` and
`resendEmailVerification` take the account from `requireSessionUser()`.

**Fixes from the first review (iteration 1).**

- The `removeAccount` result changed from a boolean to `RemoveAccountResult`. The refusal object
  is truthy, so `if (await removeAccount()) signout()` signs out without deleting. The readme and
  changeset open with this warning and a before/after snippet.
- `resendEmailVerification` answering `{verified: true}` now refreshes the session client-side.
- Names in email HTML were unescaped, so signup (which mails any typed address) could send
  phishing markup from the app's real sender. Every interpolated value is now escaped.
- Duplicated token logic, and one `consumeMarker` shared by both kinds (opening a reset and a
  verification link at once could waste one), became `TOKEN_KINDS` with a marker per kind.
- The 11 lockfile orphans left by ZeptoMail (`axios` and its tree) were removed by regenerating
  the lockfile in a clean clone, never with `npm install` in the localized checkout.
- Expired-token handling, tested only on the fake, now has Fuseki cases.

**Decisions after the second review.**

- **Minor bump (3.4.0), not major.** Iteration 1 chose 4.0.0. The user overrode it: the method
  is rarely called, and the readme's "Upgrading to 3.4" section and the changeset lead with the
  `=== true` warning. *Rejected: major*, and also *rejected: a falsy refusal* to keep it minor,
  which would break the package's `{error, action}` convention and still change behaviour.
- **No email in logs on signup.** The `Auth.login` label for signup is just `createAccount`.
- **`VerifyEmailCallback`'s once-only guard is keyed on the token**, so a route reused for a new
  link redeems the new token.

## Architecture

**Where the fields live.** On the auth-owned `AuthCredential`, not on the account (the account
shape is app-provided via `AUTH_ACCOUNT_TYPE`). New terms in `src/ontologies/auth.ts` and getters
on the shape: `emailVerifiedAt`, `emailVerificationToken`, `emailVerificationTokenExpiresAt`,
`passwordResetConsumeMarker`, `emailVerificationConsumeMarker`. (`src/data/auth.json` holds no
property definitions, so it was not changed.) A person counts as verified when **any** of their
credential rows has `emailVerifiedAt`; persons can have several rows (OAuth, older releases).
The WebID derives from the email, so "verified for which email" does not arise while email change
is not a feature. `createAccount` now writes the normalized `email` on the credential.

**`TOKEN_KINDS`** (`src/helpers/credentialToken.ts`) is the one table of single-use tokens:

| Kind | Token field | Expiry field | Marker | TTL |
|---|---|---|---|---|
| `reset` | `forgotPasswordToken` | `forgotPasswordTokenExpiresAt` | `passwordResetConsumeMarker` | `AUTH_PASSWORD_RESET_TTL`, 1 hour |
| `verify` | `emailVerificationToken` | `emailVerificationTokenExpiresAt` | `emailVerificationConsumeMarker` | `AUTH_EMAIL_VERIFICATION_TTL`, 7 days |

Tokens are 160 random bits (`PasswordHelper.generateToken()`), stored as SHA-256 base64url
(`hashToken`). The module also owns `tokenExpiresAt`, `clearUnsentToken(kind, hash)` and
`consumeCredentialToken(kind, token, now)`. A single shared `consumeMarker` existed during
development and was never released.

**Atomic consume, and why it is race-safe on Fuseki.** The store has no compare-and-set and no
update reports what it matched. But `AuthCredential.update(data).where(cond)` compiles to one
SPARQL `DELETE … INSERT … WHERE`, and Fuseki/TDB2 runs one update request as one write
transaction with a single writer. So:

1. Read the row's expiry by token hash (expiry cannot be compared in a `where`, and the update
   removes it).
2. One where-mode update removes token and expiry and writes a fresh random marker, matched on
   the token hash.
3. Select by the marker. Only the request whose update matched finds its own marker; a loser
   matched nothing and wrote nothing.
4. The winner clears the marker. A win on a different row than the pre-read one, or a pre-read
   expiry in the past, is invalid. An expired token is still used up.

`null` unsets fields in where mode (checked on Fuseki), so no `rawQuery` fallback exists. With
the old consume restored, the integration race gives three successes.

**How `emailVerified` reaches the client.** `Auth.buildAuthSession` sets it from
`personEmailVerified(person.id)` before the app hooks run, so sign-in, refresh, the access token
and SSR (`supplyDataForRequest`) carry it; `updateSessionData` carries it explicitly. It costs one
credential query per refresh; a store error yields `false`. The access token is stale until
the next refresh, which is why `useAuth().verifyEmail` and `resendEmailVerification` run the
single-flight `refreshAccessToken()` when signed in. Server code gating a sensitive action should
call `personEmailVerified` rather than trust the token. Dev accounts store no credential, so they
normally report `false`.

**`markEmailVerified(personId, email?)`** is idempotent: it sets `emailVerifiedAt` and clears
the verification token on every unverified row, or creates a verified row if the person has none.
Callers: `verifyEmail` (failure is an error); token reset, after the password write so the new
session reports true; and the three `signinOAuth` paths when the provider's verified email maps to
the person (`emailToWebID(identity.email) === person.id`). In the last two a failure is only
logged. New OAuth users' credentials are created verified.

**`sendAuthEmail(options, devLink)`** never throws and returns `'sent'`, `'logged'` or
`'failed'`. With `DEV_AUTH` (`'true'` or `true`) and no default provider it prints
`[@_linked/auth] dev: <purpose> link: <url>`; the token stays valid. Otherwise a failure is logged
with the addresses, the link and its token redacted (a provider error may echo them), and the
caller clears the token with `clearUnsentToken`, keyed by its hash so a newer link survives. The
verification link is `${SITE_ROOT}/auth/verify-email?token=…`. `escapeHtml` escapes `& < > " '`
and maps a missing value to `''`; every template value is escaped, `APP_NAME` and URLs included.

**Enumeration and passwords.** When no credential with a `passwordHash` is found, sign-in runs
`bcrypt.compare` against a lazily computed dummy hash at `PASSWORD_HASH_COST`, so an unknown
email costs about as long as a wrong password. `createAccount`'s duplicate check compares the
normalized and the raw email, because older rows stored the raw input. `MIN_PASSWORD_LENGTH`,
`isAcceptablePassword` and `INVALID_PASSWORD_RESULT` are shared by signup, token reset and
password change, so they cannot drift; token reset checks the length before using up the token.

**The deletion proof.** `reauthenticationMethods(accountId, personId)` is `['password']` when the
person has a password, otherwise the account's linked providers filtered to google/apple,
otherwise `[]`. `verifyReauthentication` checks:

- `{password}`: against `getPasswordForUser({id: personId})` with `PasswordHelper.checkPassword`,
  as a password change does.
- `{provider, source}`: through `verifyOAuthIdentity`, the same path as `signinOAuth`
  (signature, audience, expiry, verified email, Apple's nonce under `AUTH_APPLE_NONCE`). Then
  `issuedAt` (`iat`, now returned for Google and by `AppleHelper.decodeIdentityToken`) must be at
  most `REAUTH_MAX_TOKEN_AGE` (10 minutes) old, since `exp` alone would accept a cached Google
  token up to an hour old. A token without `iat` is not fresh. Finally
  `OAuthIdentityStore.findLinks(provider, subject)` must contain a link to this account.

Any valid proof counts, not only the preferred one: a linked Google token on a password account is
as strong as the password. A proof is "sent" when the object has a `password` or `provider` key; a
malformed one gets the wrong-proof answer and counts against the rate limit, which applies only
when a proof is checked. Accounts with no methods delete with just a session and ignore any proof:
temporary and dev accounts, and accounts with neither a password nor a Google/Apple link (e.g.
Facebook-only or WebID-token accounts). The person id is
`linkedAuth.user.id ?? account.accountOf.id`; a session with neither throws.

## Public API

New and changed `AuthBackendProvider` methods (all declared by auth via `declareCallable`):

| Method | Role | Returns |
|---|---|---|
| `verifyEmail(token)` | `public` | `{verified: true}`, or `{error: 'This verification link is invalid or has expired.', action: 'resend_verification'}`; no session needed, signs no one in |
| `resendEmailVerification()` | `user` | `{sent: true}`, `{verified: true}` (already verified, nothing sent), or `{error, action: 'no_email' \| 'rate_limited' \| 'email_failed', retryAfter?}` |
| `getReauthenticationMethods()` | `user` | `{methods: ReauthenticationMethod[]}` |
| `removeAccount(proof?)` | `user` | `true`, `{error: 'Confirm it is you to delete this account.' \| 'That confirmation did not match this account.', action: 'reauthenticate', methods}`, or `{error, action: 'rate_limited', retryAfter}` |
| `createAccount(data)` | `public` | unchanged shape; new refusals `change_email_or_log_in` (any existing record) and `invalid_password` |
| `signinWithPassword` | `public` | failure is always `{error: 'Invalid email / password combination.'}` |
| `sendResetPasswordLink` | `public` | `true` for every well-formed email |
| `resetPassword`, `changePassword` | unchanged | can answer `invalid_password` |

`resendEmailVerification` takes the email from the stored account, then the session, and writes
the token on the person's password row, else the first row, else a new row.

- **Types** (`@_linked/auth/types/auth`): `AuthSession.emailVerified?`,
  `VerifiedOAuthIdentity.issuedAt?`, `VerifyEmailResult`, `ResendEmailVerificationResult`,
  `ReauthenticationMethod` (`'password' | 'google' | 'apple'`), `RemoveAccountProof`
  (`{password} | {provider: 'google' | 'apple', source}`), `RemoveAccountResult`.
- **`useAuth`**: `emailVerified: boolean`, `verifyEmail(token)`, `resendEmailVerification()`,
  `getReauthenticationMethods()`, `removeAccount(proof?)`.
- **`RemoveAccountButton`**: `confirmationText?`, `agreeText?`, `className?` (now optional),
  `getOAuthSource?(provider: 'google' | 'apple') => Promise<unknown>`, which resolves to what
  `signinOAuth` takes as its second argument (auth ships no provider SDKs). It loads the methods
  when Delete is clicked: a password field (confirm disabled until filled), one "Confirm with
  Google/Apple" button per method (disabled with a hint without `getOAuthSource`), or a plain
  confirm. The proof goes with the same click; a `reauthenticate` answer keeps the dialog open.
  If loading the methods fails it opens a plain confirm and the server's answer supplies them.
- **`VerifyEmailCallback`** (`@_linked/auth/components/VerifyEmailCallback`, optional
  `onEmailVerified`): reads `?token=`, waits until `validating` is false, redeems once per token,
  shows verified or invalid (with a resend button when signed in). The app routes
  `/auth/verify-email` to it.
- **Helpers**: `personEmailVerified`, `markEmailVerified`, `verificationTokenFields`,
  `clearedVerificationTokenFields` (`helpers/emailVerification`); `MIN_PASSWORD_LENGTH`,
  `INVALID_CREDENTIALS_MESSAGE`, `INVALID_PASSWORD_RESULT`, `isAcceptablePassword`
  (`helpers/password`); `escapeHtml`, `sendAuthEmail` (`utils/email`).
- **Env**: `AUTH_EMAIL_VERIFICATION_TTL` (seconds, default 7 days); `DEV_AUTH` (see above).
- **Rate-limit rules** (overridable as `AUTH_RATE_LIMIT_<RULE>_<IP|ACCOUNT>`):

| Rule | Call | Per IP | Per account |
|---|---|---|---|
| `emailVerificationRequest` | `resendEmailVerification` | 10 / hour | 3 / hour |
| `emailVerify` | `verifyEmail` | 10 / minute | |
| `reauthenticate` | `removeAccount` when a proof is checked | 10 / minute | 5 / 15 minutes |

## Files

| File | Responsibility |
|---|---|
| `src/helpers/credentialToken.ts` (new) | `TOKEN_KINDS`, hashing, expiry, atomic consume, clearing unsent tokens |
| `src/helpers/emailVerification.ts` (new) | verification token fields, `markEmailVerified`, `personEmailVerified`; no bcrypt import, so `utils/auth.ts` stays light |
| `src/helpers/password.ts` | password rules, uniform sign-in message, dummy-hash compare; reset-token wrappers kept because they were already released |
| `src/utils/email.ts` (new) | `sendAuthEmail`, `escapeHtml`, log redaction |
| `src/helpers/apple.ts` | returns `iat` |
| `src/ontologies/auth.ts`, `src/shapes/AuthCredential.ts`, `src/types/auth.ts` | new properties and types |
| `src/utils/auth.ts` | `emailVerified` in `buildAuthSession`/`updateSessionData`; request guards |
| `src/utils/rateLimit.ts` | three rules |
| `src/backend.ts` | the RPC changes; module-level `sendVerificationEmail`, `markOAuthEmailVerified`, `reauthenticationMethods`, `verifyReauthentication`; ZeptoMail removed |
| `src/helpers/reauthentication.ts` (new) | `REAUTH_MAX_TOKEN_AGE`, kept out of the `backend.ts` barrel |
| `src/utils/date.ts` (new) | `toDate`, shared by the token helpers and `sessions.ts` without pulling in token-TTL env parsing |
| `src/hooks/useAuth.tsx`, `src/components/RemoveAccountButton.tsx` | client additions, proof UI |
| `src/components/VerifyEmailCallback.tsx` (new) | verification route; registered in `src/index.ts` |
| `package.json`, `package-lock.json` | `zeptomail` and its orphans removed |

## Tests

| Test file | Covers |
|---|---|
| `signup.test.mjs` (new) | duplicate person/account/credential, mixed case, short password creates nothing, normalized email |
| `enumeration.test.mjs` (new) | one answer for the three sign-in failures; dummy compare on unknown email |
| `request-guards.test.mjs` (new) | `setAuthentication` and `checkSignin` without a request |
| `email-verification.test.mjs` (new) | hashed, expiring, single-use and concurrent consume; resend outcomes; escaped name; cross-kind markers |
| `remove-account.test.mjs` (new) | proof missing/wrong/right, OAuth-only, subject linked elsewhere, stale or missing `iat`, bad provider, the limit, 401 |
| `remove-account-button.test.mjs` (new) | jsdom render: password field, wrong password, Google in one click, no `getOAuthSource`, no methods |
| `verify-email-callback.test.mjs` (new) | redeems once per token |
| `password-reset.test.mjs` | concurrent resets, uniform `true`, failed sends clear the token, `DEV_AUTH` logging, escaping, short password |
| `log-hygiene`, `oauth`, `rate-limit`, `tokens`, `exposure`, `apple`, `signin-dev`, `useAuth` | no address/token in failure logs; OAuth marks verified; new rules; `emailVerified` in sessions; `SURFACE`; `iat`; no `sub`; client refreshes and proof argument |
| `integration/accounts.fuseki` | create, verify, reuse refused, refresh to verified; expired tokens refused and removed; deletion proof |
| `integration/sessions.fuseki` | three racing resets give one success and leave no marker |

Shared fakes: `test/fakeStore.mjs` (in-memory shape tables with `update().where()`) and
`test/cssStub.mjs` (CSS imports under node). Run integration tests without `DEV_AUTH`, or
emailed-link cases log the link instead of calling the mocked send.

Final counts: **302 unit tests, 31 Fuseki integration tests**, all passing.

## Docs

Readme: "Upgrading to 3.4" (truthy warning first), "Sign-in and reset answers" (with the timing
caveat), "Email verification", "Delete account" (with `getOAuthSource` and custom-UI examples
using `methods[0]`), "Email configuration" (`LinkedEmail.setDefaultProvider`, no-provider and
`DEV_AUTH` behaviour, replacing the `lincd-zeptomail` sentence), "Setup Verify Email", the RPC and
rate-limit tables, `AUTH_EMAIL_VERIFICATION_TTL` in the env table, and the reset route's import
path corrected to `@_linked/auth/components/ForgotPasswordCallback`. The consuming app's
architecture docs were updated for the soft flag, dev links in the log and the deletion proof.

## Consuming-app follow-up

Apps on `rpcExposure: 'enforce'` that pin auth's RPC surface in their own table must expect
`verifyEmail` (public), `resendEmailVerification` (user) and `getReauthenticationMethods` (user),
or their drift check refuses to start. Apps with a custom signup page should check the password
length and show the server's `invalid_password` error. Every `removeAccount()` caller must compare
`=== true`.

## Known limitations and accepted risks

- **Reset timing.** A reset for a real account sends mail and takes longer than one for an unknown
  email. Accepted: the per-email (3/hour) and per-IP (10/hour) limits make timing probes slow.
  Documented in the readme.
- **`verifyEmail` uses up the token before marking.** If `markEmailVerified` then fails, the link
  is spent and the user must resend.
- **`RemoveAccountButton` gaps:** no message when `getOAuthSource` fails, server errors are shown
  untranslated, the password input has no `aria-invalid`, and an account with a password and a
  Google link is offered only the password.
- **Google tokens carry no nonce**, so a captured token can be replayed as a deletion proof within
  the 10-minute window, the same exposure `signinOAuth` has. Apple tokens are bound to a nonce
  when the client sends one (always, with `AUTH_APPLE_NONCE=required`).
- **Several hashed credential rows.** Which one `getPasswordForUser` picks is undefined; a person
  with two rows holding different passwords gets an arbitrary check.
- **Duplicated email templates** for reset and verification in `backend.ts`.
- **The person-id expression** (`linkedAuth.user.id ?? account.accountOf.id`) is repeated in three
  methods.
- **Test gaps:** no Apple case in `remove-account.test.mjs`, and no button test for a failing
  methods load. The fake store returns whole rows whatever is selected, so select lists are not
  tested (expiry is covered against Fuseki).
- Also accepted: some exported constants are unused; older phase labels in comments predate
  this work.
