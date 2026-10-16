---
summary: >
  A Solid-OIDC token's verified email now proves its WebID also when the app's default issuer
  vouches for a WebID on its own origin (webid.email's emails count in production), and with
  NODE_ENV development or test from any issuer. One UserAccount per WebID: the OIDC callback, code
  sign-in and signup reuse an account dev sign-in made without a person.
---

# 014 — Email proof by the default issuer, and one account per WebID

## Outcome

Step A9 of [plan 001](../plans/001-webid-signin-track.md#a9--email-proof-by-the-default-issuer-and-one-account-per-webid),
from Create Now's backlog 110 §1–2 (found by step C4, `WEBID_MODE=production`): no webid.email
email proved its WebID in production, and a dev sign-in followed by an issuer sign-in left two
`UserAccount`s for one WebID.

## Behaviour

- **What "proven" means** (`emailProven`, and only then is the email stored on the account and
  marked verified): `email_verified` is true and one of
  - **derivation** (unchanged): `Auth.webIdFor(email) === webid`;
  - **default issuer:** `iss` is the app's default issuer (`Auth.oidcSignin.defaultIssuer`, else
    webid.email, compared exactly, as the issuer's metadata must name it) and `webid` is on that
    issuer's origin. The default issuer vouches for its own WebIDs' emails;
  - **development and test:** `NODE_ENV` is `development` or `test` (auth's `isDevelopmentLikeEnv`,
    the guard the secret fallbacks use), any issuer. A warning naming the issuer is logged each time.
  Any other issuer's email is unproven, whatever it claims.
- **One account per WebID.** Cause: `signinDev` keeps no Person (the profile is the issuer's), and
  the OIDC callback's new-Person branch created a new account without looking for one
  (`getOrCreateAccount` ran only when the Person existed). A helper, `accountForNewPerson`, now
  finds the account whose `sioc:account_of` is the new Person's IRI and reuses it (storing the
  email on it when it has none), else creates one. It serves the OIDC callback, code sign-in and
  signup, which had the same branch. OAuth already finds the WebID's account
  (`findAccountForOAuthEmail`). A reused account reports `isNewAccount: false`, in the OIDC outcome
  and to `onSigninSuccessful` (so `extendAuthSession` runs): `Auth.login`'s `createAccount` may now
  return `isNewAccount`, default `true`.
- The mismatch hook's `hasAccount(email)` already looks up the account's stored email first, so
  with webid.email's emails stored in production it finds accounts there too (backlog 110 §1's
  third consequence).

## Verify

| Phase | Validation |
|---|---|
| 1 — the email rule (`emailProvesWebId`, readme, doc comments) | build ok; `npm test` 545/545; `npm run test:integration` 47/47 |
| 2 — one account per WebID (`accountForNewPerson`, `Auth.login`, contract 4, changeset) | build ok; `npm test` 548/548; `npm run test:integration` 48/48 |

Final runs (baseline on `main`: 536 and 47):

```
npm test                    # tests 548  # pass 548  # fail 0
npm run test:integration    # tests 48   # pass 48   # fail 0   (3.8 s, local Fuseki)
```

New tests:
- `oidc-callback.test.mjs` (+11): proven by derivation from a non-default issuer in production;
  proven by the default issuer for a WebID on its origin with no derivation, in production; a
  non-default issuer not proven in production; a WebID off the default issuer's origin not proven
  in production (the existing "another issuer's email" test, now under `production`); any issuer
  proven under `development` and `test`; the development rule not applied under `production`,
  `staging` and unset `NODE_ENV`; `email_verified: false` unproven even in development; an account
  without a person reused.
- `signin-code.test.mjs`, `signup.test.mjs` (+1 each): the account dev sign-in left is reused.
- `oidc.fuseki.test.mjs` (+1, real store): `signinDev`, then the mock issuer for the same WebID →
  one `sioc:account_of`, `isNewAccount: false`, the proven email on it.

Measured against the code without the change (`src/` stashed, rebuilt): the default-issuer,
`development` and `test` tests fail, the reuse unit test fails, and the integration test fails
(`not ok 29 - a dev sign-in, then an issuer sign-in of the same WebID: one account`). The
production refusals pass either way, as they should.

## Deviations

- **The dev guard is an allow-list** (`development`, `test`), not "anything but `production`": the
  owner's decision says both "outside production" and "development and test only", and CN's
  staging runs with `NODE_ENV=staging`, which must not trust any issuer's email. An unset
  `NODE_ENV` is strict too.
- **Code sign-in and signup** get the account reuse too (the owner's "every method"); OAuth needed
  nothing.
- **Dropped test:** a default issuer with a path (the issuer check then fetches the WebID's profile
  from the issuer's origin, which the mock issuer does not serve); the origin comparison is the
  same code as for the origin-root issuer.

## Contracts

001 §Contracts 4 updated (the email rule, and one account per WebID). CN's 065 §Contracts 4 needs
the same text: the master-plan agent copies it.

## Follow-ups

- **CN** (backlog 110 §1–2, routed by master plan 065): after the release and its Renovate bump,
  C4's production run should log `email proven: yes` for webid.email sign-ins, and email
  invitations resolve there; CN needs no new option (its default issuer is webid.email). Close §1
  and §2.
- Existing duplicate accounts in developer data are not merged (dev only; no production data).
