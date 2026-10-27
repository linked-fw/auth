---
date: 2026-10-27
summary: >
  A Solid-OIDC sign-in keeps the issuer's DPoP-bound JWT access token and its DPoP key server-side
  per session (sealed, dropped with the session or at `exp`); the backend installs the headers hook
  RemoteDataset calls to send `x-linked-user-token` with a fresh DPoP proof; data servers verify
  both with `verifySolidAccessToken`. Create Now plan 080 step R2b. Minor; adds `jose`.
---

# 021 — The user's token for data servers

Create Now plan 080 step R2b (CN report 151, `docs/reports/151-user-token-at-the-gateway.md` in
the Create Now repo), with `@_linked/server` report 019 and webid.email report 023. Landed on the
integration branch `dev` together with them.

## PR

### Summary

An app signed in through a Solid-OIDC issuer can now act for its user at a data server: the
issuer's access token is kept (server-side, per session) instead of discarded, `RemoteDataset`
sends it with a DPoP proof per request through a hook this package installs, and a data server
verifies token and proof with this package's verifier.

### Changes

- `src/utils/oidcSignin.ts`: `complete` answers `grant` (`IssuerGrant`: `accessToken`,
  `expiresAt`, `dpopPublicJwk`, `dpopPrivateJwk`) for a DPoP-bound JWT access token with an `exp`
  ahead (`expiresAt` the earlier of `exp` and `expires_in`); an opaque or bearer token is not
  kept. Module header updated. Scope unchanged (`openid webid email`).
- `src/utils/issuerTokens.ts` (new): `IssuerTokenStore` (`put`, `get`, `remove`,
  `removeExpired`), `MemoryIssuerTokenStore` (default), `setIssuerTokenStore` /
  `getIssuerTokenStore` on shared state; records sealed with AES-256-GCM under a key derived from
  `JWT_SECRET`, bound to the session id; `keepIssuerGrant`, `issuerGrantOf` (drops an expired
  one), `dropIssuerGrants`; the hook `userTokenHeaders(request, {method, url})` (the request's
  `linkedAuth.sid`, a grant with at least 30 s left, an ES256 proof with `htm`, `htu` without query
  and fragment, `iat`, `jti`, `ath`; never throws) and `installUserTokenHeaders()`;
  `USER_TOKEN_HEADERS_HOOK`, `USER_TOKEN_HEADER`.
- `src/backend.ts`: after an OIDC sign-in (web callback and native completion share
  `completeOidcExchange`) the grant is kept under the new session's `sid`;
  `setupBeforeControllers` installs the hook.
- `src/utils/sessions.ts`: `revokeSession`, `revokeAllSessionsForAccount` and
  `deleteAllSessionsForAccount` (account removal) drop the sessions' grants;
  `cleanupExpiredSessions` removes expired grants.
- `src/utils/solidAccessToken.ts` (new): `verifySolidAccessToken` (the process's shared
  verifier), `createSolidAccessTokenVerifier(options)`, `InvalidUserTokenError` (`reason`),
  `IssuerUnavailableError`. Keys from the discovery document's `jwks_uri` (its `issuer` must be
  the token's), refetched once on an unknown `kid` (at most every 30 s); the WebID's issuers by
  `fetchOidcIssuers`, cached 5 minutes; a verified token cached by hash until `exp` (at most
  5 minutes); proof `jti`s remembered 5 minutes (per key thumbprint); keys or a profile that
  could not be read are not asked again for 30 s; everything through the guarded fetch.
- `src/utils/clientIdDocument.ts`: comment (the access token is kept, no refresh grant).
- `package.json`, `package-lock.json`: `jose` ^6.2.12 (already installed through
  `openid-client`).
- Tests: `test/issuer-tokens.test.mjs` (new, 8), `test/solid-access-token.test.mjs` (new, 19),
  `test/oidc-signin.test.mjs` (+2), `test/oidc-callback.test.mjs` (+2); `test/mockIssuer.mjs`
  mints Solid-OIDC access tokens, rotates its key, can fail its JWKS.
- `readme.md`: §The user's token for data servers; the sign-in section says what is kept.
- `.changeset/user-token-for-data-servers.md`: minor.

### Verification

```
$ npx linked build
✔ Build successful
$ npm test
# tests 601
# pass 601
# fail 0
$ node --test test/solid-access-token.test.mjs
# pass 19
# fail 0
$ node --test test/issuer-tokens.test.mjs
# pass 8
# fail 0
```

With webid.email's real tokens (its e2e harness on port 4452, a probe spec not committed): a token
from webid.email's code flow verified with `createSolidAccessTokenVerifier` from this build and a
proof from `dpopProofFor`; another `expectedClientId` answered `wrong-client`, another URL `proof`,
the same proof twice `replay`:

```
[probe] verified a real webid.email token: {"webId":"http://localhost:4452/id/12010a8c4c4dad223ce7ce823908c26d#me","issuer":"http://localhost:4452","clientId":"http://localhost:61493/client.jsonld","expiresAt":1793090795000}
  1 passed (17.6s)
```

`npx changeset status --since=origin/dev`, in a plain clone of this branch (in the worktree,
changesets finds Create Now's workspace root first):

```
Packages to be bumped:
- minor
  - @_linked/auth
```

CN's gateway spec and regular set against this checkout: CN report 151 §Verification.

### Deviations

- Tests are node:test against `lib/` (this repo's runner), not Jest as the sub-plan said.
- `IssuerTokenStore` has `removeExpired` beside `put`/`get`/`remove`, so `cleanupExpiredSessions`
  can clean any store.
- A WebID profile that cannot be read is `IssuerUnavailableError` (nothing can be said), like the
  issuer's keys.

### Follow-ups

- `offline_access` refresh of the kept token; tokens for sign-ins without an issuer (password,
  email code, Google, Apple, guest, dev) → Create Now backlog 117 §5, §6.
- A persistent `IssuerTokenStore` is the app's choice (`setIssuerTokenStore`); none ships.

## Details

The proof key never leaves the server and the store holds sealed records only, so a store of the
app's own sees no secret. The seal binds the session id (additional data), so a record copied to
another session does not open. `refreshSession` keeps the `sid`, so the grant stays reachable for
the token's own lifetime; reuse detection revokes the session and with it the grant.

## Review addendum

The review fixes of this step are in Create Now report 151 §Review addendum (`docs/reports/151-user-token-at-the-gateway.md`).
