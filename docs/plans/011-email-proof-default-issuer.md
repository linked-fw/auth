---
summary: >
  Step A9 of CN's master plan 065: a Solid-OIDC token's verified email also proves its WebID when
  the default issuer vouches for a WebID on its own origin, and (development and test only) from
  any issuer; and every sign-in method finds the one UserAccount of a WebID.
status: Tasks
---

# 011 — Email proof by the default issuer, and one account per WebID

**Step:** A9 of [001](001-webid-signin-track.md#a9--email-proof-by-the-default-issuer-and-one-account-per-webid).
Ideation and plan are done (the owner's decisions, in 001 §A9). From CN's backlog 110 §1–2
(findings of step C4).

## Route (decided)

1. `emailProven` (the token's email stored on the account and marked verified) when
   `email_verified === true` **and** one of:
   - **derivation** (unchanged): `Auth.webIdFor(email) === webid`;
   - **default issuer**: the token's `iss` equals the configured default issuer
     (`Auth.oidcSignin.defaultIssuer`, else webid.email) and `webid` is on that issuer's origin;
   - **development and test**: `NODE_ENV` is `development` or `test` (auth's existing
     `isDevelopmentLikeEnv`, the same guard as the secret fallbacks). Never `production`; `staging`
     and an unset `NODE_ENV` stay strict.
2. One account per WebID: `signinDev` keeps no Person, so the Solid-OIDC callback's new-Person
   branch created a second `UserAccount`. That branch now looks for the WebID's account first and
   reuses it (`isNewAccount: false`), storing the proven email on it.

## Contracts

- 065 §Contracts 4 and 001 §Contracts 4: the email rule above replaces "only when
  `Auth.webIdFor(email) === webid`". No signature changes; `OidcSigninOutcome.emailProven` keeps
  its meaning ("the app may resolve by this email").

## Files

- `src/backend.ts`: `emailProvesWebId(identity, email, defaultIssuer)` helper;
  `signInVerifiedWebId` takes the default issuer and reuses an existing account;
  `completeOidcExchange` passes `runtime.defaultIssuer`.
- `src/utils/oidcSignin.ts`: `emailProven` / `defaultIssuer` doc comments.
- `test/oidc-callback.test.mjs`, `test/integration/oidc.fuseki.test.mjs`.
- `readme.md`, `docs/plans/001-webid-signin-track.md` (contract 4), changeset (minor).

## Pitfalls

- Unit tests run with `NODE_ENV=test`: the existing "not proven" tests now need
  `NODE_ENV=production` for their duration, or they pass for the wrong reason.
- The issuer comparison is exact (`iss` is already checked to be exactly the issuer's metadata
  identifier); a configured default issuer with a trailing slash would not match.
- The dev relaxation stores any issuer's claimed email; a staging deployment with
  `NODE_ENV=staging` must not get it (hence the allow-list, not "not production").

## Phases

### Phase 1 — The email rule

- [ ] `emailProvesWebId` in `backend.ts` (derivation, default issuer + origin, development/test),
  wired through `completeOidcExchange` → `signInVerifiedWebId` (web and native).
- [ ] Unit tests (`oidc-callback.test.mjs`): proven by derivation (existing test, under
  `production`); proven by the default issuer for a WebID on its origin whose email does not
  derive it (`production`); not proven for a non-default issuer (`production`); a WebID off the
  default issuer's origin not proven (`production`, existing mallory test); any issuer proven under
  `test` and refused under `production`; `email_verified: false` never proven.
- [ ] Readme: what "proven" means, the dev relaxation and its guard.

**Validation:** `npx linked build`; `npm test` passes (baseline 536); new tests fail without the
change.

### Phase 2 — One account per WebID

- [ ] `signInVerifiedWebId` new-Person branch: create the Person, then reuse the WebID's existing
  account (store a proven email on it), else create one.
- [ ] Unit test: an account without a Person (as `signinDev` leaves it) is reused.
- [ ] Integration test (`oidc.fuseki.test.mjs`): `signinDev` then the mock issuer for the same
  WebID → one `sioc:account_of`, `isNewAccount: false`.
- [ ] Contract 4 in 001 (and 065 via the report), changeset (minor).

**Validation:** build; `npm test` and `npm run test:integration` (baseline 47) pass.

**Dependencies:** phase 2 builds on phase 1's `signInVerifiedWebId` signature; sequential.
