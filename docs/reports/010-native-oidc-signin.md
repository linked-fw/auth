---
summary: >
  Solid-OIDC sign-in in native (Capacitor) apps, RFC 8252: startNativeOidcSignin opens the issuer
  in the system browser through the app's setOidcSigninBrowser, the server seals the pending
  sign-in for the device to hold in its token storage, and completeOidcSignin hands the app-claimed
  callback URL to completeNativeOidcSignin, which runs the web callback's checks and answers with
  the tokens in the body. Readme documents associated domains, asset links and the owner's values.
---

# 010 — Native OIDC sign-in

## Outcome

A native build of a Linked app can sign users in with their WebID. The app asks auth to start; the
issuer opens in the system browser (never a WebView) and returns through a link the app claims
(Universal Link, App Link or custom scheme) listed in its Client ID Document. The app hands that
URL to auth, which finishes the exchange on the server with the same checks as the web callback and
stores the session's tokens in the app's token storage. The web start and callback are unchanged.

Step A4 of [plan 001](../plans/001-webid-signin-track.md#a4--native-apps-capacitor), on A2's
exchange ([report 009](009-oidc-signin.md)). Design: arch-08 §Protocol, "Native apps (Capacitor)"
(in Create Now), RFC 8252.

## Public API

- **Server RPCs** (`'public'`; rate rules `oidcSignin` and `oidcCallback`; only for a caller that
  sends `x-linked-auth-transport: body`, else `not_native`):
  - `startNativeOidcSignin({input, redirectUri, prompt?, providerHint?})` → `{url, state, pending}`
    or `{error, action}`; `action` adds `invalid_redirect_uri` and `not_native` to the web start's.
  - `completeNativeOidcSignin({callbackUrl, pending})` → `{auth, accessToken, refreshToken, …,
    outcome}` or `{error, action, outcome?}`, `action` being the callback's error codes.
- **`@_linked/auth/utils/nativeOidcSignin`** (no React): `setOidcSigninBrowser(open)`,
  `startNativeOidcSignin(options)`, `completeOidcSignin(callbackUrl)`, `OIDC_PENDING_STORAGE_KEY`,
  and the types `OidcSigninBrowser`, `NativeOidcSigninWaiting`, `NativeOidcSigninError`.
- **`useAuth()`**: `startNativeOidcSignin` and `completeOidcSignin`, which also update the hook's
  state.
- **Types** (`types/auth`): `NativeOidcStartAnswer`, `NativeOidcSigninAnswer`.
- `createOidcRelyingParty`'s `begin` takes an optional `redirectUri`, kept in the pending record and
  used by `complete`.

## Files

| File | Responsibility |
|---|---|
| `src/helpers/oidcSealedPending.ts` | `sealPendingOidc` / `openPendingOidc`: AES-256-GCM under an HKDF key from `JWT_SECRET`, version prefix, 10-minute age, size cap |
| `src/utils/oidcSignin.ts` | per-sign-in `redirectUri` in `begin`, the pending record and `complete` |
| `src/backend.ts` | `completeOidcExchange` (shared by the web callback and the native completion), `signInVerifiedWebId` returns the tokens, `nativeRedirectUri`, `isCallbackFor`, the two RPCs and their declarations |
| `src/types/auth.ts` | the answers' types |
| `src/utils/nativeOidcSignin.ts` | the client: browser seam, device-held record, completion, token storage |
| `src/hooks/useAuth.tsx` | the two hook methods |
| `test/oidc-native.test.mjs`, `test/oidc-native-client.test.mjs` | new tests (below) |
| `test/exposure.test.mjs`, `test/integration/oidc.fuseki.test.mjs` | the surface; a native sign-in against a real dataset |
| `readme.md` | *Native apps (Capacitor)*: flow, browser recipes, `apple-app-site-association`, `assetlinks.json`, Client ID Document entries, the owner's values; RPC and rate-limit rows |
| `docs/plans/001-webid-signin-track.md` | contract 4: the native pair; A4 ticked |

## Decisions (tasks mode, within the plan)

1. **Two new RPCs; the web ones untouched**, so the parallel track holds.
2. **The device holds a sealed record.** The owner settled that the pending sign-in lives on the
   device. The server seals it, so the device cannot change the issuer the server will contact, the
   redirect URI or the age; the device still holds the verifier and the DPoP key.
3. **The redirect URI must be one of `Auth.signinClient.redirectUris`**, in its parsed form, never
   the web callback; the callback URL must match it (scheme, host, path) and carry the record's
   `state`, and it must still be configured when the sign-in completes.
4. **The system browser is a seam the app fills** (`setOidcSigninBrowser`), like
   `setAuthTokenStorageMethods`; auth pins no plugin. Both styles are supported: a plugin that
   resolves to the callback URL (`ASWebAuthenticationSession`) and a tab whose link arrives through
   `appUrlOpen` (Custom Tabs).
5. **The record lives in the registered token storage** (`oidcPending`, one at a time, 10 minutes),
   is checked against the link's `state` on the device before any call, and is used once.
6. **`onResult` is not called for native sign-ins**; the answer carries the outcome.

## Phases and validation

| Phase | What | Validation |
|---|---|---|
| 1 | Sealed pending, native start and completion, shared exchange | `node --test test/oidc-native.test.mjs` 17/17; `npm test` 499/499 |
| 2 | Client module and hook methods | `node --test test/oidc-native-client.test.mjs` 7/7; `npm test` 506/506 |
| 3 | Readme, contract note, changeset, integration case | `npm test` 506/506; `npm run test:integration` 41/41 |
| Review | `not_native` gate, doc and error fixes | `npm test` 507/507; `npm run test:integration` 41/41 |

## Review

1. **Medium: login CSRF through the native RPCs.** Any caller could complete a native sign-in,
   and the token delivery also sets cookies, so a web page could sign its visitor in to an account
   of its choosing with a record and code it obtained itself. Fixed: both methods answer
   `not_native` unless the request sends `x-linked-auth-transport: body`, which a cross-site page
   cannot send without CORS consent.
2. Lows fixed: `onResult`'s doc; a failed completion call is answered (`failed`), not thrown.
3. Lows left: `useAuth` stores the tokens twice (same values); a sealed record replayed within 10
   minutes reaches the token endpoint, where the code's single use refuses it.

## Tests

- `test/oidc-native.test.mjs`, 18 tests (provider over HTTP, mock issuer, synthetic callback URLs):
  - a Universal Link sign-in: URL parameters, tokens and refresh expiry in the body, person,
    account, outcome, `onResult` not called, the token request repeating the link;
  - a custom scheme; an existing person;
  - redirect URIs not listed, the web callback, with a query, absent, not in parsed form;
  - a flipped, foreign-key, wrong-issuer, expired, empty, malformed or oversized record;
  - a callback URL on another path or scheme, with another `state`, or not a URL;
  - a redirect URI removed after the start; a code from another sign-in; a replayed callback;
  - `login_required`; an issuer the profile does not name; a mismatch reported and refused;
  - not opted in; invalid input and an unreachable issuer; rate limits; the web start unchanged;
  - a caller without the native header (`not_native`, no cookie).
- `test/oidc-native-client.test.mjs`, 7 tests (the client against the provider, fake storage, a
  fake system browser): the authentication-session style and the Custom Tabs style; a forged link
  refused on the device with no call, the record kept and then used once; a new start replacing
  the old; a cancelled browser; an issuer error; no browser, no storage, an unlisted link.
- `test/integration/oidc.fuseki.test.mjs`: a native sign-in reaches the same account in a real
  dataset and its bearer token authenticates the next request.

## Verify (plan 001 §A4)

- Mock-issuer sign-in through the native path with synthetic callback URLs: done (above).
- iOS simulator and Android emulator through the system browser: **deferred to P1** (Peace Game's
  migration), with the plugin choice: backlog [006](../backlog/006-native-oidc-device-run.md).
- Bypass sign-in on 4040 and CN's `tests/e2e/signin.spec.ts` were not run against this branch: the
  localized checkout stays on `main`; Create Now runs them after the release.

## Follow-ups

- Device run and plugin choice: backlog [006](../backlog/006-native-oidc-device-run.md), for P1.
- Create Now's 065 §Contracts 4 needs the same native note as plan 001's contract 4.
