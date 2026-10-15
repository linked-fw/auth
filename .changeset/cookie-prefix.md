---
'@_linked/auth': minor
---

A configurable cookie-name prefix, `AUTH_COOKIE_PREFIX` (or `Auth.cookiePrefix`), applied to every
cookie auth sets and reads: `accessToken`, `refreshToken`, `linkedAuthSession` and the session
cookie `linked.auth`, on the server and in the client's session hint. Two Linked apps on one host
(browsers share cookies across ports) no longer sign each other out. Default empty: existing apps
keep today's cookie names.
