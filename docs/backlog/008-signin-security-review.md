---
summary: >
  Findings of the security review over the WebID sign-in track (auth #119–#137), run in Create
  Now's wrap-up (X1 of its plan 065): a custom-scheme redirect lets an attacker who starts a native
  sign-in take the victim's account (medium); no issuer mix-up defence; discovery helpers default
  to an unguarded fetch; the development email-proof relaxation on a public dev server.
status: Open
---

# 008 — Security review of the WebID sign-in track

A read-only review of `b7ae16d..90a0f6b -- src` (the merged PRs #119, #121–#123, #127, #129, #131,
#133, #135, #137), from Create Now's report 088. No critical or high finding. Checked and sound:
the pending web sign-in (bound to the session, single use, 10 min), `state`/`nonce`/PKCE S256 and
`dpop_jkt`, the issuer check and its origin-root skip, `safeReturnTo`, the guarded fetch (connect-
time address check, mapped IPv6, redirects per hop, size and time caps), the A9 proof rule, the
sealed native record (AES-256-GCM, HKDF key, bound to redirect URI and state), codes (keyed hash,
single use, normalised rate-limit key), the cookie prefix character set, theme validation, and
OAuth linking.

## 1. Native sign-in with a custom-scheme redirect (medium)

`startNativeOidcSignin` (`src/backend.ts`, `nativeRedirectUri`) and the Client ID Document builder
(`src/utils/clientIdDocument.ts`) accept a custom-scheme redirect URI.

1. An attacker calls `startNativeOidcSignin` (curl, `x-linked-auth-transport: body`) with the
   victim's email and the app's custom scheme, and keeps `pending`.
2. The attacker sends the victim the returned `url`. The issuer shows the real app; with a consent
   already given the step is silent (see webid.email backlog 011 §1).
3. A malicious app on the victim's device that registered the same scheme receives `code` and
   `state` and passes them on.
4. `completeNativeOidcSignin({callbackUrl, pending})` succeeds for the attacker: state, redirect
   URI, PKCE verifier and DPoP key are all theirs. They hold the victim's session.

PKCE and DPoP protect only a flow the victim started; the readme (*Native apps*) says otherwise.
Claimed `https` links (Universal Links, verified App Links) are not exposed: without the app the
link opens in the browser. **Fix (small):** accept only `https:` redirect URIs for native sign-in,
or keep custom schemes behind an explicit opt-in with the readme naming the risk. Decide before
Peace Game lists a scheme ([006](006-native-oidc-device-run.md), open question).

## 2. No issuer mix-up defence (low)

`src/utils/oidcSignin.ts`: one callback URI for every issuer, and RFC 9207's `iss` parameter is
checked only when the issuer's metadata advertises it. An attacker issuer A (reached through a
domain's WebFinger) can forward the authorization request to an honest issuer H and receive H's
code with the `code_verifier` at its own token endpoint. No sign-in to the app results (the `iss`
checks hold); A gets an access token at H only if H does not enforce `dpop_jkt`. **Fix (medium):**
a callback URI per issuer (`/auth/oidc/callback/<hash(issuer)>`) checked in the callback; cheaper,
refuse a callback `iss` that differs from the pending issuer.

## 3. Discovery helpers default to an unguarded fetch (low)

`src/utils/issuerDiscovery.ts`: `fetch: options.fetch ?? globalThis.fetch`. Auth's own backend
always passes the guarded fetch; another consumer calling `fetchOidcIssuers` or
`createIssuerDiscovery` without one checks only IP literals, so a hostname resolving to a private
address passes. **Fix (small):** default to `createGuardedFetch({allowLocalhost})`.

## 4. The development email-proof relaxation (low, accepted)

With `NODE_ENV` `development` or `test`, any issuer's verified email counts (A9). On a server
reachable by others in that mode, an attacker's issuer can claim a victim's email, which is stored
verified on the attacker's account; the victim's later Google or code sign-in lands there. Unset,
`staging` and `production` are strict. Optional hardening: also require `allowLocalhost`.
