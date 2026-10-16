---
'@_linked/auth': minor
---

Solid-OIDC sign-in: a verified email from the app's default issuer (`Auth.oidcSignin.defaultIssuer`, webid.email unless set) now proves a WebID on that issuer's origin, so `emailProven` is true for webid.email users in production, where the app cannot derive their WebIDs. Any other issuer's email still proves its WebID only by derivation (`Auth.webIdFor`). With `NODE_ENV` `development` or `test`, any issuer's verified email counts (never in `production`, `staging` or with `NODE_ENV` unset), and a warning is logged.

One account per WebID: the Solid-OIDC callback, code sign-in and signup reuse an account another method made for the WebID without a person (dev sign-in keeps none) instead of creating a second one, and report it as not new. `Auth.login`'s `createAccount` may return `isNewAccount: false` for such a reused account.
