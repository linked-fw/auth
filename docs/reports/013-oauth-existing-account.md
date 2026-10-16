---
summary: >
  One verified email is one account: signinOAuth signs a Google/Apple identity into the existing
  account whose email is verified and equals the provider's verified email, password or not.
  Links record the provider's email, and a linked identity whose email changed leaves the old
  account. startOidcSignin (and the native start) accept a provider hint with no typed email.
---

# 013 — OAuth into an existing account, and a provider start without an email

## Outcome

Step A7 of [plan 001](../plans/001-webid-signin-track.md#a7--oauth-into-an-existing-account-and-a-provider-start-without-an-email),
from webid.email's backlog 008 (W5). The owner's decision: same verified email = same account
(arch-08 §One email, one persona); never a different email, never an unverified one; the email
decides, not the provider's subject. Needed before Peace Game's migration (P1), where every
migrated user has a password and may sign in with Google.

## Behaviour

- **Existing account.** A verifying provider (Google, Apple) with a verified email reaches the
  account that email resolves to whenever the account's email is verified too
  (`personEmailVerified`): a password or other links no longer refuse it. An account whose email
  is not verified keeps the old rules (no password, no unverified-provider link, no other identity
  at the same provider), so pre-account hijacking stays closed. An unverified provider email or a
  different email never reaches the account.
- **Changed email.** `IdentityToken` links now record the provider's verified email (`auth:email`,
  normalised), from `signinOAuth` and `linkOAuthIdentity`. A linked identity signs in to its
  account only while its verified email is the recorded one; when it changed, its link is
  removed and the sign-in continues by the new email (that email's account under the rule above,
  or a new account). A link from an earlier release (no recorded email) is followed while the
  provider's email still resolves to the linked account, and then gets the email recorded. A
  token with no verified email (Apple, some sign-ins) follows its link.
- **Provider start without an email.** `startOidcSignin({providerHint})` and
  `startNativeOidcSignin({providerHint, redirectUri})` with no `input` start at the default
  issuer (`Auth.oidcSignin.defaultIssuer`, else webid.email) with `provider_hint` and no
  `login_hint`. No input and no valid hint is still `invalid_input`.

## Phases and validation

| Phase | Validation |
|---|---|
| 1 — the existing-account rule (`oauth-account.ts`, `oauthIdentities.ts`, `signinOAuth`, readme) | build ok; `npm test` 530/530; `npm run test:integration` 46/46 |
| 2 — the provider start without an email (`startOidcSignin`, `startNativeOidcSignin`, client types, readme, contract 4, changeset) | build ok; `npm test` 533/533; `npm run test:integration` 46/46 |

Final runs (baseline on `main`: 523 and 42):

```
npm test                    # tests 533  # pass 533  # fail 0   (5.6 s)
npm run test:integration    # tests 46   # pass 46   # fail 0   (5.4 s, local Fuseki)
```

New tests: unit `oauth.test.mjs` (+7: password account with verified email → same account;
verified account with another Google identity → same account; unverified provider email →
refused; different email → new account; changed email → link removed, new account; earlier-release
link kept and recorded; earlier-release link whose email moved → removed), `oidc-callback.test.mjs`
(+2: hint-only start builds a valid authorization URL at the mock issuer — code flow, S256, state,
nonce, client_id, redirect_uri, `provider_hint`, no `login_hint` — and completes; nothing typed
needs a plain hint), `oidc-native.test.mjs` (+1); integration `oauth.fuseki.test.mjs` (+4: the
same four cases against Fuseki, including one link per identity after the email change and the
recorded email).

**Existing tests changed by the rule:**
- `oauth.test.mjs` *a linked identity signs in to its account without looking at the email* →
  *… while it keeps the email it was linked with*: its link fixture now records the address it
  was linked with (a link with no recorded email and another address is now the changed-email
  case).
- `oauth.test.mjs` *a linked sign-in whose email is another address does not mark the email
  verified*: the same fixture change; assertions unchanged.
- `oauth.test.mjs` *decideEmailMatchedAccount: each rule*: facts gain `emailVerified`; the
  verified rules are added, the old ones unchanged.
- `webid.test.mjs` counts `Auth.webIdFor(` call sites in the built backend: 9 → 10 (the
  changed-email check resolves the email as a sign-in would).

All other existing tests, the pre-account-hijacking ones included (`a verified email does NOT
reach an existing account that has a password`, integration `a Google sign-in does not reach a
password account registered for that email`), pass unchanged: their accounts' emails are not
verified.

## Decisions (tasks mode, within the scope)

1. "Has since changed" needs the email the link was made with, so links record it in the existing
   but unused `auth:email` property. That keeps an explicit `linkOAuthIdentity` of a provider with
   another address (Apple's private relay) working while the provider keeps that address.
2. A changed-email link is removed rather than left: otherwise the identity would be linked to two
   accounts and fail closed on its next sign-in.
3. The native start gets the hint-only start too (same code path; Peace Game is native).

## Review

No medium or higher findings. Low, recorded in [backlog 007](../backlog/007-oauth-email-rule-edges.md):
a verification link opened by the owner on an account someone else registered now also lets the
owner's Google sign-in reach it; and earlier-release links with a different address are dropped on
their first sign-in after the upgrade (P1 should count them first; the query is in 007).

## Follow-ups

- CN master plan 065 §Contracts 4: add the hint-only start (plan 001 contract 4 has it).
- CN (C3 follow-up): "Continue with Google" can call `startOidcSignin({providerHint: 'google'})`
  with no email.
- webid.email backlog 008: items 1 and 2 are settled by this release (no "Connect Google" needed);
  items 3 and 4 are webid.email's own.
- Peace Game (P1): run the count in backlog 007 §2 before upgrading.
- Backlog [007](../backlog/007-oauth-email-rule-edges.md): the two edges above.
