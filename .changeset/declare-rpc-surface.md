---
"@_linked/auth": minor
---

auth declares its whole RPC surface, so an app running `rpcExposure: 'enforce'` keeps sign-in working without declaring any of auth's methods itself.

- Callable `public`: `signinWithPassword`, `createAccount`, `signinOAuth`, `createOAuthNonce`, `signinTemporary`, `signinDev`, `sendResetPasswordLink`, `resetPassword`, `validateToken`, `signout`. Callable `user` (401 without a session): `linkOAuthIdentity`, `removeAccount`, `userHasAuthCredential`, `userHasPassword`.
- Now internal (never dispatched over HTTP): `hasAuthCredential`, `checkSignin`, `validateRequestToken`, `refreshSession`, `getTokenFromRequest`, `getTokenCandidates`, `getRefreshTokenFromRequest`, in addition to the methods already internal.
- The client wrapper `AuthCredential.hasAuthCredential(person)` is removed; it answered for any person. Use `AuthCredential.userHasAuthCredential()` or `userHasPassword()` for the signed-in user.
- The readme documents the surface, how subclasses inherit it, and that apps should wrap the store holding auth's shapes with `withAccess({read: 'none', write: 'none'})`.
