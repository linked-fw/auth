---
summary: >
  Close the gaps left from backlog 003. Sign-in and reset give the same answer whether or not an
  account exists. createAccount refuses any existing account for the email and validates the
  password on the server. Signup gets email verification. Request reads in checkSignin,
  removeAccount and setAuthentication are guarded, and removeAccount re-authenticates the user.
status: Ideation
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
