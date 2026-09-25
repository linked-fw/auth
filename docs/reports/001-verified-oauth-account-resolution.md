---
summary: Server-verified Google, Apple, and Facebook authentication with deterministic, conflict-safe account resolution and stricter package validation.
---

# Verified OAuth account resolution

## Outcome

`@_linked/auth` now verifies Google, Apple, and Facebook credentials on the server before using an identity to resolve or create an account. The implementation shares one account-resolution pipeline across providers and retains password authentication without assigning passwords to OAuth-only accounts.

The package also has a strict build-and-test command, runtime provider validation, backend name validation, and reduced authentication logging.

## Authentication pipeline

1. The backend validates that the requested provider is supported.
2. The provider credential is verified with the provider or its signing keys.
3. A normalized identity is produced from verified claims: provider, provider subject, email, and permitted profile fields.
4. Existing identity-token links and verified email matches are loaded.
5. The resolver chooses one account, rejects conflicting matches, or creates a new account.
6. Provider subject and token metadata are persisted against the resolved account.
7. The normal access-token and refresh-token session flow completes.

No caller-supplied profile value is accepted as proof that the caller owns an identity.

## Provider verification

| Provider | Credential | Verification result |
|---|---|---|
| Google | ID token | Token validity, intended client, subject, and verified profile claims |
| Apple | Identity token | Signature/JWK validity, audience, subject, and available claims |
| Facebook | Access token | Application ownership and verified profile fetched from Facebook |

Facebook account creation depends on the application having permission to obtain the user's email address.

## Account resolution rules

| Subject match | Email match | Result |
|---|---|---|
| Same account | Same account | Reuse the account |
| Existing account | None | Reuse the subject-linked account |
| None | Existing account | Reuse the verified-email account and add the subject link |
| Different accounts | Different accounts | Reject as an identity conflict |
| None | None | Create an account |

The conflict rule is intentional. Automatically joining two independently established accounts would be an account-takeover risk and can lose account-specific data.

## Public API and types

`OAUTH_PROVIDERS` is the canonical provider allowlist and `isOAuthProvider(value)` performs the equivalent runtime check. `OAuthProvider` remains the compile-time union.

`IdentityToken.getTokensBySubject()` now returns `SubjectLinkedIdentityTokenResult[]`, matching the query projection instead of claiming a fully materialized identity-token shape.

Applications use the existing `signinOAuth` method through the auth client. Existing password and session interfaces remain available.

## Password accounts

Email is normalized before password account lookup and creation. OAuth-only accounts can exist without a password credential. Password sign-in tests for a credential before verification and returns an authentication failure rather than passing an absent hash to the password verifier.

Backend account creation validates names rather than relying exclusively on browser validation.

## Logging and privacy

Dead OAuth variables and logs containing serialized user/account values were removed. Login-method labels identify only the provider. Tokens, email addresses, and full profile records should not be emitted in routine authentication logs.

## Files and responsibilities

| File | Responsibility |
|---|---|
| `src/backend.ts` | Provider verification, input validation, account resolution, and session entry points |
| `src/types/auth.ts` | OAuth provider types, allowlist, and runtime guard |
| `src/shapes/IdentityToken.ts` | Typed provider-subject token lookup |
| `tests/auth-input-validation.test.mjs` | Runtime allowlist and backend name-validation coverage |
| `readme.md` | Package setup, OAuth behavior, and operational guidance |

Provider-specific helpers and the existing account-resolution tests cover credential verification, lookup precedence, conflict handling, and new-account behavior.

## Validation

`npm test` performs a strict ESM TypeScript build before running the Node test suite. At wrapup, 35 tests passed with no failures. `git diff --check` also completed without whitespace errors.

## Architecture documentation

The root `docs/architecture/08-identity-and-auth.md` records the portable OAuth trust boundary and account-resolution rules so host applications do not reintroduce trust in client profile data.

## Known limitations

- The account-resolution tests exercise the resolver and provider boundaries without a live Fuseki integration environment.
- Some backend behavior tests inspect source structure and are more brittle than behavioral integration tests.
- Facebook sign-in cannot create or match an email account when the application lacks email permission.
- Identity conflicts deliberately require a future explicit recovery or account-linking workflow.

## REVIEW

The branch was reviewed for runtime trust boundaries, account-resolution safety, dead code, logging of personal data, build correctness, tests, package documentation, and release metadata. The implementation is ready for a pull request with the limitations above recorded as follow-up work.
