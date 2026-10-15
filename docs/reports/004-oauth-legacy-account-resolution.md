---
summary: >
  Google and Apple sign-in now resolve verified emails across canonical and legacy account
  identifiers, reuse one safe OAuth-only match, and fail closed when stored identity data is
  ambiguous.
---

# 004 — OAuth legacy account resolution

## Outcome

OAuth sign-in no longer creates a duplicate account merely because an existing Person uses an
application-specific WebID rather than the current `webid.email` identifier. Google and Apple use
the same resolver and security policy.

This work is tracked in [linked-fw/auth PR #114](https://github.com/linked-fw/auth/pull/114).

## Problem

`signinOAuth` previously derived the current canonical WebID from the verified provider email and
looked up only a `UserAccount.accountOf` relation to that WebID. Older applications can have all of
the following valid data:

- a Person with an application-specific WebID;
- a `UserAccount` linked to that Person and carrying the email;
- an `AuthCredential` for that Person carrying the same email.

The account existed and the provider email was verified, but the canonical-WebID-only lookup did
not see it. Auth created a second Person and `UserAccount`, then linked the provider identity to the
duplicate.

## Resolution pipeline

The internal OAuth resolver now collects candidates from three compatibility identifiers:

1. the current email-derived canonical WebID;
2. `UserAccount.email`;
3. `AuthCredential.email`, followed through `credentialOf` to the Person and their account.

Accounts and people are deduplicated by IRI. Resolution continues only when all matches identify
at most one Person and one account. Several distinct people or accounts return:

```json
{
  "error": "This email is associated with more than one account. Please contact support.",
  "action": "account_conflict"
}
```

No provider identity is linked in the conflict case.

## Security decisions

- Provider-and-subject identity links remain authoritative and are checked before email. Once an
  identity is linked, later provider email changes do not move it to another account.
- Only Google and Apple enter this flow, and only after Auth verifies their identity token and
  confirmed email claim on the server.
- Finding one account by email does not automatically make it safe. The existing
  `decideEmailMatchedAccount` policy remains in force.
- An account with a password returns `sign_in_to_link`; its owner must authenticate first and call
  `linkOAuthIdentity` from that session.
- A second identity from the same provider also returns `sign_in_to_link`.
- An unambiguous OAuth-only account may be linked automatically.
- Zero candidates keeps the existing new-account flow.

These rules deliberately prefer refusing an ambiguous sign-in over guessing which historical row
belongs to the user.

## Code structure

- `src/backend.ts` contains the internal `findAccountForOAuthEmail` resolver. It remains outside
  `AuthBackendProvider`, so it cannot accidentally become part of the RPC surface.
- `test/oauth.test.mjs` covers the decision path without network or storage, including Google and
  Apple accounts with legacy Person identifiers.
- `test/apple-nonce.test.mjs` supplies the credential-query test double needed by the shared
  resolver while retaining the nonce behavior coverage.
- `test/integration/oauth.fuseki.test.mjs` verifies legacy resolution and ambiguity against a real,
  throwaway Fuseki dataset.

No public exports, shapes, ontology terms, RPC methods, or environment variables were added.

## Validation

- `npx linked build` passed.
- `npm test` passed: 309 tests.
- `npm run test:integration` passed against local throwaway Fuseki datasets: 34 tests.
- The focused OAuth integration suite passed: 9 tests.
- A browser smoke test confirmed that a verified Google identity reused an existing legacy account
  instead of entering new-account registration.

## Documentation

The OAuth section in `readme.md` now documents all lookup identifiers, the ambiguity response, and
the unchanged password-account linking requirement.

There was no implementation plan document in this repository for this focused defect, so no plan
or consumed backlog document was converted or removed during wrapup.

## Known limits

- Email comparison follows the verified spelling and its normalized lowercase form; this is not a
  general duplicate-account merge facility.
- Existing duplicate people/accounts are not mutated or merged. They produce `account_conflict`
  and require an operator-supported cleanup.
- Provider identity links already attached to a duplicate account remain authoritative; repairing
  historical duplicate links is separate data migration work.
