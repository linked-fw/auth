---
summary: >
  What is still open from the RPC-surface and authorization handoff (CN plan 058, written against
  auth ad64d0c on 2026-10-02), checked against auth 3.2.0 on 2026-10-12. Most of it shipped in
  3.0.x and 3.2.0. Left: email enumeration on sign-in and reset, createAccount only checking for a
  Person, no email verification on signup, unguarded request reads in removeAccount and
  checkSignin, a dead client call, and readme guidance on protecting credential data.
status: Open
---

# 003 — Remaining RPC-surface and signup gaps

Checked on 2026-10-12 against auth main `028045f` (3.2.0). Line numbers are from that commit.

**Declaring auth's own callable surface** is being done separately (branch
`feat/declare-rpc-surface`). Until it ships, an app on `rpcExposure: 'enforce'` loses sign-in
unless it declares auth's methods itself, as Create Now does in `src/backend/auth/authExposure.ts`.

## Open

- **Email enumeration.** `signinWithPassword` answers "This email is not registered" (`src/backend.ts:437`)
  and "No password found for this email" (`:456`) instead of one generic failure (`:468`).
  `sendResetPasswordLink` answers "No password is associated…" for an unknown email (`:837`).
  Both should give the same answer whether or not the account exists. The 3.2.0 rate limits slow
  this down but do not fix it.
- **`createAccount` only checks for an existing Person** (`:532`). It should also refuse when a
  `UserAccount` with that email or an `IdentityToken` for the account exists.
- **No email verification on signup.** The password credential is usable immediately (`:571-580`).
- **Unguarded request reads.** `checkSignin` reads `this.request.linkedAuth` (`:369`) and
  `removeAccount` reads `this.request.linkedAuth` (`:1231`) without a guard, so a call in system
  context throws a `TypeError`. `removeAccount` and `linkOAuthIdentity` should take the user from
  `requireSessionUser()`. `Auth.setAuthentication` writes `request.linkedAuth` unguarded
  (`src/utils/auth.ts:263`). Consider requiring the current password for `removeAccount`.
- **Dead client call.** `SigninWithPasswordForm.tsx:70` calls `signinDevelopment`, which no provider
  method implements.
- **Readme.** `registerProtectedShapes` was removed in server-utils 1.11. Tell apps to wrap the store
  that holds auth's credential shapes with `withAccess({read: 'none', write: 'none'})`, as Create Now
  does in `linked.backend.storage.js`.

## Optional

- Consuming the reset token is not atomic (see report 001, known open items).
- `signinDev` accepts any WebID when the token has no `sub` (`:1207`).

## Done since the handoff

Internal declarations for the credential methods, hashed single-use expiring reset tokens (3.0.3),
current password on password change (3.0.4), the `DEV_AUTH` gate and token-only email for
`signinDev`, the token-reading guard in `getTokenCandidates`, rate limits (3.2.0) and the
server-utils floor (`^1.9.0`). Create Now runs `enforce`.
