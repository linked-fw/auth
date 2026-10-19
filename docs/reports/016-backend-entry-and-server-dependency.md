---
summary: >
  Packaging fixes, 3.15.1-3.15.5: the backend entry exports only the two provider classes (the
  constants beside them failed at boot, since @_linked/server constructs every export); the
  session cookie and sign-in code constants moved to utils/cookieNames and utils/signinCode;
  @_linked/server became a devDependency (^3.5.0, used by one test only); the session-gated
  provider methods are declared 'signed-in' instead of the deprecated 'user'.
---

# 016 — Backend entry exports, @_linked/server as a devDependency, 'signed-in' declarations

Four small PRs that change how the package is consumed, not what it does:
[#140](https://github.com/linked-fw/auth/pull/140) (3.15.1),
[#142](https://github.com/linked-fw/auth/pull/142) (3.15.2),
[#144](https://github.com/linked-fw/auth/pull/144) (3.15.3) and
[#149](https://github.com/linked-fw/auth/pull/149) (3.15.5).

## 1. The backend entry exports only provider classes (3.15.1, #140)

**Why.** `@_linked/server` (before 2.24.9, linked-fw/server#171) calls `new` on every export of a
package's backend entry. `src/backend.ts` also exported `SESSION_COOKIE_NAME`,
`sessionCookieName` and `INVALID_SIGNIN_CODE_MESSAGE`, so every app that installed auth logged at
boot:

```
[linked] @_linked/auth INVALID_SIGNIN_CODE_MESSAGE constructor failed: providerClass is not a constructor
[linked] @_linked/auth SESSION_COOKIE_NAME constructor failed: providerClass is not a constructor
```

**API change (breaking for direct importers, released as a patch: no consumer imported them).**
`@_linked/auth/backend` exports `AuthBackendProvider` (default) and `AuthCredentialProvider`, and
nothing else. The constants moved:

```ts
import { SESSION_COOKIE_NAME, sessionCookieName } from '@_linked/auth/utils/cookieNames';
import { INVALID_SIGNIN_CODE_MESSAGE } from '@_linked/auth/utils/signinCode';
```

**Rule for this repo:** anything other than a provider class goes in a `utils/` module, never in
`src/backend.ts`'s exports. Apps on `@_linked/server` 2.24.9 or later skip non-class exports
anyway, but the entry stays class-only.

**Files.**
- `src/backend.ts` imports the constants instead of defining them.
- `src/utils/cookieNames.ts` holds `SESSION_COOKIE_NAME` and `sessionCookieName` next to
  `authCookieName`.
- `src/utils/signinCode.ts` (new) holds `INVALID_SIGNIN_CODE_MESSAGE`.
- `test/session-cookie.test.mjs`: new test that every export of `lib/esm/backend.js` is a class.
  `test/cookie-prefix.test.mjs`, `test/signin-code.test.mjs` and
  `test/integration/signin-code.fuseki.test.mjs` import from the new paths.

Verification at merge: `npm test` 553/553, `npm run test:integration` 48/48.

## 2. `@_linked/server` is a devDependency (3.15.2 and 3.15.3, #142, #144)

**Why.** `@_linked/server` was a runtime dependency (`^2.0`), but nothing in `src/` imports it;
only `test/exposure.test.mjs` does (`rpcExposure`, `LinkedServer`). As a dependency it would have
installed a nested 2.x copy in every app once `@_linked/server` 3.0 shipped. Dropping it entirely
was the plan; it moved to `devDependencies` because the exposure test needs it.

- 3.15.2 (#142): moved to `devDependencies` with the range unchanged; lockfile reflagged only.
- 3.15.3 (#144): range `^2.0` to `^3.0.0`, because a workspace on `@_linked/server@3` (Create
  Now) failed `npm install` with ERESOLVE on the dev range. Auth uses neither `BackendAPIStore`
  nor `GatewayStore` (the 3.0 breaking changes), so no source changed.
- 3.15.5 (#149, below) raised it to `^3.5.0`.

The consumer-side check (`npm ls @_linked/server` shows one copy) is recorded in Create Now's
plan 068, step R2.

## 3. Session-gated methods are declared `'signed-in'` (3.15.5, #149)

`'user'` is a deprecated alias of `'signed-in'` since `@_linked/server-utils` 1.14.0. Six
declarations changed, no behaviour change:

- `declareCallable(AuthBackendProvider, …)`: `linkOAuthIdentity`, `resendEmailVerification`,
  `getReauthenticationMethods`, `removeAccount`.
- `declareCallable(AuthCredentialProvider, …)`: `userHasAuthCredential`, `userHasPassword`.

Ranges: `@_linked/server-utils` `^1.14.0`; dev `@_linked/server` `^3.5.0`, because the exposure
test runs the server's own `assertSessionForLevel`, which answers 401 for `'signed-in'` from 3.5.0.
An app on an older server still reaches each method's own session check.

**Files.** `src/backend.ts` and `src/shapes/AuthCredentialProvider.ts` (declarations and the
surface comment), `test/exposure.test.mjs` (`SURFACE` table, 44 checks), `readme.md` (the
subclassing example). Older reports keep the level they recorded at the time.

## Known limits

None open. The class-only rule for the backend entry is a convention; the test in
`test/session-cookie.test.mjs` enforces it for the built entry.

## Follow-ups

None.
