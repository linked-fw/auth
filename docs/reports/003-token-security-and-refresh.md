---
date: 2026-10-12
summary: >
  Shipped in 1.7.0 (typed access tokens, required secrets, stored SHA-256-hashed refresh tokens
  rotated on every use with reuse detection and revocation), 2.0.1 (fatal missing secrets, refresh
  cookie sized from the server's record) and 3.0.0 (server-set httpOnly cookies, a client refresh
  scheduler with single-flight refresh and retry-on-401, 15-minute access tokens, idle and absolute
  session limits, daily cleanup of old records). Refresh tokens can no longer be used as logins,
  and refresh works for the first time.
---

# 003 — Token security and stored refresh tokens

Converted after the fact, on 2026-10-12, from plan 001, which was implemented but never written
up as a report. This report replaces it as the permanent record.

## Problems found

| # | Problem |
|---|---|
| 1 | Access and refresh token were the same JWT payload (the whole AuthSession) signed with the same secret, with no `typ` or `jti`; only the access token had `aud`. |
| 2 | `verifyToken` and the `expressjwt` middleware checked neither audience nor type, so a 60-day refresh token was accepted as an access token. |
| 3 | `JWT_SECRET` fell back to the literal `'jwt-secret'` everywhere; `SESSION_SECRET` fell back to `md5(filename)` outside development. Anyone could mint tokens for a deployment that forgot the variable. |
| 4 | Refresh never succeeded: it looked up a `RefreshToken` row by the raw JWT, but the write was commented out and no row was ever created (0 `auth:RefreshToken` nodes measured in a real dataset). |
| 5 | Nothing was revoked: sign-out returned `true`, password reset revoked nothing, account removal deleted rows that never existed. |
| 6 | The middleware minted new access tokens it never sent to the client; the client polled `validateToken` every `ACCESS_TOKEN_EXPIRES/5` (2 days in production) and its scheduler was a TODO. |
| 7 | The verification cache kept entries for a full lifetime from first use rather than until the token's `exp` (serving expired tokens as valid) and was never pruned. |
| 8 | Lifetimes were hard-coded with wrong comments, and js-cookie was passed seconds as days (an access cookie for 864 000 days). |
| 9 | `updateSessionData` re-signed a payload that still carried `aud`/`iss`/`sub`, which `jwt.sign` refuses together with `options.audience`. |
| 10 | `removeAccount` passed whole query results to `delete()`, which rejected them, so account removal failed. |

## Design

### Token kinds and secrets (1.7.0, 2.0.1)

- Access tokens carry `typ:'access'`, `aud=SITE_ROOT`, `sid` (session id) and a random `jti` on top
  of the AuthSession payload. Reserved and kind claims are stripped before any re-sign (#9).
- Every access check (`verifyToken`, `verifyAccessToken`, the request middleware,
  `validateRequestToken`) accepts only `typ:'access'` with the expected audience. Tokens without
  `typ` from earlier releases pass only if they carry the audience: old access tokens did, old
  refresh tokens did not. Nobody was signed out, and refresh-as-login is closed.
- `verifyAccessToken(token, {audience?})` is exported so apps stop running their own `jwt.verify`
  (the consuming app has since switched to it).
- Outside `NODE_ENV=development|test` (including an unset `NODE_ENV`), startup fails when
  `JWT_SECRET` or `SESSION_SECRET` is unset; from 2.0.1 as a `FatalConfigError` that aborts
  startup. Development keeps the old fallbacks and warns once.
- The verification cache is bounded, evicts at the token's own `exp`, and holds only successful
  access verifications. A `jsonwebtoken` verify measured ~0.28 ms, so a cache is worth keeping; the
  bug was the expiry rule.

### Refresh tokens: storage, rotation, reuse

- A refresh token is 32 random bytes, base64url: opaque, not a JWT. Only `SHA-256(token)` is stored.
- One `RefreshToken` record per issued token: `tokenHash`, `account`, `sessionId` (shared by every
  rotation of one sign-in), `createdAt`, `lastUsedAt`, `expiresAt`, `revokedAt`, `replacedBy`, and
  from 3.0.0 `sessionStartedAt`.
- `createToken` stores the record itself, so every sign-in path (password, OAuth, temporary, dev,
  `createAccount`, `resetPassword`) gets a working refresh token. `updateSessionData` re-issues an
  access token in the same session and does not rotate.
- Refresh happens only in the `validateToken` RPC, the one path that can hand tokens back to the
  client. The middleware no longer refreshes: rotating there issues tokens nobody receives, and the
  next refresh then looks like theft.
- A refresh looks up the hash, rejects unknown, revoked and expired tokens, creates the replacement
  in the same session, marks the old one `revokedAt` + `replacedBy`, reloads account and person,
  runs the `initialAuthSession`/`extendAuthSession` hooks, and returns a new access token. Expiry
  slides: each new refresh token gets a full lifetime, within the session limits.
- **Reuse detection.** Presenting a replaced token revokes the whole session. Within a 30 s grace
  window, while the session is alive, it is treated as a concurrent tab or a lost response and gets
  a fresh refresh token in the same session. (Originally the grace answer was an access token only;
  browser testing showed a refresh response aborted by a navigation left the browser holding the
  replaced token, whose next use fell outside the window and killed the session.) Concurrent
  refreshes in one process are serialised per token.
- **Revocation triggers.** Sign-out revokes the current session (from the access token's `sid` or
  the refresh token). `resetPassword`, also used for a signed-in password change, revokes every
  session of the account before signing the current device in again. Removing an account deletes
  its records. Idle and absolute limits revoke on the refresh that detects them.

**Storage decision.** The existing `RefreshToken` class was extended rather than adding an
`auth:Session` shape or reusing schema.org terms. Keeping the class and its module path meant apps
that route the shape by import path to a specific dataset needed no routing change; a renamed shape
would have fallen through to a default router. A separate session shape remains the natural next
step once there is a "your active sessions" UI; `sessionId` already groups the records. schema.org
terms were rejected: they mix vocabularies for a security record nothing else consumes.

### Transport (3.0.0)

| Cookie (set by the server) | httpOnly | SameSite | Path | Max-Age |
|---|---|---|---|---|
| `accessToken` | yes | Lax | `/` | the JWT's `exp` |
| `refreshToken` | yes | Strict | `/call/@_linked/auth` | the record's `expiresAt` |
| `linkedAuthSession` = `1` | no | Lax | `/` | as the refresh token |

- The access cookie authenticates full page loads (SSR keeps reading it, so `request.linkedAuth` is
  unchanged). The same token is in the response body; the client keeps it in memory only and sends
  it as `Authorization: Bearer`. The server tries the header first and falls back to the cookie, so
  a stale in-memory token does not hide a cookie another tab renewed. Lax keeps cross-site links
  signed in.
- The refresh cookie is Strict and scoped to the package's RPC path, so it reaches only
  `validateToken`, `signout` and sign-in calls. Browsers no longer get it in response bodies.
- The hint cookie carries no secret; it tells the client a refresh cookie exists, so anonymous page
  loads skip the refresh round trip.
- `Secure` follows `req.secure` (honouring `trust proxy`) or an https `SITE_ROOT`; an https
  `SITE_ROOT` reached over http logs a one-time `trust proxy` warning.
- Native clients register `setAuthTokenStorageMethods`, which adds `x-linked-auth-transport: body`;
  only then does the server return the refresh token in the body.
- Sign-out and a failed refresh clear all three cookies plus a legacy `refreshToken` on `/`. The
  legacy cookie is detected from the raw Cookie header (two `refreshToken` values, or one without
  the hint), because `req.cookies` keeps only one of two same-named cookies. js-cookie is gone.
- Calls without a writable response (SSR-local calls after headers were sent, tests) skip cookies.

Refreshing during SSR was considered and rejected: it needs the refresh cookie on `/` and rotation
in the middleware. An SSR load past the access token's expiry renders anonymous and the client
refreshes on mount; an open tab keeps the access cookie fresh, so reloads during use render signed in.

### Client scheduler (3.0.0)

`src/utils/authClient.ts` (no React):

- `setAccessToken` holds the token in memory, sets the `Authorization` default and schedules the
  next refresh; `scheduleRefreshAt(exp)` schedules from the rendered `auth.exp` after SSR.
- The lead is 60 s, or half the token's lifetime when shorter, at least 1 s. A refresh that returns
  the same `exp` is not rescheduled, so the scheduler cannot loop.
- `refreshAccessToken` is single-flight: concurrent callers share one request.
- `installVisibilityRefresh` refreshes on `visibilitychange`/`focus` when the token is stale.
- `installServerCallRetry` refreshes before sending with an expired token, and on a 401 refreshes
  once and retries once. Auth's own `/call/@_linked/auth/` calls are never intercepted, and a 401
  within 10 s of a successful refresh does not trigger another. It registers through
  `LincdServerProxy.setAuthHandler` (`@_linked/server-utils` ^1.8.0), falling back to wrapping
  `fetchWithRetry` on older copies.
- `useAuth` registers `validateToken(…, {forceRefresh: true})` as the refresh, replaces the polling
  interval, and on `ENFORCE_SIGNIN` tries one refresh before signing out. A refresh with no answer
  (server error) keeps the session.
- A session that ends while a tab is open clears all client state (auth, user, account, token,
  header, schedule); clearing only part of it caused a redirect loop between a sign-in page and
  `RequireAuth`. `user`/`userAccount` keep object identity across a refresh when unchanged.

### Lifetimes and limits (3.0.0)

| Var | development | otherwise |
|---|---|---|
| `AUTH_ACCESS_TOKEN_TTL` | 3600 | 900 (was 864000) |
| `AUTH_REFRESH_TOKEN_TTL` | 2592000 | 5184000 |
| `AUTH_SESSION_IDLE_TTL` | 604800 | 604800 (`0` = off) |
| `AUTH_SESSION_MAX_TTL` | 5184000 | 5184000 (`0` = off) |

- New refresh tokens expire at `min(now + refresh TTL, now + idle TTL, sessionStartedAt + max TTL)`.
- A refresh also checks the limits explicitly (`lastUsedAt` for idle, session start for max), so
  records issued before a limit existed or was lowered are caught; it revokes the session with
  reason `idle` or `session-expired`. Records without `sessionStartedAt` fall back to the earliest
  `createdAt` of their session (one extra query, only for them).
- Idle is measured from the last refresh; with 15-minute tokens an open app refreshes every ~14
  minutes, so it approximates "last time the app was open". Development keeps an hour so a paused
  debugger does not cost a sign-in.

### Cleanup (3.0.0)

`cleanupExpiredSessions(store?, {olderThan, now})` deletes records revoked or expired before the
cutoff (default 30 days, `AUTH_SESSION_CLEANUP_AFTER`). Recently revoked records stay because reuse
detection needs them. It uses the optional store method `findStale(cutoff)` (two date-range queries
on the graph store). The provider runs it 5 minutes after startup and then daily, at most once a day
per process (also across HMR re-setup), on an `unref`'d timer with errors logged.
`AUTH_SESSION_CLEANUP=false` turns it off.

## Public API and configuration

- `@_linked/auth/utils/jwt`: `verifyAccessToken`, `ACCESS_TOKEN_TYPE`.
- `@_linked/auth/utils/sessions`: `issueRefreshToken`, `rotateRefreshToken`, `revokeSession`,
  `revokeAllSessionsForAccount`, `deleteAllSessionsForAccount`, `cleanupExpiredSessions`,
  `setRefreshSessionStore`, `getSessionLimits`/`setSessionLimits`, `REFRESH_REUSE_GRACE_MS`.
- `validateToken(refreshToken?, {forceRefresh?})`; `AuthenticationResult.refreshToken` is optional.
  Token responses carry `refreshTokenExpiresIn` / `refreshTokenExpiresAt` (2.0.1).
- Removed: `RefreshToken.removeRefreshToken` and `getRefreshTokenForAccount`, which matched a raw
  token that was never stored.

| Env var | Required | Default |
|---|---|---|
| `JWT_SECRET`, `SESSION_SECRET` | yes, outside development/test | dev fallbacks, with a warning |
| `SITE_ROOT` | yes (access-token audience) | — |
| `AUTH_ACCESS_TOKEN_TTL`, `AUTH_REFRESH_TOKEN_TTL` | no | see Lifetimes |
| `AUTH_SESSION_IDLE_TTL`, `AUTH_SESSION_MAX_TTL` | no | 604800 / 5184000 |
| `AUTH_SESSION_CLEANUP`, `AUTH_SESSION_CLEANUP_AFTER` | no | on / 2592000 |
| `AUTH_COOKIE_SECURE`, `AUTH_COOKIE_SAMESITE`, `AUTH_COOKIE_DOMAIN`, `AUTH_REFRESH_COOKIE_PATH` | no | auto / per cookie / host / `/call/@_linked/auth` |

A frontend on another site than the backend needs `AUTH_COOKIE_SAMESITE=none`.

## Files

| File | Responsibility |
|---|---|
| `src/utils/jwt.ts` | access-token signing and verification, claim stripping, verification cache |
| `src/utils/secrets.ts` | required secrets and development fallbacks |
| `src/utils/refreshTokenHash.ts` | SHA-256 hashing of refresh tokens |
| `src/utils/sessions.ts` | session store, issue/rotate/revoke, limits, cleanup |
| `src/utils/cookies.ts` | cookie options, Secure detection, set/clear, legacy cookie detection, body transport |
| `src/utils/token.ts` | lifetimes from env, native token storage, transport header |
| `src/utils/authClient.ts` | client scheduler, single flight, visibility refresh, 401 retry |
| `src/hooks/useAuth.tsx` | wires the client into React state |
| `src/shapes/RefreshToken.ts`, `src/ontologies/auth.ts` | the stored record and its terms |
| `src/backend.ts` | `validateToken`, sign-in/out, reset, removal, middleware, cleanup start |

## Test coverage

- Unit (`npm test`, no services): `test/tokens.test.mjs` (token kinds, legacy acceptance, rotation,
  reuse, revocation, secrets, cache expiry), `test/cookies.test.mjs` (real HTTP: flags, max-age, body
  without refresh token, native transport, SSR with only the access cookie, stale Bearer plus valid
  cookie, cookie-only rotation, clearing on failure and sign-out, Secure via trusted proxy only,
  overrides, default TTLs), `test/session-lifetime.test.mjs` (idle, absolute, legacy start, `0` =
  off, cleanup), `test/authClient.test.mjs` (scheduling, no loop, SSR schedule, visibility, single
  flight, 401 retry once, shared refresh for concurrent 401s, auth calls not intercepted, storage).
  Against the 2.0.1 build, 22 of 23 cookie/lifetime tests and the whole client file failed.
- Integration (`npm run test:integration`, Fuseki, throwaway dataset):
  `test/integration/sessions.fuseki.test.mjs` covers rotation, hash-only storage, sign-out and reset
  revocation, account removal, browser cookies end to end, idle, absolute, the legacy-start graph
  query and cleanup through the graph date queries.

## Known limitations

- Refresh tokens issued before 1.7.0 were never stored and are rejected; those users signed in
  again when their access token expired (as before, since refresh never worked).
- An SSR page load after the access token expired renders anonymous until the client refreshes.
- `ENFORCE_SIGNIN` responses (HTTP 200 with `__action`) are not retried; the refresh-then-sign-out
  handler covers them, but the original call returns `undefined`.
- Rate limiting of the refresh exchange came later, in 3.2.0.

## Follow-ups

- A separate session shape when a session-management UI is built.
- Resolved since the plan: the consuming app verifies tokens with `verifyAccessToken`, and
  server-utils' `callCustomShapeMethod` now goes through the auth handler (`fetchWithAuth`).
