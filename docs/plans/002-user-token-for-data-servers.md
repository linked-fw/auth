---
summary: >
  @_linked/auth part of Create Now's plan 080 step R2b: keep a Solid-OIDC session's issuer access
  token and DPoP key server-side, install the headers hook that RemoteDataset calls to send the
  user's token with a fresh DPoP proof, and provide the verifier a data server (CN's gateway)
  uses. Lands together with @_linked/server's part and CN's gateway change.
status: Plan
---

# 002 — The user's token for data servers (Create Now plan 080, step R2b)

Master plan: Create Now `docs/plans/080-datasets-as-workspace-entities.md` (D3c, M7); CN
sub-plan `docs/plans/082-datasets-cn-steps.md` §R2b, gaps G4–G6. Lands on integration branch
`dev` (this checkout joins it first: `npx linked branch start dev @_linked/auth --target main`)
together with `@_linked/server` plan 001 and CN's R2b landing.

## Contracts

Copied from CN plan 082; a change is made there first.

- **C11 User token** (R2b → apps; Logos later).
  - App side (`@_linked/auth`): the server keeps a session's issuer access token and its DPoP key
    server-side, keyed by the session id, never in a cookie; it installs
    `globalThis[Symbol.for('@_linked/auth:userTokenHeaders')]: (request, {method, url}) =>
    Promise<{'x-linked-user-token': string; DPoP: string} | undefined>`, which answers undefined
    once the token expires or for a session with no issuer token (password, email code, guest,
    dev). `@_linked/server`'s `RemoteDataset` (url form) calls it for each request with the
    request's method and full URL, unless `forwardUserToken: false` (or `"false"`), which
    replaces `forwardEndUser`; `x-linked-end-user`, `END_USER_HEADER` and `currentEndUserWebId` go.
  - Verifier `@_linked/auth/utils/solidAccessToken` `verifySolidAccessToken({accessToken, dpop,
    method, url, expectedClientId, allowLocalhost?}) → {webId, issuer, clientId, expiresAt}`:
    JWT signature by the issuer's JWKS (`jwks_uri` of its discovery document), `iss` listed as
    `solid:oidcIssuer` in the `webid` claim's profile, `exp`, `aud` containing `solid`,
    `client_id` = `expectedClientId`; the DPoP proof (`typ dpop+jwt`, its `jwk`'s thumbprint =
    `cnf.jkt`, `htm`/`htu` = method/url, `iat` within 60 s, `ath` = sha256 of the token, `jti`
    not seen in the last 5 minutes).

## Scope

1. **Keep the issuer grant.** `src/utils/oidcSignin.ts` `complete` (:331-421) returns, beside the
   identity, `{accessToken, expiresAt, dpopPrivateJwk, dpopPublicJwk}` from `tokens` (:353-365),
   only when `token_type` is `DPoP` and the token is a JWT (an opaque token is kept out: no data
   server can verify it). The module header (:1-17) and `VerifiedOidcIdentity`'s doc (:95-107)
   change accordingly. Scope stays `openid webid email` (:30); `offline_access` is a follow-up.
2. **Store it per session.** A new `src/utils/issuerTokens.ts`: `IssuerTokenStore` interface
   (`put(sessionId, grant)`, `get(sessionId)`, `remove(sessionId)`), a memory default and a
   setter, as `sessions.ts` does (:67, :195, :251-254); records sealed with the JWT secret (the
   `helpers/oidcSealedPending.ts` sealing); expired entries dropped on read and by
   `cleanupExpiredSessions` (:577). Written in `signInVerifiedWebId` (`backend.ts:943-972`) with
   the new session's id (`createToken` sets `sid`, `jwt.ts:52-86`), for web
   (`completeOidcExchange`, :1010-1063) and native (`completeNativeOidcSignin`, :2173). Removed by
   sign-out, `revokeSession` (`sessions.ts:523`), `revokeAllSessionsForAccount` (:540) and
   account deletion (:557).
3. **The hook.** The backend provider installs `Symbol.for('@_linked/auth:userTokenHeaders')`
   on `globalThis` at start: from `request.linkedAuth` (set by `Auth.setAuthentication`,
   `auth.ts:268-366`) take `sid` (`AuthSession`, `types/auth.ts:159`), read the store, and when the
   grant is valid for at least 30 s build the proof with the stored key (ES256: header `{typ:
   'dpop+jwt', alg, jwk}`, payload `{htm, htu, iat, jti, ath}`), answering both headers; else
   undefined. A refresh of the app's own session (`refreshSession`, `backend.ts:2873`) keeps the
   `sid`, so the grant stays reachable until the issuer token's own `exp`.
4. **The verifier** `src/utils/solidAccessToken.ts` (exported path `utils/solidAccessToken`):
   C11. JWKS fetched and cached per issuer (discovery document, then `jwks_uri`; refetch once on
   an unknown `kid`); the WebID profile read with `fetchOidcIssuers`
   (`issuerDiscovery.ts:628`) and cached for its TTL; localhost only with `allowLocalhost`
   (`isFetchableUrl`, :213); a `jti` replay cache of 5 minutes, bounded. Errors are typed
   (`InvalidUserTokenError` with a reason, `IssuerUnavailableError`) so the gateway maps them to
   401 / 503. Uses `jose` (add as a dependency; `openid-client` already brings it).
5. **Client ID Document** (`clientIdDocument.ts:384-394`): unchanged (`authorization_code`
   only); its comment at :391-393 says the relying party now keeps the access token for data
   servers, still no refresh grant.
6. Docs: the readme's sign-in section (what is kept, for how long, the hook); changeset minor.

## Pitfalls

- The DPoP private key never leaves the server and is never logged; the cookie keeps carrying the
  app's own JWT only.
- Sessions without an issuer token (password `backend.ts:1363`, `createAccount` :1467, email code
  :1957, Google/Apple :2255, guest :2575, dev :2622) answer undefined: their queries act as the
  connection alone (accepted, M7). Do not mint anything for them.
- The memory store loses grants on restart: the user's next queries act as the connection until
  they sign in again (acceptable; a persistent store is the app's choice through the setter).
- `htu` is the exact URL the caller passes; no normalisation beyond what RFC 9449 asks (no query,
  no fragment).
- webid.email gives opaque access tokens today (CN gap G4): unit tests use a local signing key;
  end to end needs webid.email's JWT access tokens.

## Tests

Jest: `oidcSignin` keeps the grant only for a DPoP JWT access token; the store (seal, expiry,
removal on sign-out, revoke, account deletion); the hook (answers for a fresh grant, undefined
for an expired one, for a session without a grant and outside a request; a new `jti` each call;
`ath` matches); the verifier against a local issuer (signature, `iss` not in the profile, `exp`,
`aud`, `client_id`, `cnf.jkt` mismatch, `htm`/`htu` mismatch, stale `iat`, replayed `jti`, unknown
`kid` refetch, unreachable issuer → `IssuerUnavailableError`). Then the package suite and
`npx linked build`; in CN `npm run typecheck:gate` and the regular set against this checkout.

## Verify

- `npx jest` green; `npx linked build` passes; `npx changeset status` lists `@_linked/auth` minor.
- `git grep -n 'access_token' src/utils/oidcSignin.ts` shows it kept, not dropped.
- CN's `tests/integration/app-gateway-user-token.spec.ts` (R2b) passes with this checkout
  localized; with G4 done, an app signed in through webid.email makes a query whose
  `[gateway audit]` line names the user as `actor` and the connection as `channel`.

## Done when

An OIDC session's issuer token and DPoP key are kept server-side and dropped with the session, the
hook and the verifier are exported and tested, readme and changeset are in, and the CN landing of
R2b went in with it. Report: `docs/reports/021-…` (next free), the plan deleted.
