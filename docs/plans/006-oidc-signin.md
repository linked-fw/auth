---
summary: >
  Working plan for step A2 of plan 001: the Solid-OIDC redirect and callback on openid-client (PKCE,
  DPoP, ID-token checks, issuer check, session creation, mismatch report), with a DNS-pinned fetch
  for every outbound request, tested against a mock issuer.
status: Implementation
---

# 006 — Solid-OIDC sign-in: redirect and callback

Step A2 of [plan 001](001-webid-signin-track.md#a2--the-redirect-and-callback). Contracts 3
(Client ID Document, public client) and 4 (the sign-in exchange) apply. Design: arch-08 §Sign-in,
§Protocol, §Verified email decides the WebID; plan 063 decisions 1, 2 and 10 (in Create Now).

## Scope (from plan 001, A2)

- **Start:** a provider method that, for an email or WebID, discovers the issuer (A1) and returns
  the authorization URL: code flow with PKCE, a DPoP key, `state`, `nonce`, `login_hint`, optional
  `prompt=none` and a provider hint. The pending sign-in (verifier, nonce, DPoP key, hinted email,
  issuer) is kept server-side, keyed by `state`.
- **Callback route:** exchange the code with a DPoP proof; verify the ID token (signature via the
  issuer's JWKS, `iss`, `aud`, `exp`, `nonce`); require `webid` and `auth_time`.
- **Issuer check:** the token's `iss` must be listed as `solid:oidcIssuer` in the `webid`'s profile
  (skip the fetch when the WebID is on the issuer's origin).
- **Session:** find or create the Person (IRI = `webid`) and its `UserAccount`, store `email` when
  given, and create the session exactly as the other methods do. Discard the issuer's tokens.
- **Mismatch report:** compare the hinted email with the token's `email`; when they differ, the
  result tells the app (hinted, returned), and an app hook decides. Any account lookup the hook
  needs runs inside the callback and is not an RPC method.
- **Configuration:** opt-in per app (default issuer, Client ID Document URL from A3, which claims
  are required); errors (`login_required`, a refused issuer check) returned to the app, not thrown.
- **Pitfall carried from A1:** DNS-level SSRF. Resolve-then-pin with an `undici` dispatcher whose
  `lookup` checks every resolved address against A1's blocked ranges, passed to A1's discovery
  through its `fetch` option and used for A2's own requests.

## Tasks-mode choices (within the plan)

1. **Dependencies.** `openid-client` ^6 (ESM, depends on `oauth4webapi` and `jose`) and `undici`
   ^8 (its `Agent` with `connect.lookup`, and its own `fetch` so the dispatcher and fetch are the
   same version; Node's built-in fetch bundles another undici). Both runtime dependencies.
2. **Configuration seam:** a static `Auth.oidcSignin?: OidcSigninConfig`, next to
   `Auth.signinClient` (A3) and `Auth.webIdFor` (A0). Unset → nothing changes: no route, and the
   start method answers "not configured".
   - `clientId` (default `{SITE_ROOT}/.well-known/linked-client.jsonld`; startup fails when neither
     it nor `Auth.signinClient` is set), `defaultIssuer` (A1's default, webid.email),
     `requireEmail` (default `false`: other issuers may omit `email`), `allowLocalhost` (dev),
     `discovery` (A1's cache/skip-list options), `onEmailMismatch` and `onResult` hooks.
3. **Pending state in the server-side session** (`express-session`, already mounted with its
   SQLite store): `req.session` holds pending sign-ins keyed by `state` (at most a few, 10-minute
   expiry, removed on first use). Keeping it in the browser's session also binds the callback to
   the browser that started it, so a code from another browser is refused (login CSRF). The DPoP
   key pair is stored as JWKs and re-imported at the callback.
4. **Exchange module** `src/utils/oidcSignin.ts`, free of Express and the store:
   `createOidcRelyingParty(options)` → `begin(...)` builds the URL and the pending record,
   `complete(pending, callbackUrl)` runs the grant (PKCE, state, nonce, DPoP via
   `getDPoPHandle`, `enableNonRepudiationChecks` for the JWKS signature check), checks `webid`
   and `auth_time`, and runs the issuer check. Results are returned, never thrown.
   `dpop_jkt` is sent on the authorization request (RFC 9449 §10) so the code is bound to the key.
5. **Issuer comparison** is exact, except that one trailing slash is ignored (profiles often list
   `https://issuer/` while `iss` is `https://issuer`).
6. **Callback result:** the route redirects the browser. Success → the `returnTo` given at start
   (same-origin path only) or `/`; failure → `/signin?oidc_error=<code>`. `onResult(outcome)` may
   return another location. Codes: `login_required`, `interaction_required`, `access_denied`,
   `issuer_refused`, `invalid_token`, `missing_claim`, `invalid_state`, `email_mismatch`,
   `rate_limited`, `failed`. No email goes into a URL.
7. **Mismatch hook:** `onEmailMismatch({hinted, returned, webId, issuer, hasAccount})` returns
   `'signin'` (default: B wins, as arch-08 says) or `'refuse'`. `hasAccount(email)` is the
   in-callback lookup (an account with that email, or a person at `Auth.webIdFor(email)`), never
   callable. The outcome passed to `onResult` carries `mismatch: {hinted, returned}` either way.
8. **Session step:** the Person at `webid` and `getOrCreateAccount`, or, for a new WebID, a Person
   and a `UserAccount` (with `email` when given) through `Auth.login`. The email is marked verified
   only when `email_verified` is true and `Auth.webIdFor(email) === webid`, the guard
   `markOAuthEmailVerified` uses. Issuer tokens are not kept.
9. **Rate limits:** a rule `oidcSignin` (per IP) on the start method and one `oidcCallback` (per
   IP) on the callback.

## Phases

### Phase 1 — Guarded fetch and dependencies

- Add `openid-client` and `undici` to `package.json` (lockfile with `--package-lock-only`).
- `src/utils/guardedFetch.ts`: `createGuardedFetch({allowLocalhost, lookup?})` → a `fetch` on
  undici's `fetch` with an `Agent` whose `connect.lookup` resolves with `all: true`, refuses when
  any address is private (or loopback without `allowLocalhost`), and answers in the form Node
  asked for. Export `isBlockedAddress(address, allowLocalhost)` from `issuerDiscovery.ts`
  (reusing its block lists) rather than copying them.
- Tests `test/guarded-fetch.test.mjs`: a host resolving to a private address is refused before a
  connection; a public answer passes the lookup; loopback refused without `allowLocalhost` and
  allowed with it (a real request to a local server); mixed answers (one public, one private)
  refused.
- **Validation:** `npx linked build && node --test test/guarded-fetch.test.mjs test/issuer-discovery.test.mjs`.

### Phase 2 — The exchange module and the mock issuer

- `src/utils/oidcSignin.ts` (choices 4 and 5), types for the pending record and results.
- `test/mockIssuer.mjs`: a `node:http` Solid-OIDC issuer: discovery, JWKS (ES256), `/authorize`
  (records the parameters, redirects with a code or an `error`), `/token` (checks PKCE, the DPoP
  proof's signature, `htm`/`htu` and its key against `dpop_jkt`, `client_id`), profile documents,
  and knobs to tamper with the ID token (nonce, aud, iss, signature, missing claims).
- Tests `test/oidc-signin.test.mjs`: a full exchange; wrong `nonce`, wrong `aud`, bad signature,
  missing `webid`, missing `auth_time`, missing `email` with `requireEmail`; issuer not in the
  WebID's profile; same-origin WebID skips the profile fetch; `login_required` returned;
  `prompt`, `login_hint`, `provider_hint`, PKCE `S256` and `dpop_jkt` on the URL; wrong `state`.
- **Validation:** `npx linked build && node --test test/oidc-signin.test.mjs`.

### Phase 3 — Provider wiring: start, callback, session, mismatch

- `Auth.oidcSignin` and `OidcSigninConfig` (choice 2), startup check in `setupBeforeControllers`,
  the callback route registered after the session middleware.
- `startOidcSignin({input, prompt?, providerHint?, returnTo?})`, declared `'public'`;
  rate-limited; discovery through A1 with the guarded fetch; pending record into `req.session`.
- The callback handler (choices 6–8), helpers outside the class (exposure rule).
- Rate-limit rules (choice 9).
- Tests `test/oidc-callback.test.mjs` (fake store, mock issuer): full sign-in creates the session
  for a new and an existing WebID; email stored; mismatch reported to the hook and both decisions;
  a state from another session refused; pending used once; unconfigured app: no route, start
  refused. `test/integration/oidc.fuseki.test.mjs`: the full sign-in against a real dataset
  creates person, account and session.
- **Validation:** `npx linked build && npm test`; `npm run test:integration` with the
  `AUTH_TEST_FUSEKI_*` variables.

### Phase 4 — Docs, changeset, Verify

- Readme section "Sign-in through a Solid-OIDC issuer" (configuration, the start method, the
  callback, result codes, hooks, the DNS guard, env-free configuration).
- `.changeset/oidc-signin.md` (minor).
- **Validation:** the step's Verify checks below, full gates.

Dependencies: 1 → 2 → 3 → 4, sequential (each builds on the previous module). No parallel work.

## Verify (from plan 001)

- Integration test with a mock Solid-OIDC issuer (local, with JWKS and a profile): full sign-in
  creates the session; a wrong `nonce`, a wrong `aud`, an issuer not in the WebID's profile, and a
  missing `webid` are each refused.
- Mismatch: hint A, token B → reported to the hook.
- The existing methods' tests pass unchanged.

## Progress

- **Phase 1 done.** `openid-client` ^6.8.8 and `undici` ^8.12.1 added (lockfile via
  `--package-lock-only`); `isBlockedAddress` exported from `issuerDiscovery.ts`;
  `src/utils/guardedFetch.ts` (`createGuardedFetch`, `guardedLookup`, `BlockedAddressError`,
  `RefusedUrlError`). The fetch also checks every URL with `isFetchableUrl` (IP literals skip
  `lookup`) and never follows redirects. Validation: `node --test test/guarded-fetch.test.mjs
  test/issuer-discovery.test.mjs` → 53/53 (11 new).
