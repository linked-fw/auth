---
'@_linked/auth': patch
---

The backend entry (`@_linked/auth/backend`) now exports only `AuthBackendProvider` and `AuthCredentialProvider`. `@_linked/server` constructs every export of a backend entry, so the constants exported next to them failed at boot with `INVALID_SIGNIN_CODE_MESSAGE constructor failed: providerClass is not a constructor` (and the same for `SESSION_COOKIE_NAME`). They moved:

- `SESSION_COOKIE_NAME` and `sessionCookieName` → `@_linked/auth/utils/cookieNames`
- `INVALID_SIGNIN_CODE_MESSAGE` → `@_linked/auth/utils/signinCode`

Importing them from `@_linked/auth/backend` no longer works; import them from the new paths.
