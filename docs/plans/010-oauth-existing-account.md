---
summary: >
  A7: signinOAuth signs a provider identity into an existing account when the provider's verified
  email equals the account's verified email (password or not); a linked identity whose provider
  email has changed no longer signs into the old account; startOidcSignin accepts provider_hint
  with no typed email.
status: Implementation
---

# 010 — OAuth into an existing account, and a provider start without an email (A7)

**Step:** A7 of [001](001-webid-signin-track.md#a7--oauth-into-an-existing-account-and-a-provider-start-without-an-email).
**Design:** arch-08 §Verified email decides the WebID and §One email, one persona (CN repo);
webid.email backlog 008 items 1, 2 and 4; plan 064 (every migrated Peace Game user has a password
and may sign in with Google). Owner's decision: same verified email = same account; never a
different email, never an unverified one; the email decides, not the provider subject.

## Contracts

- `decideEmailMatchedAccount({provider, emailVerified, existing})`: `existing` gains
  `emailVerified: boolean` (the account's person has a verified email, `personEmailVerified`).
  A verifying provider (Google, Apple) with `email_verified` reaches an account whose email is
  verified, whatever else the account has (password, other links). An unverified account keeps
  today's rules (password, a link at the same provider, or a non-verifying provider's link refuse
  with `sign_in_to_link`). An unverified provider email always refuses.
- `IdentityToken.email` (existing predicate `auth:email`, unused until now) records the provider's
  verified email (normalised) when a link is created, by `signinOAuth` and `linkOAuthIdentity`.
- A linked identity signs in to its account only while its email is the one it was linked with:
  the recorded `email`, or, for a link that recorded none (written by an earlier release), an email
  that still resolves to the linked account (`findAccountForOAuthEmail`); such a link gets the
  email recorded. When the token's verified email differs, the identity's link to the old account
  is removed and the sign-in continues by email (rule above, or a new account). A token without a
  verified email (an Apple token without `email`) still signs in by its link: nothing to compare.
- `startOidcSignin({input?, providerHint?, …})` and `startNativeOidcSignin`: with no `input` and a
  valid `providerHint`, the sign-in starts at the default issuer (`Auth.oidcSignin.defaultIssuer`,
  else webid.email) with `provider_hint` and no `login_hint`. No input and no valid hint stays
  `invalid_input`.

## Pitfalls

- The existing rule for a linked identity was "the subject decides, the email is not consulted";
  two unit tests assert it (`a linked identity signs in to its account without looking at the
  email`, `a linked sign-in whose email is another address does not mark the email verified`).
  They change: a link recorded with another email still signs in (explicit `linkOAuthIdentity`
  of a provider with a different address, e.g. Apple's private relay), a link whose email changed
  does not.
- Removing the stale link before creating a new one keeps "one identity, one account" (otherwise
  the identity would be linked to two accounts and fail closed on the next sign-in).
- `findAccountForOAuthEmail` returns a conflict for ambiguous data; a legacy link whose email
  resolves ambiguously counts as not matching.

## Phases

### Phase 1 — The existing-account rule

Tasks:
1. `src/helpers/oauth-account.ts`: `EmailMatchedAccountFacts.emailVerified`; the verified-account
   rule; doc comment.
2. `src/utils/oauthIdentities.ts`: `createLink` records the normalised verified email;
   `findLinks` returns `email`; `recordLinkEmail(linkId, email)`; `removeLink(linkId)`.
3. `src/backend.ts` `signinOAuth`: the linked-identity branch checks the email (recorded, else
   resolved), removes stale links, backfills legacy links; the email branch passes
   `emailVerified`. Doc comments.
4. Tests: `test/oauth.test.mjs` (decision rules; password + verified → same account; unverified
   provider email → refused; different email → new account; changed email → not the old account,
   link removed; legacy link backfilled; recorded cross-email link still signs in);
   `test/integration/oauth.fuseki.test.mjs` (password account with verified email + Google →
   same account; unverified password account still refused; a different email → new account;
   changed email → new account, old link gone; email recorded on the link).
5. Readme §Signin with OAuth: the rule.

Validation: `npx linked build`; `npm test` and `npm run test:integration` pass; the changed
existing tests are named in the report.

**Done.** Build ok; `npm test` 530/530 (baseline 523; +7 in `oauth.test.mjs`); `npm run
test:integration` 46/46 (baseline 42; +4). Existing tests changed: the two linked-identity tests
in `oauth.test.mjs` (fixture link now records the address it was linked with; the first renamed),
the `decideEmailMatchedAccount` rule test (facts gain `emailVerified`), and `webid.test.mjs`'s
count of `Auth.webIdFor(` call sites (9 → 10).

### Phase 2 — A provider start without an email

Tasks:
1. `src/backend.ts`: `startOidcSignin` and `startNativeOidcSignin` accept no `input` with a valid
   `providerHint` (default issuer, no `login_hint`); one shared helper for the input/issuer step.
2. `src/hooks/useAuth.tsx`: `input` optional in `startNativeOidcSignin`'s options.
3. Tests: `test/oidc-callback.test.mjs` (provider_hint alone → a valid authorization URL at the
   mock issuer with `provider_hint` and no `login_hint`, and the sign-in completes; no input and no
   hint → `invalid_input`); `test/oidc-native.test.mjs` (the same start natively).
4. Readme §Sign in through a Solid-OIDC issuer; changeset (minor); A7 in plan 001.

Validation: build; `npm test` and `npm run test:integration` pass.

**Dependencies:** phase 2 is independent of phase 1 (different methods); done in order, one commit
each.
