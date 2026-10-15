---
summary: >
  Two hardening steps for sign-in by emailed code: end a code after a few wrong guesses (today only
  the per-email rate limit and the 15-minute lifetime bound guessing), and sweep pending
  credentials (expired codes for emails that never signed in, and pending rows whose code was
  removed).
status: Open
---

# 004 — Sign-in code hardening

Deferred from the review of sign-in by emailed code (report
[008](../reports/008-signin-code.md), PR [#123](https://github.com/linked-fw/auth/pull/123)).
Neither is urgent: codes and pending emails are stored as keyed hashes, so a copy of the store
gives neither away.

## 1. End a code after N wrong guesses

A wrong guess leaves the code working. Guessing is bounded by the `signinCode` rule's account
limit (5 per email per 15 minutes, 480 a day) and the code's lifetime: about 5·10⁻⁶ success per
day for one targeted eight-digit code. An app that turns that limit off
(`AUTH_RATE_LIMIT_SIGNIN_CODE_ACCOUNT=off`) has no per-email bound at all; the readme warns
against it.

To decide:
- Where the count lives: a new `AuthCredential` property (e.g. `signinCodeFailures`) reset with
  each new code. The store has no atomic increment; a count read and written per attempt can lose
  concurrent increments, which the rate limit then still bounds. Or count in the rate-limit store
  per code (keyed by the stored hash), which has an atomic `increment`.
- How a wrong guess finds the code: today a wrong guess matches nothing (the lookup is by the
  hash of email + code). Counting needs the credential that holds the email's code, found as
  `storeSigninCode` finds it.
- N (3–5) and the answer once spent (`invalid_code`, so it tells nothing new).

## 2. Sweep pending credentials

`sendSigninCode` for an email with no account writes a pending `AuthCredential`
(`signinCodeEmailHash`, no person). Nothing removes it when its code expires unused, or when the
email's person is created another way. A failed send leaves a pending row whose `signinCode` was
removed.

To decide: a periodic sweep like the refresh-session cleanup (`AUTH_SESSION_CLEANUP`) that
deletes pending credentials whose `signinCodeExpiresAt` has passed **or whose `signinCode` is
null**, or a delete on the spot (an expired consume, a failed send) plus a sweep for the rest.
