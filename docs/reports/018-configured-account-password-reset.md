---
summary: Password recovery now resolves custom account types through the configured account shape for both reset requests and token redemption.
---

# Configured account password reset

## Outcome

Password recovery now works for applications that configure a `UserAccount` subclass through
`AUTH_ACCOUNT_TYPE`. Both the reset-link request and reset-token redemption use the configured
account shape instead of querying the base SIOC `UserAccount` directly.

This fixes applications whose persisted accounts have an application-specific RDF target class.
Those accounts were present and carried the requested email, but the base-shape query excluded
them and returned the enumeration-safe "account not found" result.

## Request and redemption flow

1. `sendResetPasswordLink` trims and lowercases the submitted email.
2. The method validates the normalized address through the configured `Auth.webIdFor` contract.
3. It queries `this.accountShape` by stored email and treats `accountOf` as the canonical Person.
4. It creates or updates that Person's reset-token credential and sends the normal reset link.
5. During redemption, `getOrCreateAccount` loads the configured account shape, including its
   stored email.
6. Password creation or replacement uses that stored email without a second base-shape query.

Unknown emails still receive the same public response as known emails, preserving the existing
account-enumeration contract. Reset tokens remain hashed, expiring, single-use values.

## Design decisions

- `AUTH_ACCOUNT_TYPE` is authoritative for account persistence. A package that accepts a custom
  account shape must not silently return to the base SIOC class in one authentication flow.
- The account returned by `getOrCreateAccount` is reused during redemption. This avoids a second
  graph query and guarantees that request and redemption apply the same shape configuration.
- Leading and trailing whitespace is removed before lowercasing. Browser validation alone is not
  a sufficient normalization boundary for RPC callers.
- No fallback query against the base account class was added. A fallback could hide incorrect
  configuration and make duplicate account types resolve unpredictably.

## Files and responsibilities

- `src/backend.ts`: configured-shape resolution, email normalization, and redemption reuse.
- `test/password-reset.test.mjs`: custom account-shape and normalization regression coverage,
  alongside the existing reset-token lifecycle suite.
- `test/log-hygiene.test.mjs`: failed-send privacy coverage using the configured shape fixture.
- `readme.md`: documents the custom account-shape contract for password recovery.
- `.changeset/configured-account-password-reset.md`: patch release note for package consumers.

## Public API and compatibility

No exported types, functions, RPC signatures, or environment keys changed. The behavior is
backward-compatible for applications using the base account shape and corrects recovery for
applications using a configured subclass.

Custom account shapes used with `AUTH_ACCOUNT_TYPE` must expose the existing `email` and
`accountOf` properties. This was already required by other authentication flows and is now
applied consistently to password recovery.

## Validation

- The package builds successfully in ESM and CJS formats.
- All 39 focused password-reset and log-hygiene tests pass.
- The new regression exercises a custom account shape and an uppercase, whitespace-padded email.
- Dependency setup was refreshed from the committed lockfile before validation.

## Architecture documentation

The account-shape contract is documented in `readme.md` next to `AUTH_ACCOUNT_TYPE` and
`AUTH_USER_TYPE`. No wider architecture document required an update because this change makes an
existing configuration contract consistent rather than introducing a new boundary.

## Known limitations

- Account email matching remains an exact normalized literal comparison. Existing stored values
  with unnormalized case or surrounding whitespace require data cleanup; this change normalizes
  incoming values only.
- Custom account types that omit `email` or `accountOf` cannot participate in password recovery.

## REVIEW

The complete branch diff was reviewed for readability, shape consistency, reset-token security,
enumeration behavior, and logging privacy. Hard-coded base-shape lookups related to password
recovery were removed, explanatory comments were added at the configuration boundary, and no
scope-related dead code remains. The branch is ready for a patch pull request.

No scope-specific plan or consumed backlog document existed, so none was removed during wrapup.
