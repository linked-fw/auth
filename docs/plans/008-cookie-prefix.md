---
summary: >
  A6: a configurable prefix for every cookie @_linked/auth sets and reads (AUTH_COOKIE_PREFIX, or
  Auth.cookiePrefix), so two Linked apps on one host (CN on :4040, webid.email on :4050) stop
  sharing sign-in state. Default empty: existing apps see today's names.
status: Implementation
---

# 008 — Cookie-name prefix (A6)

**Step:** A6 of [001 — WebID sign-in track](001-webid-signin-track.md#a6--cookie-name-prefix).
Ideation and plan are done; the step definition is the scope below.

## Scope

Browsers do not separate cookies by port, so two Linked apps on `localhost` share auth's fixed
cookie names: signing out of one signs out the other, and webid.email's issuer session dies with
CN's sign-out. A prefix, `AUTH_COOKIE_PREFIX` (env, read once) or `Auth.cookiePrefix` (a static),
default empty, is applied to every cookie auth sets and reads, server and client side.

Cookies auth owns (inventory from the code):

| Base name | Where | Set/read |
|---|---|---|
| `accessToken` | `src/utils/cookies.ts`, `src/backend.ts` (`getTokenCandidates`, `validateToken`) | server sets, server reads |
| `refreshToken` | `src/utils/cookies.ts` (incl. legacy `/` copy), `src/backend.ts` (`getRefreshTokenFromRequest`) | server sets, server reads |
| `linkedAuthSession` | `src/utils/cookies.ts`; `src/utils/authClient.ts` (`hasSessionHint`) | server sets, client reads (also webid.email's issuer) |
| `linked.auth` | `src/backend.ts` `SESSION_COOKIE_NAME`, express-session (holds A2's pending OIDC sign-ins) | express-session |

Native token storage keys (`ACCESS_TOKEN`/`REFRESH_TOKEN` in `src/utils/token.ts`) are not cookies
and stay unprefixed.

## Decisions (tasks-mode, within scope)

1. **One isomorphic module, `src/utils/cookieNames.ts`**: `getCookiePrefix()`, `setCookiePrefix(p)`,
   `authCookieName(base)`. The env value is read once, lazily on first use (so a `.env` loaded
   after import still counts), and cached; a set value wins. Invalid characters (anything outside
   `A-Za-z0-9_.-`) throw, as the TTL variables do for typos.
2. **`Auth.cookiePrefix`** is a static accessor on `Auth` delegating to that module, so it reads
   and writes like the other statics without making the client import `utils/auth`.
3. **The client learns the prefix the way it learns other auth config**: from
   `process.env.AUTH_COOKIE_PREFIX` through the same guarded `readEnv` as the token lifetimes
   (`src/utils/token.ts`), which a Linked app inlines into its browser bundle with Vite's
   `define` (the Linked CLI's `createViteConfig({define})`). An app that sets only the server side
   still works for server-rendered loads, but `hasSessionHint` would not see the hint; the readme
   says to set both.
4. **Exported base constants stay** (`ACCESS_COOKIE`, `REFRESH_COOKIE`, `SESSION_HINT_COOKIE`,
   `SESSION_COOKIE_NAME`) with today's values, so nothing that imports them breaks; new functions
   return the prefixed names and every internal read/write uses them.
5. **express-session's name is computed when the middleware is installed**
   (`setupBeforeControllers`), so the prefix must be set before that, like `Auth.oidcSignin`.

## Phases

### Phase 1 — Prefix every cookie name (code, unit tests)

- Add `src/utils/cookieNames.ts`; `Auth.cookiePrefix` accessor.
- `src/utils/cookies.ts`: `accessCookieName()`, `refreshCookieName()`, `sessionHintCookieName()`;
  use them in `setAuthCookies`, `hasLegacyRefreshCookie`, `clearLegacyRefreshCookie`,
  `clearAuthCookies`.
- `src/backend.ts`: `sessionCookieName()` for express-session; `getTokenCandidates`,
  `getRefreshTokenFromRequest`, `validateToken`'s `cookieIsCurrent` read the prefixed names.
- `src/utils/authClient.ts`: `hasSessionHint` matches the prefixed names.
- Unit test `test/cookie-prefix.test.mjs`: with a prefix, sign-in sets `<p>accessToken`,
  `<p>refreshToken`, `<p>linkedAuthSession`, express-session sets `<p>linked.auth`; the server
  authenticates a page load and refreshes from the prefixed cookies and ignores unprefixed ones;
  sign-out clears the prefixed names only; `hasSessionHint` honours the prefix; an invalid prefix
  throws; an empty prefix gives today's names (existing tests unchanged).

**Validation:** `npx linked build && npm test` all pass, existing tests unchanged.

### Phase 2 — Two apps in one cookie jar, docs, contract, changeset

- `test/integration/cookie-prefix.fuseki.test.mjs`: two app processes (prefixes `cn_`, `wie_`)
  on one throwaway Fuseki dataset; one cookie jar that ignores ports, as a browser does. Sign in
  to both, sign out of `cn_`: `cn_` is signed out, `wie_` still authenticates and refreshes.
- Readme: the variable, the static, when to set it, the client `define`.
- Sub-plan: A6 section, Progress entry, contract 2 row (CN `cn_`, webid.email `wie_` locally).
- Changeset (minor).

**Validation:** `npm test` and `npm run test:integration` pass.

**Dependencies:** phase 2 needs phase 1. No parallel work.

## Progress

| Phase | Result |
|---|---|
| 1 | Done. `npx linked build && npm test`: 517/517 (507 existing unchanged + 10 in `test/cookie-prefix.test.mjs`) |
| 2 | Done. `npm test` 517/517; `npm run test:integration` 42/42 (41 + the two-app test). A control run of the two-app test with both prefixes empty fails, as it should |
