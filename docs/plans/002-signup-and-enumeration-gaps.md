---
summary: >
  Close the gaps left from backlog 003. Sign-in and reset give the same answer whether or not an
  account exists. createAccount refuses any existing account for the email and validates the
  password on the server. Signup gets email verification. Request reads in checkSignin,
  removeAccount and setAuthentication are guarded, and removeAccount re-authenticates the user.
status: Review
source: docs/backlog/003-remaining-rpc-and-signup-gaps.md
---

# 002 — Signup verification, enumeration and request guards

Source: [backlog 003](../backlog/003-remaining-rpc-and-signup-gaps.md), re-checked against
`cbaf163` (3.3.0) on 2026-10-12.

## Already done (backlog items that no longer apply)

- The dead `signinDevelopment` call was removed in 1687fe9.
- The readme already has "Keep auth's data off the generic query plane" (`withAccess` plus
  `setDatasetForShapes`, readme.md:309-328).
- `checkSignin` is declared internal (by auth and by CN). `linkOAuthIdentity` optional-chains
  `this.request`.

## Current state

**Enumeration**

- `signinWithPassword` gives three different answers:
  - unknown email: "This email is not registered" (`src/backend.ts:437`)
  - account with no credential row: "No password found for this email" (`:456`)
  - wrong password: "Invalid email / password combination" (`:468`)
- `sendResetPasswordLink` answers an unknown email with "No password is associated…" (`:837`).
- `createAccount` answers "already in use" with `action: 'change_email_or_log_in'` (`:541`).
- No UI branches on these strings. `SigninWithPasswordForm` already shows its own fixed message.
  `ForgotPasswordForm` and `CreateAccountForm` show the server text as-is. CN never calls the
  password sign-in or reset methods from its client.

**Signup**

- `createAccount` (`:505-603`):
  - refuses only when a Person exists at `emailToWebID(email)`
  - does not check the password on the server
  - creates the Person, AuthCredential (with hash) and UserAccount
  - signs the user in at once through `Auth.login`
- No shape has an `emailVerified` property.
- Takeover risk is already limited. `decideEmailMatchedAccount` refuses to attach an OAuth
  sign-in to an account that has a password. The remaining risk is squatting: someone else
  registers your email first. A password reset over email recovers the account.

**Email**

- `LinkedEmail` (server-utils) is a provider registry. CN registers no provider, so
  `LinkedEmail.send` throws synchronously.
- `sendResetPasswordLink` does not catch that throw, and it has already stored the reset token by
  then. Reset email therefore does not work in CN today.
- The ZeptoMail client built in `setupBeforeControllers` (`:246`) is never used.

**Reset tokens**

- Stored on AuthCredential as `forgotPasswordToken` (a SHA-256 hash) and
  `forgotPasswordTokenExpiresAt`.
- Single-use, but consuming one is not atomic.
- The fields belong to the reset purpose only.

**Request reads**

- `checkSignin` reads `this.request.linkedAuth` and `removeAccount` reads `this.request` (`:1231`)
  without a guard.
- `Auth.setAuthentication` reads `request.linkedAuth?.sid` and assigns `request.linkedAuth` without
  a guard (`src/utils/auth.ts:199,263`).
- `requireSessionUser()` from server-utils `CallContext` exists, but auth does not use it yet.
- `removeAccount` takes no password. Some accounts have no password: OAuth-only accounts, and
  temporary and dev accounts that have no credential at all.

**Rate limits**

- `limitRequest(rule, …)` with a closed union of rule names (`src/utils/rateLimit.ts:36-79`).

## Test surface

- Quick: `npx linked build && npm test`. This is `node --test test/*.test.mjs` against `lib/esm`
  and takes under a minute.
- Full: `npm run test:integration` (needs Fuseki on :3030). It covers create, sign-in and remove in
  `test/integration/accounts.fuseki.test.mjs`.
- Gap: no unit tests for the `createAccount` duplicate check or for the enumeration answers.

## Open items

| # | Item | Blocks plan? |
|---|---|---|
| 1 | What an unverified account can do (soft flag vs hard gate) | yes |
| 2 | Enumeration on signup (depends on 1) | yes |
| 3 | `removeAccount` re-authentication for accounts without a password | yes |
| 4 | Email when no provider is registered (dev, CN today) | no, default proposed |
| 5 | Atomic reset-token consume, `signinDev` without `sub` (optional in backlog) | no |

All five are decided below.

## Decisions

### D1 — Email verification is a soft flag, not a gate

- Signup works as it does now: the user is signed in at once, and a verification email is sent.
- Verification state:
  - Auth stores `emailVerifiedAt`.
  - The auth response includes `emailVerified`.
  - Each app decides what an unverified account may not do.
- New methods, both declared by auth itself:
  - `verifyEmail(token)` (`public`)
  - `resendEmailVerification()` (`user`, with its own rate-limit rule)
- The email also counts as verified after:
  - a completed password reset (the link was opened from the inbox)
  - a Google or Apple sign-in whose email the provider has verified
- Verification tokens are hashed, expire and are single-use, as reset tokens are. They have their
  own fields, separate from the reset fields.
- Ships as a minor release. CN's signup keeps working without a mail provider.
- Rejected: a hard gate, where `createAccount` issues no tokens until the email is verified.
  - It would hide on signup whether an account exists.
  - It would be a major release.
  - It would break CN signup until CN registers an email provider.

### D2 — Signup still says "email already in use"

- Signup signs the user in at once (D1), so it cannot give one answer for every case.
- Signup is rate-limited at 10 per hour per IP, which makes it a slow way to check emails.
- Sign-in and reset always give the same answer:
  - Sign-in: "Invalid email / password combination."
  - Reset: "If an account exists for this email, we've sent a link."
- `createAccount` refuses when any of these already exist for the email: a Person, a UserAccount
  or an AuthCredential.
- `createAccount` checks the password on the server (minimum length).

### D3 — `removeAccount` takes the proof in the same call

- Signatures: `removeAccount({password})` or `removeAccount({provider, source})`.
- How the proof is checked:
  - A password is checked the same way password change checks it.
  - An ID token goes through the same checks as `signinOAuth` (signature, audience, expiry,
    nonce). Its subject must be a Google or Apple identity linked to this account.
  - A freshly issued ID token is the "recent sign-in" check, so sessions do not need to track
    how long ago the user signed in.
- Accounts with nothing to check against (temporary and dev accounts) are deleted with only a
  valid session.
- Missing or wrong proof returns
  `{error, action: 'reauthenticate', methods: ['password'] | ['google', 'apple']}`.
- New method `getReauthenticationMethods()` (`user`). The UI uses it to decide what to show before
  the user clicks.
- `removeAccount` takes the user from `requireSessionUser()`.
- `RemoveAccountButton`:
  - shows a password field in the confirm dialog when the account has a password
  - otherwise shows "Confirm with Google/Apple", which calls a new prop
    `getOAuthSource(provider) => Promise<source>`; auth does not ship the provider SDKs
  - calls `removeAccount` in the same click once it has the proof, so nothing has to be replayed
- Upgrade guidance goes in the readme and the changeset:
  - `removeAccount()` with no arguments now fails with `action: 'reauthenticate'` for any account
    that has a password or an OAuth link.
  - Apps that use `RemoveAccountButton` only add `getOAuthSource` if they offer OAuth.
  - Apps with their own delete UI call `getReauthenticationMethods()` and send the proof.
  - Apple's redirect (`form_post`) flow on web cannot be used for this, because the page state is
    lost. Use Apple's popup mode.
- Released as a minor version. The method is rarely used, and CN does not call it (CN only lists
  it in its exposure map).
- Rejected:
  - Signing out, signing back in and redirecting back. The user has to click delete again, or the
    app has to store the request and replay it.
  - A session-age check. It needs new state in the session and the same redirect.

### D4 — Mail without a provider

- When `LinkedEmail.send` throws, the error is caught in both the reset and verification paths.
- When the email cannot be sent:
  - Reset: the stored token is cleared again.
  - Signup: the account is still created and stays unverified.
- With `DEV_AUTH` on, the link is printed to the server log instead.
- The unused ZeptoMail client in `setupBeforeControllers` is removed.

### D5 — Optional backlog items are in scope

- The reset-token consume becomes atomic: one conditional update, so two requests with the same
  token cannot both succeed.
- `signinDev` refuses a token that has no `sub`.

### Request guards (no decision needed)

- `checkSignin` uses `this.request?.linkedAuth`.
- `Auth.setAuthentication` stops reading and writing `request.linkedAuth` when there is no request.
- `removeAccount` gets the user from `requireSessionUser()` (D3).

## Plan

### Architecture decisions made concrete

**Where verification state lives.** On the auth-owned `AuthCredential`, not on the account. The
account shape is app-provided (`AUTH_ACCOUNT_TYPE`), and auth already keeps everything it owns
about a person's email (reset token, email, password hash) on the credential.

| New ontology term (`src/ontologies/auth.ts`, `src/data/auth.json`) | On `AuthCredential` | Meaning |
|---|---|---|
| `auth:emailVerifiedAt` (`xsd:dateTime`) | `emailVerifiedAt: Date` | When the person proved control of the email |
| `auth:emailVerificationToken` | `emailVerificationToken: string` | SHA-256 (base64url) of the outstanding verification token |
| `auth:emailVerificationTokenExpiresAt` (`xsd:dateTime`) | `emailVerificationTokenExpiresAt: Date` | When it stops working |
| `auth:consumeMarker` | `consumeMarker: string` | Random marker written by an atomic token consume (see below) |

- A person counts as verified when **any** of their credential rows has `emailVerifiedAt`.
  Persons can have several rows (OAuth, older releases, reset on an account without one).
- The WebID is derived from the email (`emailToWebID`), so there is no "verified for which email"
  question while email change is not a feature.
- `createAccount` now also writes `email` (normalized) on the credential it creates. It didn't
  before; the reset path relies on `UserAccount.email` instead.
- Verification TTL: `AUTH_EMAIL_VERIFICATION_TTL`, default 7 days, read with `readTtlFromEnv`
  like `AUTH_PASSWORD_RESET_TTL`.
- New helper module `src/helpers/emailVerification.ts`, mirroring `password.ts`:
  - `verificationTokenFields(token, now?)`, `clearedVerificationTokenFields()`, `hashToken(token)`.
    Reuse `PasswordHelper.generateToken()` (160 random bits).
  - `markEmailVerified(personId, email?, now?)` updates every credential row of the person that
    lacks `emailVerifiedAt`, setting it and clearing the verification token fields. A person
    without any row gets a new row `{credentialOf, email, emailVerifiedAt}`. It is idempotent.
  - `personEmailVerified(personId): Promise<boolean>` returns false on any store error.

**How `emailVerified` reaches the client.**

- `AuthSession` (`src/types/auth.ts`) gets `emailVerified?: boolean`.
- `Auth.buildAuthSession` sets it from `personEmailVerified(person.id)` before the app hooks run.
  Sign-in and refresh both go through it, and so does the access token payload.
- `setAuthentication` keeps it, because it spreads the payload. Two places in
  `updateSessionData` have to carry it explicitly: `newAuthSession` and the `auth` passed to
  `deliverTokens`.
- `supplyDataForRequest` copies `linkedAuth`, so SSR gets it for free.
- The access token goes stale after a verification. The client fixes that: `useAuth().verifyEmail`
  calls `refreshSession()` (a forced `validateToken`) when signed in, and `refreshSession` rebuilds
  the session from the store.

**Atomic token consume (D5).**

- The store offers no compare-and-set, and no API reports what an update matched.
  `UpdateBuilder.exec` resolves `void` in where mode, and `deleteWhere` always returns `count: 0`.
- It does compile `AuthCredential.update(data).where(cond)` to **one** SPARQL
  `DELETE {…} INSERT {…} WHERE {…}` (`_linked-core/src/sparql/irToAlgebra.ts` `updateWhereToAlgebra`).
  Fuseki/TDB2 runs one update request as one write transaction with a single writer, so two
  concurrent consumes cannot both match.
- To learn who won, the consume writes a fresh random marker in the same update and reads it back:
  1. `N = randomBytes(16)`
  2. `await AuthCredential.update({forgotPasswordToken: null, forgotPasswordTokenExpiresAt: null, consumeMarker: N}).where(c => c.forgotPasswordToken.equals(H))`
  3. `const row = await AuthCredential.select(c => [c.credentialOf]).where(c => c.consumeMarker.equals(N)).one()`
     - Only the request whose update matched finds its own `N`. A loser matches nothing and
       writes nothing.
  4. The winner clears `consumeMarker`.
- Expiry cannot be compared in a `where` (dates are not supported there; see
  `UsedNonceStore.markUsed`), and the update has already removed `forgotPasswordTokenExpiresAt`.
  So the consume reads the row's expiry **before** the update (as `findResetPasswordCredential`
  does now), keyed by credential id. After winning, it decides validity from that pre-read
  expiry. An expired token is still used up, as it is today.
- The verification-token consume in `verifyEmail` works the same way, generalized as
  `consumeCredentialToken({tokenField, expiresField, hash})` in a small shared helper,
  `src/helpers/credentialToken.ts`, used by both.
- `rawQuery` is the fallback only if `update().where()` with `null` values turns out not to unset
  in where mode. That fallback only works when the shapes are pinned to a `FusekiStore`, not
  through a router. Check this first in the phase that builds it.

**Rate-limit rules** (`RateLimitRuleName` union, `RATE_LIMIT_DEFAULTS`, readme table).

| Rule | Call | Per IP | Per account |
|---|---|---|---|
| `emailVerificationRequest` | `resendEmailVerification` (sends an email) | 10 / hour | 3 / hour (signed-in account) |
| `emailVerify` | `verifyEmail` | 10 / minute | |
| `reauthenticate` | `removeAccount` when it checks a password or ID token | 10 / minute | 5 / 15 minutes (signed-in account) |

**`removeAccount` proof (D3).**

- Add a module-level helper (outside the class, like `verifyOAuthIdentity`):
  `verifyReauthentication(provider, accountId, personId, proof)`.
  - Password proof: load the credential with `getPasswordForUser({id: personId})`, then
    `PasswordHelper.checkPassword`.
  - ID-token proof:
    - only `VERIFIED_OAUTH_PROVIDERS`
    - `verifyOAuthIdentity(provider, source)`: the exact path `signinOAuth` uses, covering
      signature, audience, expiry, email verified, and Apple's nonce under `AUTH_APPLE_NONCE`
    - then `OAuthIdentityStore.findLinks(provider, identity.subject)` must contain a link whose
      `accountId === account.id`
- **Freshness.** `VerifiedOAuthIdentity` gets `issuedAt?: Date` (`iat`). `GoogleHelper` already
  returns the payload; `AppleHelper.decodeIdentityToken` must also return `iat`. `removeAccount`
  refuses a token older than `REAUTH_MAX_TOKEN_AGE` (10 minutes, a constant). This makes "freshly
  issued" concrete (see open questions).
- Methods for an account:
  - `personHasPassword(personId)` → `['password']`
  - otherwise `findLinkedProviders(accountId)` filtered to google/apple
  - otherwise `[]`, meaning no proof is needed (temporary and dev accounts)
- Any valid proof is accepted, even one that is not the preferred method. A linked Google token
  on a password account is as strong as the password.
- The session comes from `requireSessionUser()`, which returns the `userAccount`. The person id is
  `this.request?.linkedAuth?.user?.id ?? account.accountOf?.id`, and it is an error if neither
  exists.

**Enumeration (D2).**

- Sign-in: one message for all three failures. Define `INVALID_CREDENTIALS_MESSAGE = 'Invalid
  email / password combination.'`.
  - When no credential with a hash is found, run `bcrypt.compare` against a fixed dummy hash at
    `PASSWORD_HASH_COST`, so the unknown-email path costs about as long as a wrong password.
  - The dummy hash is computed once, lazily, in `password.ts`.
- Reset: `sendResetPasswordLink` returns `true` for every well-formed email. That covers a known
  account, an unknown one, a missing person and a failed send. Only `Invalid email format` and
  `rate_limited` still return errors.
  - The return type does not change, and the form shows the uniform text.
  - Residual: a send to a real account takes longer than "no account". This is accepted: the
    per-email limit of 3/hour and the per-IP limit of 10/hour make timing enumeration slow. It
    goes in the readme as a known limit.
- `createAccount` refuses when any of these exist:
  - a Person at `emailToWebID(email)`
  - a `UserAccount` (configured `accountShape`) whose `email` equals the normalized email, or
    the raw one, because older rows stored the raw input
  - an `AuthCredential` whose `email` equals the normalized email or whose `credentialOf` is
    the WebID

  The answer stays `{error: 'This email address is already in use…', action: 'change_email_or_log_in'}`.
- Password check: `MIN_PASSWORD_LENGTH = 6`, exported from `helpers/password.ts`, which matches
  `minLength: 6` in `CreateAccountForm` and `CreateNewPasswordForm`. A non-string or short password
  gets `{error: 'Password must be at least 6 characters', action: 'invalid_password'}`. The check
  runs before any lookup.

**Mail (D4).** New `src/utils/email.ts`:

```ts
export type AuthEmailOutcome = 'sent' | 'logged' | 'failed';
/** Send an auth email. Never throws (LinkedEmail.send throws synchronously without a provider). */
export async function sendAuthEmail(
  options: EmailOptions,
  devLink: { purpose: 'reset' | 'verify'; url: string }
): Promise<AuthEmailOutcome>;
```

- With `DEV_AUTH` on (`'true'` or `true`) and `!LinkedEmail.hasDefaultProvider()`, it prints
  `[@_linked/auth] dev: <purpose> link: <url>` with `console.info` and returns `'logged'`. The
  token stays valid.
- Otherwise it awaits `LinkedEmail.send` inside `try` and returns `'sent'` or `'failed'` (the error
  is logged without the address).
- `'failed'` clears the reset token (`clearedResetPasswordTokenFields`) or the verification token.
  The signup account stays unverified.
- Remove `zeptoMail` (field, import, construction) and the `zeptomail` dependency from
  `package.json`. Check that nothing else imports it.
- The verification link is `${SITE_ROOT}/auth/verify-email?token=<raw>`, built like the reset link.

**Request guards.**

- `checkSignin` returns `this.request?.linkedAuth?.userAccount`.
- `Auth.setAuthentication(request | undefined, …)` only reads and assigns `request.linkedAuth`
  (in both the outer function and `updateSessionData`) when `request` exists. It still returns
  the linkedAuth object and sets the query context.
- `updateSessionData` falls back to the closure's `linkedAuth` when there is no request.

**`signinDev`.** A verified token without `sub` returns `{error: 'Invalid token'}`. The current
`claims.sub && …` check becomes `!claims.sub || claims.sub !== input.webId`, which also refuses a
missing `sub`.

### Contracts

```ts
// src/types/auth.ts
export type AuthSession<…> = { userAccount; user; sid?; emailVerified?: boolean; updateSessionData? };
export type ReauthenticationMethod = 'password' | 'google' | 'apple';
export type RemoveAccountProof =
  | { password: string }
  | { provider: 'google' | 'apple'; source: unknown }; // source: as signinOAuth's oauthUserData
export type RemoveAccountResult =
  | true
  | { error: string; action: 'reauthenticate'; methods: ReauthenticationMethod[] }
  | { error: string; action: 'rate_limited'; retryAfter: number };
export type VerifyEmailResult = { verified: true } | { error: string; action?: string; retryAfter?: number };
export type ResendEmailVerificationResult =
  | { sent: true } | { verified: true } // already verified: nothing sent
  | { error: string; action?: 'no_email' | 'rate_limited' | 'email_failed'; retryAfter?: number };

// AuthBackendProvider
createAccount(data: CreateAccount): Promise<AuthenticationResult>;           // unchanged shape; new refusals above
signinWithPassword(email: string, password: string): Promise<AuthenticationResult>; // failure: {error: INVALID_CREDENTIALS_MESSAGE}
sendResetPasswordLink(email: string): Promise<true | {error: string; action?: string; retryAfter?: number}>;
verifyEmail(token: string): Promise<VerifyEmailResult>;                       // 'public'
resendEmailVerification(): Promise<ResendEmailVerificationResult>;           // 'user'
getReauthenticationMethods(): Promise<{ methods: ReauthenticationMethod[] }>; // 'user'
removeAccount(proof?: RemoveAccountProof): Promise<RemoveAccountResult>;     // 'user' (unchanged level)
```

- `verifyEmail`:
  - An unknown, used or expired token returns `{error: 'This verification link is invalid or
    has expired.', action: 'resend_verification'}`.
  - On success it calls `markEmailVerified(personId)`. It does not need a session, and it does
    not sign anyone in.
- `resendEmailVerification`:
  - The email is taken from the session account's `email`. If there is none, it answers
    `action: 'no_email'` (temporary accounts).
  - It writes new token fields on the person's credential, or on a new row with `email` when
    the person has none.
  - On a send failure it clears the token and answers `{error: "Sorry, we couldn't send the
    email, please try again later", action: 'email_failed'}`. That is fine here: the caller is
    signed in, so nothing is enumerated.
- `removeAccount`:
  - missing proof: `{error: 'Confirm it is you to delete this account.', action:
    'reauthenticate', methods}`
  - wrong proof: `{error: 'That confirmation did not match this account.', action:
    'reauthenticate', methods}`
  - A rate-limit answer is counted only when a proof was checked.
- Password reset with a token, and OAuth sign-in through any of the three `signinOAuth` paths
  when the provider's verified email normalizes to the person's WebID, both call
  `markEmailVerified`. For a linked-identity sign-in, the check is
  `emailToWebID(identity.email) === person.id`. A new OAuth user's credential is created with
  `emailVerifiedAt` already set.

RPC declarations (`declareCallable(AuthBackendProvider, …)`):

- `verifyEmail: 'public'`
- `resendEmailVerification: 'user'`
- `getReauthenticationMethods: 'user'`

No new provider *methods* are internal: helpers stay module-level. `test/exposure.test.mjs`
`SURFACE` and the readme RPC table get the same three entries.

**`useAuth` additions** (`src/hooks/useAuth.tsx`):

```ts
emailVerified: boolean;                      // auth?.emailVerified === true
verifyEmail: (token: string) => Promise<VerifyEmailResult>;  // on success + signed in: await refreshSession()
resendEmailVerification: () => Promise<ResendEmailVerificationResult>;
getReauthenticationMethods: () => Promise<{ methods: ReauthenticationMethod[] }>;
removeAccount: (proof?: RemoveAccountProof) => Promise<RemoveAccountResult>;
```

**`RemoveAccountButton` props:**

```ts
interface RemoveAccountButtonProps {
  confirmationText?: string;
  agreeText?: string;
  className?: string;
  /** Run the provider's sign-in (popup / native) and resolve to what signinOAuth takes as its
   *  second argument. Needed only for accounts without a password that use Google/Apple. */
  getOAuthSource?: (provider: 'google' | 'apple') => Promise<unknown>;
}
```

- When the dialog opens, call `getReauthenticationMethods()`.
  - `['password']`: a password `Input` goes in `message`, with `confirmDisabled` until it is
    filled.
  - google/apple: one "Confirm with Google/Apple" button per method. It calls
    `getOAuthSource(p)` and then `removeAccount({provider: p, source})` in the same click.
    Without `getOAuthSource` it shows a hint and the confirm button stays disabled.
  - `[]`: plain confirm.
- `isLoading` while the call runs.
- A `reauthenticate` answer shows its error inside the dialog, which stays open.
- `true` → `signout()` → `/`.
- Translation keys: `removeAccount.passwordLabel`, `.confirmWithProvider`, `.wrongProof`,
  `.noOAuthSource`, each with `t(key, default)`.

**New component** `src/components/VerifyEmailCallback.tsx`, mirroring `ForgotPasswordCallback`:

- reads `?token=`
- calls `useAuth().verifyEmail` once
- shows verified / invalid (with a resend button when signed in)
- keys under `verifyEmail.*`

The app adds a route at `/auth/verify-email`, which the readme documents.

### Expected file changes

| File | Change |
|---|---|
| `src/ontologies/auth.ts`, `src/data/auth.json` | 4 new properties |
| `src/shapes/AuthCredential.ts` | 4 new `@literalProperty` getters |
| `src/helpers/credentialToken.ts` (new) | atomic consume via marker |
| `src/helpers/password.ts` | `consumeResetPasswordToken` uses it; `MIN_PASSWORD_LENGTH`; dummy-hash compare helper |
| `src/helpers/emailVerification.ts` (new) | token fields, `markEmailVerified`, `personEmailVerified`, TTL |
| `src/utils/email.ts` (new) | `sendAuthEmail` |
| `src/helpers/apple.ts` | return `iat` |
| `src/types/auth.ts` | `emailVerified`, `issuedAt`, new result/proof types |
| `src/utils/auth.ts` | `buildAuthSession` sets `emailVerified`; `setAuthentication` request guards; `updateSessionData` carries `emailVerified` |
| `src/utils/rateLimit.ts` | 3 rules |
| `src/backend.ts` | all method changes above; remove ZeptoMail; new declarations |
| `src/hooks/useAuth.tsx` | additions above |
| `src/components/RemoveAccountButton.tsx` | proof UI, `getOAuthSource` |
| `src/components/ForgotPasswordForm.tsx` | always the uniform text on non-error |
| `src/components/CreateAccountForm.tsx` | handles `invalid_password` (server text) — no logic change beyond showing it |
| `src/components/VerifyEmailCallback.tsx` (new) | |
| `src/index.ts` / exports | new component and types, if the index re-exports components |
| `package.json` | drop `zeptomail` |
| `readme.md` | RPC table, rate-limit table, email config, verification route, upgrade notes |
| `test/*` | see Phases |

### Pitfalls

- **Tests run against `lib/esm`.** Run `npx linked build` before `npm test`, or the tests run
  stale code. They mock `AuthCredential.select/create/update(...).for` with an in-memory table
  (`password-reset.test.mjs` `fakeCredentialTable`), which does not support
  `update(...).where(...)` yet. Extend the fake to support `.where`, and keep unsetting with
  `null`.
- **Tests that change:**
  - `password-reset.test.mjs`, `rate-limit.test.mjs` and integration `sessions.fuseki.test.mjs`
    assert `sendResetPasswordLink === true`. That still holds, but cases that expected an error
    for an unknown email must now expect `true`.
  - Integration `accounts.fuseki.test.mjs` and `sessions.fuseki.test.mjs` call `removeAccount()`
    with no arguments on a password account. Pass `{password}`.
  - `exposure.test.mjs` `SURFACE` and the subclass test.
  - Readme line 38 quotes "No password found for this email" (2.0 migration). Reword it to the new
    uniform message.
- **`LinkedEmail.send` throws synchronously** without a provider. Always call it inside an
  `async` function or a `try`, never `.then` on its return.
- **Log hygiene.** `log-hygiene.test.mjs` forbids emails and tokens in logs. The dev link log
  contains a token. Log it only under `DEV_AUTH`, never the address, and add a log-hygiene case
  that a non-DEV_AUTH send failure logs no token and no email.
- **The JWT carries `emailVerified`.** It goes stale until the next refresh. Document this, and
  tell apps to re-check on the server before a sensitive action, using
  `personEmailVerified`, exported from `@_linked/auth/helpers/emailVerification`.
- **`buildAuthSession` runs on every refresh.** That is one more credential query per refresh.
  It must catch errors and return false. Unit tests with no store reach it.
- **`requireSessionUser()` throws `ServerCallError(401)` outside a session, and a plain `Error`
  outside any call context.** Unit tests must wrap the provider with `serving()`.
- **Strict null checks:**
  - `AuthCredential` getters return `undefined as any` by convention. Keep that, and add no new
    `as any` in backend code.
  - Type `verifyOAuthIdentity`'s results.
  - The `account.accountOf?.id` fallback needs a guard.
- **Translations:** components use `useTranslate()` with `t(key, default)`. New keys need
  defaults.
- **Breaking-ish `removeAccount`.** Callers with no arguments now get `action:
  'reauthenticate'` for password and OAuth accounts. This goes in the changeset as a minor release
  with an explicit upgrade note.
- **Apple redirect flow (`form_post`) cannot supply a proof** without losing page state. The
  readme says to use popup mode.
- **Stored emails on `UserAccount` may not be normalized.** The duplicate check compares both the
  raw and the lower-cased form.
- **No code comments with phase labels.**

### Upgrade / readme outline (D3, D1)

1. **Account deletion now asks for proof.**
   - `removeAccount({password})` or `removeAccount({provider, source})`.
   - `getReauthenticationMethods()`.
   - `RemoveAccountButton`'s `getOAuthSource`, with a Google GIS and an Apple popup example.
   - Temporary and dev accounts still need only a session.
   - The Apple redirect flow is unsupported.
2. **Email verification.**
   - Soft flag: `useAuth().emailVerified`, and `auth.emailVerified` on the server.
   - The app decides what to gate, and should re-check on the server.
   - The `/auth/verify-email` route with `VerifyEmailCallback`.
   - `resendEmailVerification`.
   - What also verifies an email: a password reset, or Google/Apple.
   - `AUTH_EMAIL_VERIFICATION_TTL`.
3. **Email configuration.**
   - Register a provider with `LinkedEmail.setDefaultProvider`. Replace the `lincd-zeptomail`
     sentence.
   - Without a provider: reset and verification links are not sent. With `DEV_AUTH` they are
     logged.
4. **Uniform answers.**
   - The sign-in and reset messages.
   - Signup still says "in use", and why.
   - The timing note.
5. **Rate limits and RPC tables:** the 3 new rules and the 3 new methods.
6. **Changeset text** is drafted in Phase 6 and created in wrapup.

### Plan deviations / open questions (resolved)

- **ID token age.** The deletion proof requires the ID token's `iat` to be no more than 10 minutes
  old, in addition to the `exp` check. Without that limit, a cached Google token up to an hour old
  would pass, and D3's "recent sign-in" would mean nothing.
- **Dev accounts report `emailVerified: false`.** Accepted. `signinDev` stores no credential, and
  dev accounts exist only for development.
- **Password length.** Signup, token reset and password change all use the same
  `MIN_PASSWORD_LENGTH` check on the server. One rule, so the paths cannot drift.

## Phases

Every phase ends with `npx linked build && npm test` (unit, `lib/esm`) green. Integration runs
(`npm run test:integration`) need Fuseki on `:3030` and are called out where required. One commit
per phase.

### Phase 1 — Request guards, `signinDev` sub, enumeration answers, signup checks

Tasks:

- `src/backend.ts`:
  - `checkSignin` gets `?.`.
  - `signinDev` refuses a missing `sub`.
  - `signinWithPassword` returns `INVALID_CREDENTIALS_MESSAGE` for all three failures, with a
    dummy-hash compare on the paths without a credential.
  - `createAccount`:
    - checks the password (`MIN_PASSWORD_LENGTH`) before any lookup
    - checks for an existing Person, UserAccount or AuthCredential
    - normalizes the email it stores
    - writes `email` on the new credential
- `resetPassword` (with a token) and `changePassword` use the same `MIN_PASSWORD_LENGTH` check and
  return `invalid_password`.
- `src/helpers/password.ts`: `MIN_PASSWORD_LENGTH`, `INVALID_CREDENTIALS_MESSAGE`, and
  `compareWithDummyHash(plain)`, whose hash is computed lazily once.
- `src/utils/auth.ts`: `setAuthentication` and `updateSessionData` work without a request.
- `readme.md` line 38: the migration note no longer quotes the old message.

Validation (new tests):

- `test/signup.test.mjs` (new; in-memory fakes for userShape, accountShape and AuthCredential,
  `Auth.login` stubbed):
  - refuses when the Person exists
  - refuses when only a UserAccount with the email exists (also mixed case)
  - refuses when only an AuthCredential with the email exists
  - refuses a missing or short password with `invalid_password` and creates nothing
  - creates the account when nothing exists, and the credential carries the normalized email
- `test/password-reset.test.mjs`: a short password is refused for a token reset and for a password
  change.
- `test/password.test.mjs` or a new `test/enumeration.test.mjs`: for an unknown email, an
  account with no credential, and a wrong password, the result is the same
  `{error: INVALID_CREDENTIALS_MESSAGE}`, and the unknown-email path calls `bcrypt.compare` once.
- `test/signin-dev.test.mjs`: a token without `sub` → `{error: 'Invalid token'}`, and nothing is
  written.
- `test/session-lifetime.test.mjs` or a new `test/request-guards.test.mjs`:
  - `Auth.setAuthentication(undefined, auth)` returns linkedAuth and does not throw
  - `checkSignin` with no request returns `undefined`

Done:

- Validation: `npx linked build && npm test` — 241/241 pass (new: `signup.test.mjs`,
  `enumeration.test.mjs`, `request-guards.test.mjs`, cases in `password-reset.test.mjs` and
  `signin-dev.test.mjs`). `npm run test:integration` against Fuseki — 27/27 pass.
- Deviations:
  - `password.ts` also exports `isAcceptablePassword(password)` and `INVALID_PASSWORD_RESULT`, so
    signup, token reset and password change share one check and one answer. The password check in
    `resetPassword` runs after the match check and before the token is used up, so a short
    password does not burn the link.
  - `signinDev`: a missing `sub` answers `{error: 'Invalid token'}`; a `sub` that differs from
    `webId` keeps its existing answer ("WebID does not match token subject").
  - Sign-in also gives the uniform answer (with the dummy compare) when the credential found at
    the WebID has no `passwordHash` (e.g. an OAuth credential). Before, that reached
    `bcrypt.compare` with `undefined`, which fails fast.
  - The credential duplicate check also compares the raw email when it differs from the
    normalized one, as the account check does.
  - `test/integration/sessions.fuseki.test.mjs` failed 4 tests on the base commit as well: they
    hit the per-account sign-in rate limit. It now calls `resetRateLimits()` before each test.
  - Shared in-memory shape fake for the new tests: `test/fakeStore.mjs` (`fakeShapeTable`).
    `password-reset.test.mjs`'s `fakeCredentialTable` is unchanged; Phase 2 still extends it.

### Phase 2 — Mail failure handling (D4) and atomic reset consume (D5)

Tasks:

- Ontology and shape: `consumeMarker`.
- `src/helpers/credentialToken.ts`: `consumeCredentialToken`.
  - **First** verify against Fuseki that `update({x: null, …}).where(cond)` unsets in where mode.
  - If it does not, implement the `rawQuery` fallback and record the deviation.
- `PasswordHelper.consumeResetPasswordToken` uses it. `validateResetPasswordToken` is unchanged.
- `src/utils/email.ts`: `sendAuthEmail`.
- `sendResetPasswordLink`:
  - returns `true` for every well-formed email
  - goes through `sendAuthEmail`
  - clears the token on `'failed'`
  - the "person not found" branch also returns `true`
- Remove ZeptoMail from `backend.ts` and `package.json` (`npm install` from the CN root
  afterwards, not inside the checkout; see CN CLAUDE.md).
- `ForgotPasswordForm.tsx`: the uniform text
  `t('resetPassword.linkSent', "If an account exists for this email, we've sent a link.")`.

Validation:

- Extend `fakeCredentialTable` in `test/password-reset.test.mjs` with `update().where()`.
- New cases:
  - two concurrent `resetPassword(token)` calls with the same token: exactly one succeeds
  - unknown email → `true`, and no email is sent
  - `LinkedEmail.send` throwing synchronously → `true`, and the stored token is cleared
  - `DEV_AUTH=true` with no provider: the link is logged, the token is kept, and no send is
    attempted
- `test/log-hygiene.test.mjs`: a failed send without DEV_AUTH logs no token and no email.
- Integration (Fuseki): a case in `test/integration/sessions.fuseki.test.mjs`. Two parallel
  consumes of one real token result in one success, and `consumeMarker` is gone afterwards.

Done:

- Fuseki check first: `AuthCredential.update({forgotPasswordToken: null, forgotPasswordTokenExpiresAt: null, telephone: 'M1'}).where(c => c.forgotPasswordToken.equals('H1'))`
  against a throwaway dataset removed both fields on the matching row only, wrote the marker, and
  left the other row alone. A second identical update matched nothing and wrote nothing. Null
  unsets in where mode, so no `rawQuery` fallback was built.
- Validation: `npx linked build && npm test` — 248/248 pass (new in `password-reset.test.mjs`:
  concurrent resets with one link, unknown email, missing person, a send that throws
  synchronously, a send that rejects, DEV_AUTH logging; in `log-hygiene.test.mjs`: a failed
  reset send logs neither address nor token). `npm run test:integration` — 28/28 pass. The new
  integration case races three `resetPassword` calls on one real token: one succeeds, the other
  two get "No user account found to reset password", and no `consumeMarker` or token is left.
  With the old consume restored, the same case gives three successes and fails.
- Deviations:
  - `src/data/auth.json` holds no property definitions (only the template's `ExampleClass`), so
    `consumeMarker` was added to `src/ontologies/auth.ts` and the shape only. Phase 3's terms can
    do the same.
  - `consumeCredentialToken` takes `tokenField`/`expiresField` as string-literal unions that
    only hold the reset fields for now. Phase 3 widens them with the verification fields.
    It returns the person (`QResult<Person>`) when this call won and the pre-read expiry is still
    in the future; a win on a row other than the pre-read one counts as invalid.
  - The unsent token is cleared with a where-mode update keyed by its own hash
    (`clearUnsentResetPasswordToken`, module-level), so a newer link issued meanwhile survives.
    The "person not found" branch also clears it, since no email goes out there either.
  - `sendAuthEmail` redacts the recipient addresses, the link and its raw token from the logged
    provider error, because a provider message may echo what it was asked to send.
  - `package-lock.json` of the checkout: the `zeptomail` root dependency and its
    `node_modules/zeptomail*` entries were removed by script (no `npm install` in the
    checkout). `axios`, which only zeptomail used, stays in the lock as an orphan until the next
    Renovate refresh. `npm install` at the CN root ran; zeptomail is now `extraneous` there.
  - The readme's `lincd-zeptomail` sentence (readme.md:379) is left for Phase 6 (Email
    configuration).

### Phase 3 — Email verification backend

Tasks:

- Ontology and shape: `emailVerifiedAt`, `emailVerificationToken`,
  `emailVerificationTokenExpiresAt`.
- `src/helpers/emailVerification.ts`: TTL, token fields, `markEmailVerified`,
  `personEmailVerified`.
- `src/types/auth.ts`: `AuthSession.emailVerified`, `VerifyEmailResult`,
  `ResendEmailVerificationResult`.
- `src/utils/auth.ts`: `buildAuthSession` sets `emailVerified`, and `updateSessionData` carries
  it.
- `src/utils/rateLimit.ts`: `emailVerificationRequest` and `emailVerify`.
- `src/backend.ts`:
  - `createAccount` writes the verification token fields on the new credential, then sends
    through `sendAuthEmail` after `Auth.login`. On a failure it clears the token, and the
    sign-in result is unchanged.
  - New `verifyEmail` and `resendEmailVerification`.
  - `resetPassword` with a token calls `markEmailVerified`.
  - `signinOAuth`: all three paths mark the email verified when the verified email maps to the
    person.
  - Declarations: `verifyEmail: 'public'`, `resendEmailVerification: 'user'`.

Validation:

- `test/email-verification.test.mjs` (new; fake credential table):
  - the token is stored hashed and expires
  - `verifyEmail` with a valid token sets `emailVerifiedAt` and works only once (concurrent
    calls too)
  - expired or unknown token → the error with `action: 'resend_verification'`
  - resend: no email → `no_email`, already verified → `{verified: true}`, send failure →
    `email_failed` with the token cleared
  - reset-by-token marks verified
- `test/oauth.test.mjs`: a new OAuth user's credential has `emailVerifiedAt`, and a linked sign-in
  whose email maps to the person marks it.
- `test/rate-limit.test.mjs`: the two new rules (3 resends an hour per account).
- `test/exposure.test.mjs`: `SURFACE` gets the two methods.
- `test/session-lifetime.test.mjs` or `tokens.test.mjs`: `buildAuthSession` reports
  `emailVerified`, `updateSessionData` keeps it, and a store error → `false`.
- Integration (Fuseki), `accounts.fuseki.test.mjs`: create, then verify, then refresh →
  `auth.emailVerified === true`.

Done:

- Validation: `npx linked build && npm test` — 274/274 pass (new: `email-verification.test.mjs`,
  15 cases; in `oauth.test.mjs`: new OAuth user, linked sign-in with the person's email and with
  another email, email-matched attach; in `rate-limit.test.mjs`: both new rules; in
  `tokens.test.mjs`: `buildAuthSession` true/false/store error, the access token and
  `updateSessionData` keep it, a refresh re-reads it; `exposure.test.mjs` `SURFACE` has both
  methods). `npm run test:integration` — 29/29 pass. The new case in `accounts.fuseki.test.mjs`
  creates an account (`emailVerified: false`), verifies it with the emailed token, sees the
  token refused a second time, and refreshes to `emailVerified: true`.
- Deviations:
  - `emailVerification.ts` also exports `consumeEmailVerificationToken(token)` (the
    `consumeCredentialToken` call) and has its own `hashToken`. It does not import `password.ts`,
    so `utils/auth.ts` does not pull in bcrypt; the backend makes the raw token with
    `PasswordHelper.generateToken()`.
  - `test/password-reset.test.mjs`'s `fakeCredentialTable` moved to `test/fakeStore.mjs`
    (`install(AuthCredential)`), shared by the new tests.
  - New module-level helpers in `backend.ts`: `sendVerificationEmail` (builds the email, sends
    through `sendAuthEmail`, clears an unsent token by its hash), `clearUnsentVerificationToken`,
    `markOAuthEmailVerified`, `accountEmail` and `givenNameOf`. No new provider methods besides
    the two RPCs.
  - `resendEmailVerification` reads the email from the stored account first and falls back to
    the session's; it writes the token on the person's credential with a password (else the
    first), or creates one with the email. A session without a person id throws.
  - A failed `markEmailVerified` is logged and does not fail a password reset or OAuth sign-in;
    in `verifyEmail` it is an error. The reset marks after the password write, so the new
    session already reports `emailVerified: true`.
  - The email-matched OAuth path marks the email without a separate WebID check: the person was
    found at `emailToWebID(email)`.
  - Integration runs: do not source CN's `.env`. It sets `DEV_AUTH=true`, which logs links
    instead of calling the (mocked) `LinkedEmail.send`, so every emailed-link case fails. Pass
    only the `AUTH_TEST_FUSEKI_*` variables.

### Phase 4 — `removeAccount` proof and `getReauthenticationMethods`

Tasks:

- `src/helpers/apple.ts`: return `iat`.
- `VerifiedOAuthIdentity.issuedAt`, filled for both providers.
- `src/types/auth.ts`: `ReauthenticationMethod`, `RemoveAccountProof`, `RemoveAccountResult`.
- `src/utils/rateLimit.ts`: `reauthenticate`.
- `src/backend.ts`:
  - Module-level `reauthenticationMethods(accountId, personId)` and `verifyReauthentication(…)`,
    with `REAUTH_MAX_TOKEN_AGE`.
  - `getReauthenticationMethods` (`'user'`).
  - `removeAccount(proof?)` uses `requireSessionUser()`, checks the proof (rate-limited when a
    proof is checked), and otherwise deletes as today.

Validation:

- `test/remove-account.test.mjs` (new; `serving()`, stubbed `OAuthIdentityStore`, helpers and
  deletes):
  - no proof on a password account → `reauthenticate` with `['password']`
  - wrong password → `reauthenticate`
  - right password → deletes and returns `true`
  - OAuth-only account: no proof → `['google']` (its linked providers)
  - a valid Google token whose subject is linked to *another* account → refused
  - linked subject → `true`
  - token older than 10 minutes → refused
  - an account with no credential and no links → `true` without proof
  - no session → 401
- `test/exposure.test.mjs`: `getReauthenticationMethods: 'user'`, and the subclass test still
  passes.
- Integration (Fuseki): update the `removeAccount()` calls in `accounts.fuseki.test.mjs` and
  `sessions.fuseki.test.mjs` to pass `{password}`, and add one refused-without-proof case.

Done:

- Validation: `npx linked build && npm test` — 287/287 pass (new: `remove-account.test.mjs`,
  12 cases: the plan's list plus a linked Google token on a password account, an invalid token
  and an unsupported provider, a token without `iat`, the `reauthenticate` limit, and 401 for
  both methods; `apple.test.mjs` checks the returned `iat`; `exposure.test.mjs` `SURFACE` has
  `getReauthenticationMethods: 'user'`). `npm run test:integration` — 29/29 pass. The
  `accounts.fuseki.test.mjs` removal case is now refused without proof (`methods:
  ['password']`) and with a wrong password, deletes nothing, then deletes with `{password}`.
  `sessions.fuseki.test.mjs` passes `{password}`.
- Deviations:
  - `verifyReauthentication(provider, accountId, personId, proof)` takes the backend provider
    for `getPasswordForUser`. A token without `iat` counts as not fresh. `REAUTH_MAX_TOKEN_AGE`
    (ms) is exported from `backend.ts` for the tests.
  - A proof is "sent" when the object has a `password` or `provider` key. A malformed one (a
    non-string password, an unsupported provider, a non-object `source`) gets the wrong-proof
    answer and is counted by the rate limit. An account with no methods ignores any proof.
  - The integration removal case used to add a hashed credential with a different password.
    Which hashed row `getPasswordForUser` picks is not defined, so that row now holds a second
    hash of the same password. The "old password does not carry over" check stays (`PASSWORD_1`
    after re-signup).
  - The readme's RPC and rate-limit tables are left for Phase 6, together with Phase 3's
    entries.

### Phase 5 — Client: `useAuth`, `RemoveAccountButton`, forms, `VerifyEmailCallback`

Tasks:

- `src/hooks/useAuth.tsx`: `emailVerified`, `verifyEmail` (refreshes when signed in),
  `resendEmailVerification`, `getReauthenticationMethods`, and `removeAccount(proof?)` with the
  types from the Contracts section.
- `src/components/RemoveAccountButton.tsx`: the proof UI described in Contracts, plus the
  `getOAuthSource` prop.
- `src/components/VerifyEmailCallback.tsx` (new).
- `CreateAccountForm.tsx`: shows the server's `invalid_password` text.
- Export the new component and types where the package exposes components.

Validation:

- `test/useAuth.test.mjs`:
  - `emailVerified` reflects `auth.emailVerified`
  - `verifyEmail` success triggers one forced `validateToken`
  - `removeAccount(proof)` sends the proof as its argument
- If the existing test harness can render components, add a render test for
  `RemoveAccountButton`. Otherwise do a manual check in CN (localized):
  - a password account sees the password field
  - an OAuth-only account sees "Confirm with Google"
  - a wrong password keeps the dialog open with the error
- `npm run typecheck:gate` in CN, plus `npx linked build-all`, so that CN still compiles
  against the changed `removeAccount` and `useAuth` types.

Done:

- Validation: `npx linked build && npm test` — 295/295 pass. `useAuth.test.mjs`: `emailVerified`
  follows `auth.emailVerified`, a signed-in `verifyEmail` makes one forced `validateToken`, and
  `removeAccount({password})` sends the proof. New `remove-account-button.test.mjs` (5 cases,
  rendered in jsdom): a password account gets the password field with confirm disabled until it
  is filled; a wrong password keeps the dialog open with the error; an OAuth-only account gets
  "Confirm with Google", which calls `getOAuthSource` and `removeAccount({provider, source})` in
  one click; without `getOAuthSource` both buttons stay disabled; no methods deletes with no
  proof. In CN, `npm run typecheck:gate` reports no new errors, and `npx linked build-all`
  succeeds. The UI was not checked in a browser.
- Deviations:
  - `test/cssStub.mjs` registers a loader that turns `.css` imports into an empty class map, so
    the built components load under node. The render test points Radix at jsdom's event
    constructors.
  - `verifyEmail` refreshes through `refreshAccessToken()`, the single-flight refresh, so it
    cannot race a scheduled refresh. `VerifyEmailCallback` waits until `validating` is false
    before it redeems the token, and redeems it only once (a ref, for StrictMode).
  - `RemoveAccountButton` loads the methods when Delete is clicked and then opens the dialog.
    If the load fails, it opens with a plain confirm, and the server's `reauthenticate` answer
    supplies the methods. A wrong proof shows `removeAccount.wrongProof`; a missing proof shows
    the server's text. New keys: `removeAccount.deleteFailed` and the `verifyEmail.*` keys.
    `className` is now optional. An account with both a password and a provider link is asked
    only for the password.
  - `CreateAccountForm` and `ForgotPasswordForm` needed no change. The first already shows the
    server's `error` (this covers `invalid_password`), and the second already shows the
    uniform text on success.
  - `VerifyEmailCallback` takes an optional `onEmailVerified` callback. It is registered in
    `src/index.ts` and imported from `@_linked/auth/components/VerifyEmailCallback`. The types
    come from `@_linked/auth/types/auth`, as before.
  - CN: `src/backend/auth/authExposure.ts` does not list `verifyEmail`,
    `resendEmailVerification` or `getReauthenticationMethods`. auth makes them callable, so
    CN's drift check will refuse to start once CN runs this auth. CN is not changed here.

### Phase 6 — Readme, upgrade notes, changeset draft

Tasks:

- `readme.md`:
  - the outline in Plan › Upgrade/readme
  - RPC table: +3 methods
  - rate-limit table: +3 rules, with env names such as
    `AUTH_RATE_LIMIT_EMAIL_VERIFICATION_REQUEST_ACCOUNT`
  - Email configuration
  - Setup Verify Email route
  - the account-deletion section, with `getOAuthSource` examples
- Draft the changeset text here. It is created with `npx changeset` in wrapup, as a minor.

Changeset (`@_linked/auth`: minor):

```md
---
'@_linked/auth': minor
---

Email verification, uniform sign-in and reset answers, and proof for account deletion.

- Email verification (a soft flag): sign-up sends a verification link to
  `${SITE_ROOT}/auth/verify-email?token=…`, valid for `AUTH_EMAIL_VERIFICATION_TTL` (default 7
  days). The session reports `emailVerified` (`useAuth().emailVerified`,
  `request.linkedAuth.emailVerified`); apps decide what to gate. A completed password reset or a
  Google/Apple sign-in with a provider-verified email also verifies it. New: `verifyEmail`
  (public), `resendEmailVerification` (user), the `VerifyEmailCallback` component and
  `personEmailVerified` for server-side checks.
- Sign-in answers "Invalid email / password combination." whether or not the email is
  registered, and `sendResetPasswordLink` answers `true` for every well-formed email.
- `createAccount` refuses an email that already has a person, account or credential, and the
  server checks a minimum password length of 6 for sign-up, reset and password change
  (`action: 'invalid_password'`).
- Reset links are used up atomically, so one link cannot reset twice.
- Without an email provider (`LinkedEmail.setDefaultProvider`), nothing is sent and nothing
  fails; with `DEV_AUTH` the link is logged. The unused ZeptoMail dependency is removed.
- New rate-limit rules: `emailVerificationRequest`, `emailVerify`, `reauthenticate`.

**Upgrade notes**

- `removeAccount()` with no proof now fails with `action: 'reauthenticate'` for accounts with a
  password or a linked Google/Apple identity. Send `removeAccount({password})` or
  `removeAccount({provider, source})`; `getReauthenticationMethods()` tells which. The ID token
  must be at most 10 minutes old. Temporary and dev accounts need only a session.
- `RemoveAccountButton` asks for the password itself. Apps that offer Google or Apple pass
  `getOAuthSource(provider)`, the same function their sign-in uses to build `signinOAuth`'s
  second argument. Apple's web redirect (`form_post`) flow cannot supply the proof; use popup
  mode.
- Apps on `rpcExposure: 'enforce'` that pin auth's surface in their own table must add
  `verifyEmail` (public), `resendEmailVerification` (user) and `getReauthenticationMethods`
  (user).
- UIs that showed "this email is not registered" on sign-in or reset should show the generic
  answer.
- Add a `/auth/verify-email` route that renders `VerifyEmailCallback`.
```

Validation: the readme tables match `RATE_LIMIT_DEFAULTS` and `declareCallable` (compare them by
eye against `exposure.test.mjs` `SURFACE`). A full `npm test` and `npm run test:integration` with
Fuseki pass.

Done:

- Validation: `npx linked build && npm test` — 295/295 pass. `npm run test:integration` against
  Fuseki (without `DEV_AUTH`) — 29/29 pass. The readme's RPC table matches `declareCallable` and
  `SURFACE` in `exposure.test.mjs`; the rate-limit table matches `RATE_LIMIT_DEFAULTS`. Every
  import path in the new snippets resolves to a file in `lib/esm`.
- Readme: new "Upgrading to 3.4", "Sign-in and reset answers", "Email verification", "Delete
  account" and "Setup Verify Email" sections; `AUTH_EMAIL_VERIFICATION_TTL` in the env table; the
  `lincd-zeptomail` sentence replaced by `LinkedEmail.setDefaultProvider` setup and the
  no-provider/`DEV_AUTH` behaviour.
- Deviations:
  - The OAuth note "Account creation does not verify email" now says a password account can be
    created before its email is verified.
  - The reset-password route's import path is corrected from `lincd-auth/lib/...` to
    `@_linked/auth/components/ForgotPasswordCallback`, to match the new verify route. Older
    `lincd-*` imports elsewhere in the readme are left as they were.
  - The `getOAuthSource` example calls app-side placeholders (`getGoogleIdToken`,
    `getAppleIdentityToken`) instead of quoting the Google GIS and Apple JS SDKs in full.

### Dependencies and parallelization

```
P1 ──► P2 ──► P3 ──► P5 ──► P6
          └──► P4 ──┘
```

- P2 must come before P3 and P4. It adds `consumeMarker`, `credentialToken.ts` and
  `sendAuthEmail`, which P3 reuses, and it extends the fake credential table.
- P3 and P4 both edit `backend.ts`, `types/auth.ts`, `rateLimit.ts` and `exposure.test.mjs`. They
  are logically independent, but should run one after the other (P3, then P4) to avoid conflicts.
  A parallel run needs a careful merge of the rule union and the `SURFACE` entries.
- P5 needs the P3 and P4 types. P6 is last.
