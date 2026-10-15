---
summary: >
  Step A4 of the WebID sign-in track: Solid-OIDC sign-in in native (Capacitor) builds. The app opens
  the authorization URL in the system browser, holds the pending sign-in on the device (sealed by
  the server), and hands the app-claimed callback URL to completeOidcSignin, which finishes the
  exchange on the server and stores tokens in the app's registered token storage.
status: Implementation
---

# 007 — Native OIDC sign-in (A4)

**Plan:** [001 §A4](001-webid-signin-track.md#a4--native-apps-capacitor), its Contracts 3 and 4,
A2's report [009](../reports/009-oidc-signin.md), arch-08 §Protocol "Native apps (Capacitor)" (in
Create Now) and RFC 8252. Ideation and plan are done; this doc starts at tasks.

## Scope (settled with the owner)

- In a native build the start step opens the authorization URL in the **system browser** through a
  Capacitor plugin, never a WebView.
- The pending sign-in (PKCE verifier, nonce, DPoP key, hinted email, issuer) is **held on the
  device**, not in express-session: the system browser shares no cookie with the app.
- The issuer returns through an app-claimed link (Universal Link / App Link) or a custom scheme
  listed in the Client ID Document; the app hands that URL to `completeOidcSignin(callbackUrl)`,
  which finishes the exchange and stores tokens with auth's native token storage.
- Documentation of associated domains (`apple-app-site-association`), `assetlinks.json` and the
  Client ID Document entries, naming each value the app owner supplies.
- Verify against A2's mock issuer with a synthetic callback URL. The simulator/emulator run is
  deferred to Peace Game's migration (P1).

## Decisions (tasks mode, within the plan)

1. **Two new RPC methods, the web ones untouched.** `startNativeOidcSignin({input, redirectUri,
   prompt?, providerHint?})` → `{url, state, pending}`; `completeNativeOidcSignin({callbackUrl,
   pending})` → the usual authentication response plus `outcome`, or `{error, action, outcome}`.
   Both `'public'`, rate rules `oidcSignin` and `oidcCallback` as on the web. `startOidcSignin`
   and `GET /auth/oidc/callback` do not change (parallel track).
2. **The device holds a sealed record.** The server seals the pending sign-in (plus the redirect
   URI) with AES-256-GCM under a key derived (HKDF-SHA256) from `JWT_SECRET` with its own label,
   and the device stores the opaque string. Opening checks integrity and the 10-minute age, so a
   device cannot change the issuer the server will fetch, the redirect URI or the expiry. The
   device holds the verifier and the DPoP key as the plan says; sealing only stops tampering.
3. **The redirect URI is one of the app-claimed links** in `Auth.signinClient.redirectUris`
   (the extras of the Client ID Document, A3), never the web callback. The relying party takes a
   per-sign-in `redirectUri` (begin option, kept in the pending record) instead of one per runtime.
   The callback URL the app hands in must have that redirect URI's scheme, host and path; only its
   query is used.
4. **The system browser is a seam the app fills** (`setOidcSigninBrowser(open)`), like
   `setAuthTokenStorageMethods`: auth does not pin a plugin. `open(url, {redirectUri})` resolves to
   the callback URL (ASWebAuthenticationSession style) or to nothing, when the link arrives later
   through the app's `appUrlOpen` listener (Custom Tabs). The readme gives both recipes; the plugin
   is chosen and run on devices in P1.
5. **Device storage is the registered token storage**, key `oidcPending`, one sign-in at a time
   (a new start replaces the old), expiring with the record. `completeOidcSignin` reads `state` from
   the callback URL, refuses a URL whose `state` is not the stored one without calling the server
   (login CSRF), and removes the record before the call (single use on the device).
6. **Shared completion.** The callback route and the native completion share one function (complete
   → mismatch hook → `signInVerifiedWebId`), so the email rule (`emailProven`) and the mismatch
   hook are the same. `onResult` is a redirect hook and is not called for native sign-ins; the app
   reads `outcome` from the answer.

## Contracts touched

- Contract 3: the Client ID Document's `redirect_uris` carries the app-claimed links (already
  supported by A3); no change to the document's shape.
- Contract 4: unchanged checks; adds the native start/complete pair. Recorded in plan 001.

## Phases

### Phase 1 — Server: sealed pending, native start and completion

Tasks
- `src/helpers/oidcSealedPending.ts`: `sealPendingOidc(record, secret)`, `openPendingOidc(sealed,
  secret, now)` (AES-256-GCM, HKDF key, base64url, version prefix; `undefined` on any failure or
  past the TTL).
- `src/utils/oidcSignin.ts`: `begin` takes an optional `redirectUri`, kept in `PendingOidcSignin`;
  `complete` uses the pending record's redirect URI; discovery's client metadata lists only what
  the issuer needs.
- `src/backend.ts`: extract `completeOidcExchange(provider, runtime, config, pending, query)`; the
  callback route uses it; `signInVerifiedWebId` returns the authentication result.
  `startNativeOidcSignin` and `completeNativeOidcSignin`; `declareCallable` both `'public'`.
- Tests: `test/oidc-native.test.mjs` (provider over `serving`, the mock issuer, a synthetic
  callback URL), `test/exposure.test.mjs` surface.

Validation: `npx linked build && node --test test/oidc-native.test.mjs test/oidc-callback.test.mjs
test/exposure.test.mjs` passes; the native test covers a full sign-in with tokens in the body, a
custom-scheme redirect, a redirect URI not listed, a tampered/expired sealed record, a callback URL
for another redirect URI, `login_required`, mismatch refused, and the web callback unaffected.

**Done.** `node --test test/oidc-native.test.mjs`: 17/17; `npm test`: 499/499 (480 before, plus
the 17 native tests and the two new methods in the exposure surface).

### Phase 2 — Client: system browser seam, device-held pending, completion

Tasks
- `src/utils/nativeOidcSignin.ts` (no React): `setOidcSigninBrowser`, `startNativeOidcSignin`,
  `completeOidcSignin(callbackUrl)`; stores the record with the registered storage; stores tokens
  with `storeAuthTokens`.
- `src/hooks/useAuth.tsx`: `startNativeOidcSignin` and `completeOidcSignin` that update the auth
  state on success.
- Tests: `test/oidc-native-client.test.mjs` — the client module against the provider in process
  (`Server.call` routed to it), fake storage and a fake browser that plays the mock issuer: both
  browser styles, a foreign `state`, no stored record, no storage registered, no browser.

Validation: `npx linked build && node --test test/oidc-native-client.test.mjs` passes; full
`npm test` passes.

**Done.** `node --test test/oidc-native-client.test.mjs`: 7/7; `npm test`: 506/506.

### Phase 3 — Documentation, contracts, changeset

Tasks
- `readme.md`: "Native apps (Capacitor)" under the Solid-OIDC section: the flow, the two browser
  recipes, `apple-app-site-association`, `assetlinks.json`, the Client ID Document entries and the
  values the app owner supplies; RPC table and rate-limit rows.
- Plan 001: contract 4 note on the native pair; A4 ticked at wrap-up.
- `.changeset/native-oidc-signin.md` (minor).

Validation: `npx linked build && npm test`; `npm run test:integration` when the Fuseki variables
are set; readme examples match the exported names (grep).

**Done.** Readme section, RPC and rate-limit rows, plan 001 contract 4 note, changeset; a native
case added to `test/integration/oidc.fuseki.test.mjs`. `npm test`: 506/506;
`npm run test:integration`: 41/41.

## Dependencies and parallel work

Phase 2 needs phase 1's RPC methods; phase 3 documents both. Sequential, one commit per phase.

## Verify (from plan 001 §A4)

- [ ] Mock-issuer sign-in through the native path with a synthetic callback URL (phases 1–2).
- [ ] Simulator (iOS) and emulator (Android) sign-in through the system browser — **deferred to
  P1** (Peace Game's migration), which picks the plugin and runs it on devices.
