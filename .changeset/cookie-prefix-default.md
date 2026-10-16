---
'@_linked/auth': minor
---

The cookie-name prefix now defaults to the app's own `APP_PREFIX`, so several Linked apps on one host keep separate sessions without configuring anything. When neither `Auth.cookiePrefix` nor `AUTH_COOKIE_PREFIX` is set (an empty `AUTH_COOKIE_PREFIX` counts as unset), the prefix is `APP_PREFIX` made a safe cookie-name token plus `_` (`webid-email` → `webid-email_accessToken`, `webid-email_refreshToken`, `webid-email_linkedAuthSession`, `webid-email_linked.auth`); without `APP_PREFIX` the names stay as they were. The client resolves it the same way from `process.env.AUTH_COOKIE_PREFIX` and `process.env.APP_PREFIX`; `resolveCookiePrefix(process.env)` (`@_linked/auth/utils/cookieNames`) gives a Vite config the resolved prefix to `define`.

**Upgrade note:** an app that has `APP_PREFIX` set and no `AUTH_COOKIE_PREFIX` gets new cookie names on upgrade, which signs its users out once. To keep the old names, set `Auth.cookiePrefix = ''`, or set `AUTH_COOKIE_PREFIX` to the prefix you used before. Such an app's browser bundle must get the same prefix: define `process.env.AUTH_COOKIE_PREFIX` as `resolveCookiePrefix(process.env)` (or define `process.env.APP_PREFIX`) in `createViteConfig({define})`; otherwise the client looks for the unprefixed session hint, and a page load that was not server-rendered as signed in shows the user signed out.
