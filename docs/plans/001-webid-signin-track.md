---
summary: >
  A WebID sign-in track for @_linked/auth: any Linked app can sign users in through a Solid-OIDC
  issuer (webid.email by default, or the user's own), next to the existing password and
  Google/Apple/Facebook methods, which stay untouched. Configurable WebID derivation, issuer
  discovery, the redirect and callback on openid-client, the Client ID Document, the email-mismatch
  report, and native apps. Steps A0–A4 of Create Now's master plan 065.
status: In progress
---

# 001 — WebID sign-in track

**Design** (in the Create Now repo, `Semantu/create-now`):
[arch-08 §Sign-in](https://github.com/Semantu/create-now/blob/main/docs/architecture/08-identity-and-auth.md#sign-in)
(protocol, claims, issuer check, Client ID Document, native apps, mismatch handling) and
[plan 063](https://github.com/Semantu/create-now/blob/main/docs/plans/063-webid-signin-contract.md)
decisions 1–3, 5, 7 and 10.
**Tracked by** CN's [master plan 065](https://github.com/Semantu/create-now/blob/main/docs/plans/065-webid-signin-master-plan.md);
its Rules apply (worktrees, a changeset per PR, PRs ending in an Outcome section, never "Claude" in
commits or PRs). The issuer side is webid.email
([its plan](https://github.com/Semantu/webid-email/blob/main/docs/plans/001-webid-email-service.md)).

**A parallel track.** Every existing method — password, Google/Apple/Facebook OAuth, temporary,
dev sign-in (`signinDev`) — keeps its behaviour, exposure, cookies and sessions. All methods end in
the same step: verified identity → WebID (the Person's IRI) → `UserAccount` → session. An app opts
in by configuration; an app that doesn't sees no difference, so these are minor releases.

**Tests:** `npm test` (`node --test test/*.test.mjs`, runs against the built `lib/`, so build first
with `npx linked build`); `npm run test:integration` against throwaway Fuseki datasets. Consumers
(Create Now) verify after the release reaches them.

---

## A0 — Configurable WebID derivation and the shared HMAC function

**Depends on:** nothing.

**Scope**
- A configurable `webIdFor(email)`: where auth turns an email into a Person IRI today
  (`emailToWebID` in `src/utils/webID.ts`, UUID v5), it calls the configured function. **The default
  is today's derivation**, so existing apps keep their WebIDs.
- An exported HMAC derivation: `hmacWebId(email, {secret, issuer})` →
  `{issuer}/id/{h}#me`, `h` = first 128 bits of `HMAC-SHA256(secret, trim(lowercase(email)))` as 32
  hex characters. webid.email (production and dev) and CN's `bypass` mode use this one function.
- A published test vector (email + dev secret + issuer → WebID) that webid.email and CN reuse.

**Verify**
- Unit tests: default derivation unchanged (existing tests pass untouched); the HMAC function
  matches the test vector; normalisation (case, spaces).
- `npm test` and `npm run test:integration` pass.

---

## A1 — Issuer discovery

**Depends on:** nothing.

**Scope** (server-side module)
- **WebID → issuer:** fetch the WebID's profile (Turtle or JSON-LD), read `solid:oidcIssuer`.
- **Email → issuer:** WebFinger on the email's domain
  (`/.well-known/webfinger?resource=acct:{email}`); accept an issuer link
  (`http://openid.net/specs/connect/1.0/issuer`) or a WebID link
  (`http://www.w3.org/ns/solid/terms#webid`, then as above).
- **Fallback:** a configured default issuer (webid.email) when WebFinger gives no answer.
- A skip list of consumer domains that never answer (gmail.com, outlook.com, …), a short timeout,
  and a cache of results.

**Verify**
- Unit tests with fixtures (a local HTTP server): profile with an issuer; WebFinger issuer link;
  WebFinger WebID link; no answer → fallback; skipped domain → fallback without a request; timeout
  → fallback; cache hit.

---

## A2 — The redirect and callback

**Depends on:** A1. Tested against a mock issuer until webid.email's W3 exists, then against it.

**Scope** (on panva's `openid-client`)
- **Start:** a provider method that, for an email or WebID, discovers the issuer (A1) and returns
  the authorization URL: code flow with PKCE, a DPoP key, `state`, `nonce`, `login_hint`, optional
  `prompt=none` and a provider hint. The pending sign-in (verifier, nonce, DPoP key, hinted email,
  issuer) is kept server-side, keyed by `state`.
- **Callback route:** exchange the code with a DPoP proof; verify the ID token (signature via the
  issuer's JWKS, `iss`, `aud`, `exp`, `nonce`); require `webid` and `auth_time`.
- **Issuer check:** the token's `iss` must be listed as `solid:oidcIssuer` in the `webid`'s profile
  (skip the fetch when the WebID is on the issuer's origin).
- **Session:** find or create the Person (IRI = `webid`) and its `UserAccount`, store `email` when
  given, and create the session exactly as the other methods do. Discard the issuer's tokens.
- **Mismatch report:** compare the hinted email with the token's `email`; when they differ, the
  result tells the app (hinted, returned), and an app hook decides (sign in, ask, or offer a move).
  Any account lookup the hook needs runs inside the callback and is not an RPC method.
- **Configuration:** opt-in per app (default issuer, Client ID Document URL from A3, which claims
  are required); errors (`login_required`, a refused issuer check) returned to the app, not thrown.

**Verify**
- Integration test with a mock Solid-OIDC issuer (local, with JWKS and a profile): full sign-in
  creates the session; a wrong `nonce`, a wrong `aud`, an issuer not in the WebID's profile, and a
  missing `webid` are each refused.
- Mismatch: hint A, token B → reported to the hook.
- The existing methods' tests pass unchanged.

---

## A3 — The Client ID Document

**Depends on:** nothing (A2 uses its URL).

**Scope**
- Serve the app's Client ID Document at a fixed path under `SITE_ROOT` (e.g.
  `/.well-known/linked-client.jsonld`), built from configuration: `client_id` (the document's own
  URL), `client_name`, `logo_uri`, `redirect_uris` (the callback route, plus app-claimed links for
  native builds), `client_uri`, `policy_uri`, `tos_uri`, and the theme extension (layout, theme
  variables, brand, panel art URL) under its namespace.
- Validate the theme against the schema webid.email publishes (W4) at startup; log and drop invalid
  values.
- `Cache-Control` so issuers can cache it.

**Verify**
- `curl` returns valid JSON-LD with the configured values; an invalid theme value is dropped with a
  log line.
- webid.email's W3 test client accepts it (once W3 exists).

---

## A4 — Native apps (Capacitor)

**Depends on:** A2. Needed for Peace Game.

**Scope** (RFC 8252)
- In a native build, the start step opens the authorization URL in the system browser
  (`ASWebAuthenticationSession` on iOS, Custom Tabs on Android) through a Capacitor plugin, never a
  WebView.
- The issuer returns through an app-claimed link (Universal Link / App Link) or a custom scheme;
  the app passes the callback URL to auth, which completes the exchange (PKCE, DPoP key held by the
  app) and stores tokens with auth's existing native token storage.
- Documentation: the associated-domains / asset-links setup and the Client ID Document entries.

**Verify**
- A test app (or Peace Game's dev build) on an iOS simulator and an Android emulator signs in
  through the system browser and returns signed in.

---

## Progress

- [x] A0
- [ ] A1
- [ ] A2
- [ ] A3
- [ ] A4
