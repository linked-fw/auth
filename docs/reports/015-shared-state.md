---
summary: >
  Backlog 009 done: the 13 pieces of caller-set auth state, the two ProvideAuth contexts and the
  FatalConfigError class now survive a second copy of the package in one runtime. State lives on
  globalThis through core's sharedState, the contexts are cached there, FatalConfigError is
  branded for isLinkedError. A node test loads each built module twice and shows it.
---

# 015 — State a second copy of the package does not see

Replaces backlog 009 (found by the survey for linked-fw/cli backlog 017). Convention:
[shared state and error brands](https://github.com/linked-fw/cli/blob/main/docs/architecture/shared-state-and-error-brands.md)
and [linked-fw/cli report 020](https://github.com/linked-fw/cli/blob/main/docs/reports/020-shared-state-and-error-brands.md).

## Why

A module can be evaluated twice in one runtime: Vite's SSR module runner and Node under
`linked start`, or two browser bundles. A module-level `let` then exists twice. The app sets
`Auth.webIdFor` or `Auth.oidcSignin` on one copy and `backend.ts` reads the default on the other
(OIDC endpoints not served, wrong WebID); `ProvideAuth` from one copy is invisible to `useAuth` of
the other, which throws "must be used within a ProvideAuth component".

## What is shared

Every container is `sharedState('@_linked/auth', <name>, init)`, i.e.
`globalThis[Symbol.for('@_linked/auth:<name>')]`, created by the first copy that asks. Modules keep
their public API; only the storage moved.

| Container name | File | Fields | Was |
|---|---|---|---|
| `Auth` | `utils/auth.ts` | `userType`, `accountType`, `webIdFor`, `signinClient`, `oidcSignin` | public statics, now static getter/setter pairs |
| `cookieNames` | `utils/cookieNames.ts` | `configured`, `fromEnv` | module `let`s behind `Auth.cookiePrefix` / `setCookiePrefix` |
| `authClient` | `utils/authClient.ts` | `refreshHandler`, `inFlight`, `lastRefreshAtMs`, `accessToken`, `accessTokenExpiresAtMs`, `currentLeadMs`, `timer`, `listenersInstalled`, `retryInstalled` | module `let`s |
| `token` | `utils/token.ts` | `getTokenFn`, `setTokenFn`, `removeTokenFn`, `memoryAccessToken` | `_getTokenFn` etc., `memoryAccessToken` |
| `rateLimit` | `utils/rateLimit.ts` | `store`, `overrides` | module `let`s |
| `sessions` | `utils/sessions.ts` | `store`, `limits`, `inFlight` (Map of rotations under way) | module `let`s / `const` Map |
| `nativeOidcSignin` | `utils/nativeOidcSignin.ts` | `openSystemBrowser` | module `let` |
| `events` | `utils/events.ts` | `authEvents` (the `EventEmitter`) | module `const` |
| `contexts` | `hooks/useAuth.tsx` | `AuthContext`, `AuthLoadingContext` | module-level `createContext` |

Counted as in the backlog: 13 must-share entries (its table rows, with `Auth.cookiePrefix` and the
cookie module counted apart), 2 contexts, 1 branded error.

### Decisions

- **`currentLeadMs` is shared too.** The backlog did not list it, but it is the lead for the shared
  `accessTokenExpiresAtMs`; per copy, `accessTokenNeedsRefresh` would compare the shared expiry with
  a stale lead.
- **`retryInstalled` shared, so `@_linked/server-utils` is raised to `^1.13.0`.** With the flag
  shared, the second copy does not install the retry hook again. That is correct only when the hook
  lands in shared state too, which server-utils does from 1.13.0 (`LincdServerProxy`'s auth
  handler). With an older server-utils resolved per copy, the second proxy would get no handler.
- **`@_linked/core` raised to `^2.36.0`** for `sharedState` and `brandLinkedError`.
- **Store instances in the containers belong to the copy that created them**
  (`MemoryRateLimitStore`, `GraphRefreshSessionStore`). They only need to be callable from either
  copy, which they are; classes stay per copy as the convention says.
- **The contexts** follow the convention's §3: the context objects themselves live in shared state.
  This holds while both copies share one React (the CLI dedupes it).
- **`FatalConfigError`** is branded with `brandLinkedError(FatalConfigError, '@_linked/auth',
  'FatalConfigError')` in `utils/secrets.ts`. Nothing in auth tests it with `instanceof`;
  `@_linked/server` reads its `fatal: true` field, which works across copies already.

### Behaviour change

The `Auth.*` statics are accessors now. Assigning and reading them works as before, but
`mock.method(Auth, 'webIdFor', …)` (node:test) throws "must be a method": assign a function and
restore it instead. `test/oauth.test.mjs` was changed that way. Recorded in the changeset and the
readme.

## Left per copy

As the backlog decided: the session-cleanup throttle, the `oidcRuntime` memo, JWKS and dummy-hash
memos, the JWT verification cache, warn-once flags, and the stub-able `UsedNonceStore` /
`OAuthIdentityStore`.

## Tests

- **`test/two-copies.test.mjs`** (new, 12 tests). Imports each built module twice with a `?copy=`
  query (a distinct module instance to Node), asserts the copies are distinct, then that state
  written through one is read through the other: the `Auth` statics; the cookie prefix (set in code
  and read once from the environment); the client's token, expiry, single in-flight refresh and one
  timer cleared through the other copy; visibility listeners and the retry hook installed once;
  in-memory and native token storage; rate-limit store and limits counting through the other copy;
  session store and limits, and two simultaneous rotations of one token through both copies running
  one after the other; the native OIDC browser opener; both event kinds. A `renderToString` of
  `ProvideAuth` from copy a with a child using copy b's `useAuth` and `useAuthRenderLoading`. A
  `FatalConfigError` from copy a fails `instanceof` copy b but matches `isLinkedError`.
- Against a build of `main`'s sources the same file fails 12 of 12.
- `test/cookie-prefix.test.mjs`: the test that imports the cookie module from a `data:` URL (to
  simulate a bundler `define`) now points the module's `@_linked/core/utils/sharedState` import at
  the installed file, since a `data:` module cannot resolve a package name.
- Full suite: `npm test` 565/565; `npm run test:integration` against local Fuseki 48/48.

## Docs

- `readme.md`: "Two copies of the package in one runtime" under the overview.
- Changeset `.changeset/shared-state.md` (patch).
- No architecture doc in this repo covers module state; the convention doc lives in linked-fw/cli.
  Its "Where the packages stand" row for auth (`auth backlog 009`) can now say done.

## Review notes

An independent review of [#150](https://github.com/linked-fw/auth/pull/150) found no high or medium
issues, and confirmed every consumer (Create Now, webid.email, auth itself) only assigns the `Auth`
statics, so the accessors are safe. Known limits it recorded:

1. **The two-copy tests load auth twice, but core, server-utils and React once.** They do not prove
   that two server-utils copies share the retry handler; the `^1.13.0` floor relies on
   server-utils' own shared `proxyState` (and its own two-copy test).
2. **Shared defaults belong to the copy that evaluates first.** `GraphRefreshSessionStore`,
   `SchemaPerson` and `UserAccount` in the containers are that copy's instances and classes. This is
   safe while core keeps dispatch and the shape registries on `globalThis`.
3. **Two browser bundles with different `AUTH_COOKIE_PREFIX` defines share the first one's prefix.**
   Intended: one runtime, one set of cookie names.
4. **`installVisibilityRefresh` runs once per runtime.** Unmounting one copy's `ProvideAuth` removes
   the listeners for both, as two providers in one copy already did.
