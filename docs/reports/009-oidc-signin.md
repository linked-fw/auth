---
summary: >
  Sign-in through a Solid-OIDC issuer in @_linked/auth, opt-in with Auth.oidcSignin:
  startOidcSignin finds the issuer and returns its authorization URL (PKCE, DPoP key bound with
  dpop_jkt, login_hint, prompt=none, provider_hint); the /auth/oidc/callback route exchanges the
  code on openid-client, checks the ID token and the WebID's issuer, reports an email mismatch to
  the app and starts a session. Every outbound request goes through a DNS-pinned guarded fetch.
---

# 009 — Sign-in through a Solid-OIDC issuer

## Outcome

Any Linked app can now sign users in with their WebID. The user types an email or a WebID; auth
finds the issuer (A1's discovery: the profile, WebFinger, else webid.email) and the browser goes
there. It comes back to `{SITE_ROOT}/auth/oidc/callback`, and auth checks what the issuer sent.
The person whose IRI is the verified WebID then gets an account and a session, exactly as the
other methods end. The issuer's tokens are discarded. An app that does not set `Auth.oidcSignin`
sees no difference: no route, and the start method answers `not_configured`. Every existing
method is unchanged.

Step A2 of [plan 001](../plans/001-webid-signin-track.md#a2--the-redirect-and-callback),
implementing contract 4 against contract 3's public client. PR
[#127](https://github.com/linked-fw/auth/pull/127). Design: arch-08 §Sign-in, §Protocol
and §Verified email decides the WebID, plan 063 decisions 1, 2 and 10 (in Create Now). It also
closes A1's DNS-rebinding follow-up.

## Public API

- **`Auth.oidcSignin?: OidcSigninConfig`** (`utils/auth.ts`), every field optional:
  - `clientId` (default: the Client ID Document URL; startup fails without it or
    `Auth.signinClient`), `defaultIssuer`, `allowLocalhost`, `requireEmail`, `timeoutMs`;
  - `discovery` (skip list and cache options);
  - `onEmailMismatch({hinted, returned, webId, issuer, hasAccount})` → `'signin'` (default) or
    `'refuse'`;
  - `onResult(outcome)` → a location, or `undefined` for the default.
- **`startOidcSignin({input, prompt?, providerHint?, returnTo?})`**, declared `'public'`, rate
  rule `oidcSignin`.
  - Answers `{url}`, or `{error, action}` with `action` one of `not_configured`, `invalid_input`,
    `issuer_not_found`, `invalid_issuer`, `issuer_unreachable`, `no_session` or `rate_limited`.
- **`GET /auth/oidc/callback`**, rate rule `oidcCallback`. It redirects to `onResult`'s location,
  by default `returnTo`/`/` on success or `/signin?oidc_error=<error>` on failure.
  - The outcome is `{ok: true, webId, issuer, email?, emailProven, isNewAccount, returnTo?,
    mismatch?}` or `{ok: false, error, returnTo?, mismatch?}`.
  - Errors: `login_required`, `interaction_required`, `access_denied`, `issuer_unreachable`,
    `issuer_refused`, `invalid_token`, `missing_claim`, `invalid_state`, `email_mismatch`,
    `rate_limited`, `failed`.
- **`@_linked/auth/utils/oidcSignin`** (no Express, no store):
  - `createOidcRelyingParty({clientId, redirectUri, …})` → `{begin, complete, clearCache}`;
  - `isIssuerIdentifier`, `sameIssuer`, `jwkThumbprint`, `OIDC_SIGNIN_SCOPE`,
    `defaultOidcResultLocation`, `safeReturnTo`, and the types.
- **`@_linked/auth/utils/guardedFetch`**: `createGuardedFetch({allowLocalhost, resolve?})`,
  `guardedLookup`, `BlockedAddressError`, `RefusedUrlError`.
- **`isBlockedAddress`**, newly exported from `utils/issuerDiscovery`.

## Files

| File | Responsibility |
|---|---|
| `src/utils/guardedFetch.ts` | undici `fetch` with an `Agent` whose `lookup` resolves every address and refuses private ones (loopback only with `allowLocalhost`); URL check first (IP literals skip `lookup`); never follows redirects |
| `src/utils/oidcSignin.ts` | The relying party on openid-client: `begin` (PKCE `S256`, `state`, `nonce`, ES256 DPoP key and `dpop_jkt`, hints), `complete` (grant with a DPoP proof, `enableNonRepudiationChecks` for the JWKS signature, `iss` tied to the pending issuer, `webid`/`auth_time` required, the issuer check), a bounded metadata cache; the configuration and outcome types |
| `src/helpers/oidcPending.ts` | Pending sign-ins in `req.session`, keyed by `state`: 10 minutes, at most 5, removed on first lookup |
| `src/backend.ts` | `startOidcSignin`; `handleOidcCallback`, `signInVerifiedWebId`, `hasUnprovenPassword`, `hasAccountForEmail`, `oidcRuntimeFor` (module functions, not dispatchable); the route after the session middleware and the startup check |
| `src/utils/auth.ts` | `Auth.oidcSignin` |
| `src/utils/rateLimit.ts` | Rules `oidcSignin`, `oidcCallback` (20/minute per IP) |
| `src/utils/issuerDiscovery.ts` | `isBlockedAddress`; Teredo, discard and documentation IPv6 ranges blocked |
| `test/mockIssuer.mjs` | Mock Solid-OIDC issuer: discovery, JWKS, authorize, a token endpoint checking PKCE, the DPoP proof and `dpop_jkt`; a profile host on another origin; knobs for every refusal |
| `test/guarded-fetch.test.mjs`, `test/oidc-signin.test.mjs`, `test/oidc-callback.test.mjs`, `test/integration/oidc.fuseki.test.mjs` | New tests (below) |
| `test/exposure.test.mjs`, `test/webid.test.mjs` | The new public method in the surface; `Auth.webIdFor` call count 7 → 9 |
| `package.json`, `package-lock.json` | `openid-client` ^6.8.8, `undici` ^8.12.1 |
| `readme.md` | "Sign in through a Solid-OIDC issuer"; RPC table, rate-limit rows; issuer discovery's DNS note |

## Decisions (tasks mode, within the plan)

1. **Pending state in express-session.** The session already exists, with its SQLite store, and
   keeping the record there binds the callback to the browser that started it, so a code opened
   in another browser is refused (login CSRF). The DPoP key pair is stored as JWKs.
2. **`dpop_jkt` on the authorization request**, so the code is bound to the key held from the
   start (RFC 9449 §10).
3. **undici's own `fetch` and `Agent`**: one version for both, and Node's built-in fetch bundles
   another undici.
4. **The configuration is a static on `Auth`**, next to `signinClient` and `webIdFor`, read
   without environment variables.
5. **The callback ends in a redirect.** `onResult` chooses the location, and by default no email
   goes into the URL.
6. **Issuer comparison** ignores one trailing slash and is otherwise exact.

## Phases and validation

| Phase | What | Validation |
|---|---|---|
| 1 | Guarded fetch, `isBlockedAddress`, dependencies | `node --test test/guarded-fetch.test.mjs test/issuer-discovery.test.mjs`: 53/53 |
| 2 | Exchange module, mock issuer | `node --test test/oidc-signin.test.mjs`: 21/21; each `invalid_token` case asserts its reason from the log |
| 3 | Provider wiring | `npm test` 469/469; `npm run test:integration` 40/40 |
| 4 | Readme, changeset | full gates as below |
| Review | Fixes below | `npm test` 475/475; `npm run test:integration` 40/40 |

## Review

An independent review found:

1. **Critical: issuer URLs containing `/.well-known/` (confirmed with a proof of concept).**
   openid-client reads such a URL as the metadata document itself and skips the issuer
   comparison. So a profile naming `https://evil/x/.well-known/openid-configuration` could
   declare itself `https://webid.email` and mint tokens for any WebID. Fixed in three places:
   - `isIssuerIdentifier` refuses `/.well-known/`, queries and fragments;
   - the discovered metadata must name the issuer that was asked for;
   - the ID token's `iss` must be the pending issuer.
2. **High: the same-origin shortcut trusted path-based issuers on shared origins.** Fixed: the
   profile fetch is skipped only for an issuer that is the root of the WebID's origin.
3. **High: an email any issuer can claim was stored on new accounts.** The code, reset, OAuth and
   signup lookups find accounts by that email. Fixed: the email is stored, and marked verified,
   only when it proves the WebID (`emailProven`).
4. **Medium: a sign-in without an email proof left an unverified password on the person.** Fixed:
   the WebID proof ends it too, and only when such a password exists, so later sign-ins do not end
   each other's sessions.
5. **Lows:** `buildAuthorizationUrl` could throw; three IPv6 ranges were missing. Both fixed.

My own review found an unbounded issuer-metadata cache (medium), now bounded at 100, and a
configuration broken after startup throwing from the RPC (low), now reported.

A re-review of the fixes found nothing at medium or above. Its low finding was fixed: the
`/.well-known/` guard now also checks the parsed and lowercased URL, so backslash and uppercase
spellings are refused before discovery. A backslash attack had already failed at the metadata
check.

## Tests

- `test/guarded-fetch.test.mjs`, 11 tests:
  - the address ranges;
  - private, mixed and loopback answers refused in `lookup`, answering in both forms;
  - `ENOTFOUND` and resolver errors;
  - a private name refused before any request;
  - URLs refused before any lookup;
  - a local server reached through the lookup;
  - redirects not followed.
- `test/oidc-signin.test.mjs`, 25 tests:
  - the URL parameters;
  - a full exchange (DPoP `jkt` and PKCE checked by the issuer, no profile fetch on webid.email's
    origin shape);
  - wrong `nonce`, wrong `aud`, wrong `iss`, expired, foreign signing key;
  - missing `webid` or `auth_time`, and `email` with `requireEmail`;
  - the issuer in the profile on another origin; not in it; no issuer; no profile; unfetchable
    WebIDs;
  - `login_required` and the other authorization errors; another `state`; a replayed code;
  - unusable issuers; `.well-known`, query and fragment issuers;
  - metadata naming another issuer; a path issuer on the WebID's origin;
  - the metadata cache's TTL and bound; `sameIssuer`.
- `test/oidc-callback.test.mjs`, 19 tests (a real express app with a cookie jar):
  - a new email: person, account, verified email, session and redirect;
  - an existing person, and a pre-registered password removed;
  - unverified emails, and another issuer's verified email, not stored;
  - an unproven password ended once;
  - a typed WebID;
  - a mismatch, both by default and when refused, with `hasAccount`;
  - a callback opened in another browser, and a replayed one;
  - `login_required`, `issuer_refused`, `onResult`, `returnTo`, the provider hint;
  - start errors, an app that did not opt in, the startup checks, the callback rate limit.
- `test/integration/oidc.fuseki.test.mjs`, 2 tests against a real dataset:
  - a new WebID gets a person, an account with its email, a verified email, and a session that
    authenticates the next request;
  - signing in again reaches the same account.

## Known limitations and follow-ups

- **Contract 4 changed** (plan 001, Contracts §4): the profile fetch is skipped only for an
  origin-root issuer, and the token's email is trusted only with `emailProven`. CN's 065
  §Contracts 4 needs the same wording, and C2b's email-based invitations must use only an email
  with `emailProven`.
- **Native apps** cannot use the cookie-bound pending state or the redirecting route. This is
  recorded under A4's Pitfalls in plan 001.
- Two tabs starting at the same instant can lose one pending record (express-session saves the
  whole session, and the last write wins); the user starts again. An abandoned sign-in's DPoP key
  stays in its session row until the next start in that session prunes it.
- The check that the token's `iss` equals the pending issuer is defence in depth. openid-client's
  own comparison plus the metadata check already imply it, so no test reaches it.
- Create Now picks this up after the release. Its root `npm install` brings in `openid-client`
  and `undici`. Bypass sign-in on 4040 and `tests/e2e/signin.spec.ts` were not run against this
  branch, because the localized checkout stays on `main`.
