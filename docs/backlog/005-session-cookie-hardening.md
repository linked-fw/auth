---
summary: >
  The express-session cookie (`linked.auth`) has no `secure` or `sameSite` attribute and its store
  is plaintext SQLite under `data/`. Since A2 it also carries the browser binding of pending
  Solid-OIDC sign-ins (PKCE verifier, nonce, DPoP private key), so it deserves the same care as the
  token cookies.
status: Open
---

# 005 — Session cookie and store hardening

Recorded from the review of Solid-OIDC sign-in (report [009](../reports/009-oidc-signin.md),
PR [#127](https://github.com/linked-fw/auth/pull/127)). Pre-existing, not introduced there.

## What is there

`AuthBackendProvider.setupBeforeControllers` mounts `express-session` with `name: 'linked.auth'`,
`resave: true`, `saveUninitialized: false` and a `connect-sqlite3` store in
`<cwd>/data`. The cookie options are the defaults (`httpOnly`, path `/`, no `secure`, no
`sameSite`); a `TODO` says `secure` once broke production sessions (likely a proxy without
`trust proxy`).

Since A2, `startOidcSignin` stores pending sign-ins in this session, keyed by `state`, and the
callback completes only in the browser whose session holds the record: the login-CSRF defence
rests on this cookie. The records include the DPoP private key as a JWK, in plaintext rows until
they are used, expire, or are pruned by the next start.

## To decide

- `secure` (as the token cookies do it: `isSecureRequest` in `utils/cookies.ts`, honouring the
  proxy) and `sameSite: 'lax'` explicitly; `lax` still sends the cookie on the issuer's top-level
  redirect back.
- A `maxAge` or store TTL so abandoned sessions (and their pending records) go away.
- Whether pending sign-ins should move out of the generic session into a dedicated short-lived
  store (or an encrypted, httpOnly cookie of their own), so the session store holds no key material.
