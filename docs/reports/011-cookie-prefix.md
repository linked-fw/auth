---
summary: >
  A configurable prefix for every cookie @_linked/auth sets and reads (AUTH_COOKIE_PREFIX, or
  Auth.cookiePrefix): accessToken, refreshToken, linkedAuthSession and the express-session cookie
  linked.auth, on the server and in the client's session hint. Two Linked apps on one host (CN on
  :4040, webid.email on :4050) keep separate sessions. Default empty: today's names.
---

# 011 — Cookie-name prefix

## Outcome

Browsers share cookies across ports, so CN and a local webid.email signed each other out. Each app
now sets its own prefix and every auth cookie carries it; an app that sets nothing keeps today's
names. Step A6 of [plan 001](../plans/001-webid-signin-track.md#a6--cookie-name-prefix).

## Public API

- `AUTH_COOKIE_PREFIX` (env, read once on first use) or `Auth.cookiePrefix` (static accessor on
  `Auth`, wins over the env; set before `setupBeforeControllers`). Letters, digits, `_`, `.`, `-`;
  anything else throws.
- `@_linked/auth/utils/cookieNames`: `getCookiePrefix()`, `setCookiePrefix(p | undefined)`,
  `authCookieName(base)`.
- `@_linked/auth/utils/cookies`: `accessCookieName()`, `refreshCookieName()`,
  `sessionHintCookieName()`; `ACCESS_COOKIE`, `REFRESH_COOKIE`, `SESSION_HINT_COOKIE` stay the base
  names. `@_linked/auth/backend`: `sessionCookieName()`; `SESSION_COOKIE_NAME` stays `linked.auth`.
- Client: reads `process.env.AUTH_COOKIE_PREFIX` literally, so the app inlines it with the Linked
  CLI's `createViteConfig({define})`.

## Files

- `src/utils/cookieNames.ts` (new), `src/utils/cookies.ts`, `src/utils/authClient.ts`
  (`hasSessionHint`), `src/backend.ts` (session middleware, token reads), `src/utils/auth.ts`.
- `test/cookie-prefix.test.mjs` (11 tests), `test/integration/cookie-prefix.fuseki.test.mjs` and
  its app process `test/integration/prefixedApp.mjs`; `test/integration/fuseki.mjs` exports
  `testDataset`.
- `readme.md` (*Two Linked apps on one host: a cookie prefix*, env table), plan 001 (A6 section,
  contract 2, Progress), `.changeset/cookie-prefix.md` (minor).

## Decisions (tasks mode, within the scope)

1. One isomorphic module holds the prefix, so the client never imports `utils/auth`;
   `Auth.cookiePrefix` is an accessor delegating to it.
2. The env is read lazily on first use and cached (a `.env` loaded after import still counts).
3. Exported base constants keep their values; new functions give the names in use.
4. The express-session name is taken when the middleware is installed.

## Phases and validation

| Phase | Result |
|---|---|
| 1 Prefix every name | `npm test` 517/517 (507 existing unchanged + 10) |
| 2 Two-app test, docs, changeset | `npm test` 517/517; `npm run test:integration` 42/42 |
| Review fix | `npm test` 518/518; `npm run test:integration` 42/42 |

## Review

- Medium, fixed: the client first read `process.env?.[name]`, which no `define` inlines. Now
  literal; `esbuild --define:process.env.AUTH_COOKIE_PREFIX="cn_"` emits `return "cn_"`, and a
  unit test guards the token.
- No other cookie is set or read by auth.

## Tests

- Unit: every name carries the prefix; sign-in sets only prefixed cookies; express-session sets
  `cn_linked.auth`; a page load and a refresh use the prefixed cookies and ignore unprefixed ones;
  sign-out clears only prefixed names; `hasSessionHint` honours it; the static wins and validates;
  unset or empty env gives `accessToken`/`refreshToken`/`linkedAuthSession`; invalid env throws.
- Integration: two app processes (`cn_`, `wie_`) on one Fuseki dataset, one port-blind cookie jar;
  sign out of `cn_` → `cn_` has no page session and nothing to refresh, `wie_` still renders signed
  in and refreshes. A control run with both prefixes empty fails.

## Follow-ups

Recorded in [plan 001 §A6 Consumers](../plans/001-webid-signin-track.md#a6--cookie-name-prefix),
routed by CN's master plan 065:
- webid.email sets `wie_` locally and reads the hint with `sessionHintCookieName()` in
  `src/oidc/provider.ts` (today the base `SESSION_HINT_COOKIE`).
- CN sets `cn_` locally and inlines it through `createViteConfig({define})`.
- 065 §Contracts 2 gets the two `AUTH_COOKIE_PREFIX` rows.
