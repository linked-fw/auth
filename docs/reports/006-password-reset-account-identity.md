---
summary: Password recovery now targets the Person owned by the email-matched account, including legacy OAuth accounts, and password sessions retain the account email.
---

# Password reset account identity

## Outcome

Password recovery no longer assumes that `Auth.webIdFor(email)` is the Person attached to an
existing account. This fixes recovery for legacy OAuth accounts whose historical credential is
attached to a derived WebID while `UserAccount.accountOf` identifies a different canonical Person.

Password sign-in also reloads the stored account email before constructing `AuthSession`, making
the account data consistent with OAuth sign-in and token refresh.

## Architecture and request flow

`sendResetPasswordLink` still calls `Auth.webIdFor(email)` to apply the configured email validation
contract. Identity resolution then follows the persisted account relationship:

1. Normalize and validate the submitted email.
2. Select `UserAccount` by its stored email.
3. Treat `UserAccount.accountOf` as the canonical Person for recovery.
4. Find that Person's existing password credential, or create a token-only credential for it.
5. Store the reset-token hash on that credential and send the reset link.
6. On redemption, create or replace the password for the same canonical Person.

The response for an unknown email remains generic, preserving account-enumeration protection.
Raw reset tokens remain absent from storage and failure logs.

## Decisions and rationale

- The persisted `UserAccount.accountOf` relationship is authoritative. A configurable or historic
  WebID derivation cannot safely identify an existing account after identity schemes change.
- The derived WebID is retained only for input validation in this flow. This preserves custom
  `Auth.webIdFor` validation behavior without using its result as the recovery target.
- Stale credentials are not migrated or deleted during a reset request. Recovery writes to the
  canonical Person without making an irreversible cleanup decision about legacy data.
- `getOrCreateAccount` selects both `email` and `accountOf` because its result is inserted directly
  into `AuthSession`. This makes password and OAuth sign-in session data consistent.

## Files and responsibilities

- `src/backend.ts`: resolves reset targets through the account and loads email for password
  sessions.
- `test/password-reset.test.mjs`: covers stale derived-WebID credentials, first-password recovery,
  and email-bearing password sessions.
- `test/log-hygiene.test.mjs`: keeps failed reset-email logging free of addresses and raw tokens
  after the account lookup became mandatory.
- `test/webid.test.mjs`: maintains the source-level contract that backend email paths invoke the
  configured `Auth.webIdFor` function rather than calling a concrete derivation directly.

## Public API and compatibility

No exports, method signatures, or configuration keys changed. The behavior change is
backward-compatible:

- Existing password accounts continue to update their current credential.
- OAuth-only accounts can establish their first password through email recovery.
- Legacy accounts recover against their persisted Person even when a stale derived-WebID
  credential exists.
- Password sign-in exposes the stored account email in the returned authentication session.

## Validation

All 555 unit tests pass against the emitted ESM, including the new legacy identity and
password-session regressions. Test coverage also retains reset-token single-use, expiry,
enumeration resistance, failed-send cleanup, and log-hygiene guarantees.

The standard package build reaches TypeScript compilation but the current base branch has two
unrelated diagnostics in `src/utils/guardedFetch.ts` involving `ReadableStream`/`BodyInit` and
`AbortSignal.any` under the workspace compiler. Emitting with those pre-existing diagnostics and
copying the package CSS assets allows the complete runtime suite to execute. This PR does not
expand into guarded-fetch compatibility work.

## Known limitations

This change deliberately leaves stale legacy credentials in place. It prevents them from
receiving new reset tokens but does not attempt a general credential migration or deduplication.
Such cleanup requires separate rules for deciding whether historic credentials can be deleted.

No scope-specific working plan or backlog document existed for this fix, so no plan or consumed
backlog file was removed during wrapup.

## PR readiness

Code review, documentation, patch changeset, and full runtime validation are complete. The change
is ready for review and release as a patch; the base-branch compiler diagnostics above remain an
independent build-readiness issue.
