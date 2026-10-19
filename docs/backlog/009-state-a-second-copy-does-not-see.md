---
summary: >
  13 pieces of auth state that a second copy of the package does not see: the `Auth.*` statics and
  cookie prefix the app sets, the client token and refresh scheduler, native token storage, the
  rate-limit and session stores, the OIDC browser opener and the `authEvents` bus; plus the two
  React contexts and the unbranded `FatalConfigError`. Move them to core's `sharedState`.
packages: [auth]
---

# 009 — Auth state a second copy does not see

A module can be evaluated twice in one runtime (Vite's SSR runner and Node under `linked start`, or two browser bundles). The convention ([shared state and error brands](https://github.com/linked-fw/cli/blob/main/docs/architecture/shared-state-and-error-brands.md)) keeps caller-set module state on `globalThis` with `sharedState(pkg, name, init)` from `@_linked/core` 2.36.0, React contexts in that shared state, and brands error classes with `brandLinkedError` so consumers match them with `isLinkedError`. Each fix needs a test that loads a second copy of the module (`jest.isolateModulesAsync`, or a `?copy` query on the built file) and shows the state is shared.

Found by the survey for linked-fw/cli backlog 017. Paths under `src/`.

## Must be shared

| File | State | What breaks with two copies |
|---|---|---|
| `utils/auth.ts:32-58` | statics `Auth.userType`, `accountType`, `webIdFor`, `signinClient`, `oidcSignin` | The app sets them on one copy; `backend.ts` and sign-in on the other read defaults (OIDC endpoints not served, wrong WebID derivation). |
| `utils/auth.ts:73`, `utils/cookieNames.ts:24-25` | `Auth.cookiePrefix`, `configured`, `fromEnv` | Session middleware and cookie writers use different cookie names. |
| `utils/authClient.ts:55-68` | `refreshHandler`, `accessToken`, `accessTokenExpiresAtMs`, `inFlight`, `timer`, `lastRefreshAtMs`, `listenersInstalled` | Token and handler set on one copy are missing on the other; two refresh timers. |
| `utils/authClient.ts:313` | `retryInstalled` | Installs the retry hook on whichever server-utils copy it resolves. (server-utils' auth handler is shared since 1.13.0, so this mostly resolves itself once the flag is shared.) |
| `utils/token.ts:15-17` | `_setTokenFn`, `_getTokenFn`, `_removeTokenFn` | Native token storage registered on one copy; the other treats the client as web. |
| `utils/token.ts:136` | `memoryAccessToken` | Written on refresh, read on calls. |
| `utils/rateLimit.ts:189-190` | `store`, `overrides` | A configured store or limits are ignored; counters split. |
| `utils/sessions.ts:233,255` | `store`, `limits` | A custom session store or TTLs are ignored by the other copy. |
| `utils/sessions.ts:381` | `inFlight` Map | Two copies can rotate one refresh token twice and trip reuse detection. |
| `utils/nativeOidcSignin.ts:45` | `openSystemBrowser` | The app's browser opener is missing on the other copy. |
| `utils/events.ts:3` | `authEvents` EventEmitter | Listeners on one copy never fire for emits from the other (account-removal cleanup skipped). |

## React contexts

`hooks/useAuth.tsx:68,70` `AuthContext`, `AuthLoadingContext`: create them inside `sharedState`
so `ProvideAuth` from one copy is seen by `useAuth` from the other.

## Errors

Brand `FatalConfigError` (`utils/secrets.ts:19`), which hosts may catch. The `guardedFetch.ts`
errors are internal and already matched by `name`.

## Safe per copy (leave)

Session cleanup throttle, `oidcRuntime` memo, JWKS / dummy-hash memos, the JWT verification
cache, warn-once flags, the stub-able `UsedNonceStore` / `OAuthIdentityStore`.
