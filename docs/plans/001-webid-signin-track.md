---
summary: >
  A WebID sign-in track for @_linked/auth: any Linked app can sign users in through a Solid-OIDC
  issuer (webid.email by default, or the user's own), next to the existing password and
  Google/Apple/Facebook methods, which stay untouched. Configurable WebID derivation, issuer
  discovery, the redirect and callback on openid-client, the Client ID Document (with the sign-in
  theme schema), a passwordless sign-in by emailed code, the email-mismatch report, and native
  apps. Steps A0–A5 of Create Now's master plan 065, with the contracts the other repos depend on.
status: In progress
---

# 001 — WebID sign-in track

**Design** (in the Create Now repo, `Semantu/create-now`):
[arch-08 §Sign-in](https://github.com/Semantu/create-now/blob/main/docs/architecture/08-identity-and-auth.md#sign-in)
(protocol, claims, issuer check, Client ID Document, native apps, mismatch handling),
[arch-08 §WebID derivation](https://github.com/Semantu/create-now/blob/main/docs/architecture/08-identity-and-auth.md#webid-derivation)
and [§Dev-mode identity](https://github.com/Semantu/create-now/blob/main/docs/architecture/08-identity-and-auth.md#dev-mode-identity)
(the HMAC rule and the shared dev derivation), and
[plan 063](https://github.com/Semantu/create-now/blob/main/docs/plans/063-webid-signin-contract.md)
decisions 1–7, 9 and 10.
**Tracked by** CN's [master plan 065](https://github.com/Semantu/create-now/blob/main/docs/plans/065-webid-signin-master-plan.md);
its Rules apply (worktrees, a changeset per PR, PRs ending in an Outcome section, never "Claude" in
commits or PRs), and its §Contracts is the cross-repo source of the [Contracts](#contracts) below.
Each step agent works in its own plan doc (numbers assigned by 065: A0 → `002`, A1 → `003`,
A3 → `004`, A5 → `005`; A2 and A4 get theirs when they start). The issuer side is webid.email
([its plan](https://github.com/Semantu/webid-email/blob/main/docs/plans/001-webid-email-service.md)).

**The steps.** A0 makes the email → WebID derivation configurable and exports the HMAC rule
(unblocks webid.email's minting and CN's dev mode). A1 finds a user's issuer (WebID profile,
WebFinger, fallback). A2 is the Solid-OIDC exchange itself, on `openid-client`. A3 serves the
app's Client ID Document and defines its theme extension. A5 adds a passwordless sign-in by
emailed code, which webid.email's pages use. A4 makes the exchange work in native (Capacitor)
builds. A0, A1, A3 and A5 depend on nothing and run in parallel; A2 needs A1; A4 needs A2.

**A parallel track.** Every existing method — password, Google/Apple/Facebook OAuth, temporary,
dev sign-in (`signinDev`) — keeps its behaviour, exposure, cookies and sessions. All methods end in
the same step: verified identity → WebID (the Person's IRI) → `UserAccount` → session. An app opts
in by configuration; an app that doesn't sees no difference, so these are minor releases.

**Tests:** `npm test` (`node --test test/*.test.mjs`, runs against the built `lib/`, so build first
with `npx linked build`); `npm run test:integration` (`node --test test/integration/*.test.mjs`)
against throwaway Fuseki datasets, and it throws unless `AUTH_TEST_FUSEKI_URL`,
`AUTH_TEST_FUSEKI_USER` and `AUTH_TEST_FUSEKI_PASSWORD` are set. Consumers (Create Now) verify
after the release reaches them.

---

## Contracts

What this repo provides to, or must know from, the other repos. Copied from
[065 §Contracts](https://github.com/Semantu/create-now/blob/main/docs/plans/065-webid-signin-master-plan.md#contracts),
which is the cross-repo copy: a step that changes one of these updates both in the same PR and
says so in its Outcome. A step reads the contracts it touches before its own section.

### 1. WebID derivation (A0 → webid.email W2, CN C2a)

- `@_linked/auth` gains a configurable derivation, `Auth.webIdFor: (email: string) => string`, a
  static on `Auth` (`src/utils/auth.ts`) like `Auth.userType`; auth has no config object. Default:
  today's `emailToWebID` (UUID v5 under `https://webid.email/id/`, no `#me`), so existing apps
  keep their WebIDs. Every call site in auth goes through it, `markOAuthEmailVerified` included
  (it compares a derived WebID with the Person IRI). CN's own two call sites (`/auth/dev`,
  `/auth/derive-webid`) switch in C2a.
- Exported from `@_linked/auth/utils/webID` (the root has no named exports): `hmacWebIdFor({secret, issuer}): (email) => string` and the
  plain function `hmacWebId(email, {secret, issuer})`. Normalisation: `trim(lowercase(email))`.
  Result: `{issuer}/id/{h}#me`, `h` = first 128 bits of `HMAC-SHA256(secret, normalised)` as 32
  lowercase hex characters. `issuer` carries no trailing slash.
- Exported from the same module, the test vector `HMAC_WEBID_TEST_VECTOR = {email, secret, issuer, webId}` with
  `secret = 'local-dev-webid-secret'`, `issuer = 'http://localhost:4050'` and an email with mixed
  case and surrounding spaces. W2 and C2a assert against it.
- The dev secret value above is the one CN's `DEV_WEBID_SECRET` and webid.email's `WEBID_SECRET`
  hold locally. *Open:* whether it is committed in both `.env.example` files (like
  `.github-app-test.pem`) or only documented.

Where "backend config" and "package root" land in this codebase is in A0's
[Pitfalls](#a0-pitfalls): the package has no config object and no root named exports today.

### 2. Environment variables this repo must know (CN C0/C2a, webid.email W2)

Set by the consumers, never read by this package directly; they feed `hmacWebIdFor`:

| Where | Variable | Values |
|---|---|---|
| CN | `DEV_WEBID_SECRET` | the dev secret; commented "must equal the local webid.email's `WEBID_SECRET`" |
| CN | `DEV_WEBID_ISSUER` | `http://localhost:4050` |
| webid.email | `WEBID_SECRET` | the HMAC secret; the same name in production and locally, where it holds the dev value |
| webid.email | issuer URL | `SITE_ROOT` (`http://localhost:4050` locally, `https://webid.email` in production); no separate variable |

CN's `WEBID_MODE` (`bypass` · `local` · `production`; `DEV_AUTH=true` maps to `bypass` and is
deprecated) is CN's own and not read here. Note that this package's dev-only behaviour
(`signinDev`, links to the server log) is gated on `DEV_AUTH` today; see A5's
[Pitfalls](#a5-pitfalls).

### 3. Client ID Document and theme (A3 → webid.email W3, W4, CN C3)

- Path: `{SITE_ROOT}/.well-known/linked-client.jsonld`; `client_id` is that URL. Callback:
  `{SITE_ROOT}/auth/oidc/callback`. `http://` only for `localhost`.
- The theme extension is **defined once in `@_linked/auth`** (A3): TypeScript types, a JSON Schema,
  and `validateClientTheme(doc)` that drops invalid values and reports them. webid.email imports
  the same definition (W4); nothing is served as a schema. The extension sits under one key in the
  document, `https://linked.cm/ns/signin#theme`, and other issuers ignore it.
- Fields: `layout` (`card` | `two-column`), `colors` (`primary`, `accent`, `background`, `panel`,
  `text`; CSS colour values, no `url(`), `font` (from an allow-list A3 defines), `scheme`
  (`light` | `dark`), `brand` (`name`, `logoUri`), `panelArt` (URL of an image or animated SVG;
  rendered as `<img>`; limits enforced by webid.email: ~50 KB compressed SVG, ~150 KB image).
- `Cache-Control` on the document; webid.email caches per it and keeps a short dev-client list.

### 4. The sign-in exchange (A2 ↔ webid.email W3)

- Authorization code + PKCE, DPoP proof on the token request. Request parameters: `login_hint`
  (email), `prompt=none` for silent sign-in, and the provider hint `provider_hint=google` (not
  standard; other issuers ignore it).
- ID token claims: `iss`, `aud`, `exp`, `iat`, `nonce`, `webid` (required), `auth_time`
  (required); `email`, `email_verified` (webid.email always; others optional).
- The relying party checks that `iss` is a `solid:oidcIssuer` of `webid`'s profile, skipping the
  fetch when `webid` is on the issuer's origin. `login_required` and a refused issuer check are
  returned to the app, not thrown.
- A2 tests against a **mock issuer in auth's test directory** (discovery, JWKS, token endpoint,
  a profile document); W3 tests with `openid-client` against a test Client ID Document. Neither is
  a shared artifact; C1 is the first test across the two real processes.

### 5. Emailed sign-in code (A5 → webid.email W4)

- A generic passwordless method in `@_linked/auth` next to password: `sendSigninCode(email)` emails
  a short code and a link carrying it (single use, short expiry, rate-limited like reset links);
  `signinWithCode(email, code)` verifies the email and ends in the normal session step. With no
  email provider, the code goes to the server log, as reset links do today.
- webid.email's sign-in pages (W4) and CN's `local`-mode test (C1) read the code from that log.

---

## A0 — Configurable WebID derivation and the shared HMAC function

**Depends on:** nothing. **Plan doc:** `docs/plans/002-…`. **Size:** small, 1–2 phases.

**Scope**
- A configurable `webIdFor(email)`: where auth turns an email into a Person IRI today
  (`emailToWebID` in `src/utils/webID.ts`, UUID v5), it calls the configured function. **The default
  is today's derivation**, so existing apps keep their WebIDs.
- An exported HMAC derivation: `hmacWebId(email, {secret, issuer})` →
  `{issuer}/id/{h}#me`, `h` = first 128 bits of `HMAC-SHA256(secret, trim(lowercase(email)))` as 32
  hex characters, and its factory `hmacWebIdFor({secret, issuer})`. webid.email (production and
  dev) and CN's `bypass` mode use this one function.
- A published test vector (email + dev secret + issuer → WebID) that webid.email and CN reuse
  ([contract 1](#1-webid-derivation-a0--webidemail-w2-cn-c2a)).

**Files**
- `src/utils/webID.ts`: `emailToWebID` (UUID v5 under `WEBID_EMAIL_NAMESPACE`) and
  `telephoneToWebID` live here; the HMAC function, the factory, the test vector and the
  configuration seam go next to them. `uuid` is already a dependency; HMAC needs only `node:crypto`.
- `src/backend.ts` calls `emailToWebID` in five places, all of which must go through the configured
  function: `markOAuthEmailVerified` (compares `emailToWebID(email) !== personId` before marking an
  OAuth email verified), `signinWithPassword`, `createAccount`, `sendResetPasswordLink` and
  `signinOAuth`. There are no other callers in `src/`.
- `src/index.ts` is the package root: side-effect imports only (`./types.js`, the ontology, shapes,
  then the React components); it exports nothing by name, and `lib/esm/index.d.ts` confirms it.
- Configuration today: `AuthBackendProvider.setupBeforeControllers` reads the environment
  (`assignEnvPathToField('AUTH_ACCOUNT_TYPE', 'accountShape')`, `AUTH_USER_TYPE`) and copies the
  shapes onto the static `Auth` class (`Auth.userType`, `Auth.accountType` in `src/utils/auth.ts`).
  `BackendProvider`'s constructor is `(server, lincdServer)`; there is no config object.
- Docs: `readme.md` has the environment table (`SITE_ROOT` at line ~138) and a section on the
  emails; add the derivation and its configuration there.

<a id="a0-pitfalls"></a>**Pitfalls**
- **"Backend config" does not exist as an object.** The seam has to be one the package already
  uses: a static on `Auth` next to `userType`/`accountType`, or a setter in `utils/webID.ts`,
  settable before `setupBeforeControllers` runs. Which one is a tasks-mode choice; it is not a
  redesign as long as the default is `emailToWebID` and every call site in `backend.ts` uses it.
- **"Exported from the package root" contradicts the code.** The root has no named exports and
  importing it pulls the React components in; consumers import subpaths (CN imports
  `@_linked/auth/utils/webID`, allowed by the `./*` exports map). Export from
  `src/utils/webID.ts` (subpath `@_linked/auth/utils/webID`) and say so in the Outcome; adding root
  re-exports would change what importing the root means. Reported to the master plan.
- **CN does not subclass this provider.** `CreateNowBackendProvider extends BackendProvider` and
  calls `emailToWebID` itself (its `/auth/dev` and `/auth/derive-webid` routes). A0 changes nothing
  there; C2a switches CN to `hmacWebIdFor`. Keep `emailToWebID` exported and unchanged.
- `markOAuthEmailVerified` silently stops marking emails verified if it keeps calling
  `emailToWebID` while the app has configured another derivation: it must use the configured one.
- Tests run against `lib/`: build before every test run, or a green run proves nothing.
- The `.changeset` entry is a `minor` (new exports, no behaviour change by default).

**Architecture.** [arch-08 §WebID derivation](https://github.com/Semantu/create-now/blob/main/docs/architecture/08-identity-and-auth.md#webid-derivation)
(the rule, `#me`, why a keyed hash), [§Dev-mode identity](https://github.com/Semantu/create-now/blob/main/docs/architecture/08-identity-and-auth.md#dev-mode-identity)
(`bypass` and `local` must give an email the same WebID through this one function), [§webid.email
service](https://github.com/Semantu/create-now/blob/main/docs/architecture/08-identity-and-auth.md#webidemail-service)
("`@_linked/auth` gains a configurable `webIdFor(email)`; its default stays today's derivation"),
063 decision 6. Parallel track: no existing method changes behaviour; the only visible change for an
app that configures nothing is none.

**Tests**
- Quick gate: `npx linked build && node --test test/webid.test.mjs` (new file; default derivation
  unchanged with the existing expectations, HMAC matches `HMAC_WEBID_TEST_VECTOR`, normalisation of
  case and spaces, `issuer` with a trailing slash refused or trimmed as the contract says, the
  configured function is the one `backend.ts` calls).
- Full gate: `npx linked build && npm test`; `npm run test:integration` with the
  `AUTH_TEST_FUSEKI_*` variables set.

**Verify**
- Unit tests: default derivation unchanged (existing tests pass untouched); the HMAC function
  matches the test vector; normalisation (case, spaces).
- `npm test` and `npm run test:integration` pass.

---

## A1 — Issuer discovery

**Depends on:** nothing. **Plan doc:** `docs/plans/003-…`. **Size:** medium, ~3 phases.

**Scope** (server-side module)
- **WebID → issuer:** fetch the WebID's profile (Turtle or JSON-LD), read `solid:oidcIssuer`.
- **Email → issuer:** WebFinger on the email's domain
  (`/.well-known/webfinger?resource=acct:{email}`); accept an issuer link
  (`http://openid.net/specs/connect/1.0/issuer`) or a WebID link
  (`http://www.w3.org/ns/solid/terms#webid`, then as above).
- **Fallback:** a configured default issuer (webid.email) when WebFinger gives no answer.
- A skip list of consumer domains that never answer (gmail.com, outlook.com, …), a short timeout,
  and a cache of results.

**Files**
- A new server-side module under `src/utils/` (where the other server-only modules live:
  `sessions.ts`, `oauthNonce.ts`, `rateLimit.ts`, `jwt.ts`), e.g. `src/utils/issuerDiscovery.ts`,
  imported by subpath (`@_linked/auth/utils/issuerDiscovery`). It is not imported from
  `src/index.ts` and not from `backend.ts` yet; A2 is its first caller.
- Nothing in `backend.ts` changes. No new runtime dependency is needed: Node 24 (`@types/node` 24)
  has global `fetch` and `AbortSignal.timeout`; parsing the profile needs a small Turtle/JSON-LD
  reader for one predicate, and whether `@_linked/core` already provides one is the first thing to
  check before adding a parser.
- Tests: `test/issuer-discovery.test.mjs` with a local `http` server as the fixture (the repo
  already has `express` as a dev dependency; `node:http` is enough).

**Pitfalls**
- The profile and WebFinger fetches reach arbitrary hosts named by user input: only `https://`
  (and `http://localhost` for dev), no redirects to other schemes, a response size cap, and the
  timeout on every request, so a typed WebID cannot be used to probe the server's network.
- A cache entry for "no answer" must expire like a positive one, or a domain that adds WebFinger
  later stays on the fallback until restart.
- The skip list is a short-circuit, not a security boundary: a skipped domain still gets the
  fallback issuer with `login_hint`.
- Tests run against `lib/`: build first. Keep the module free of `process.env` reads at import
  time so the test file can configure it per case.

**Architecture.** [arch-08 §Sign-in → Flow](https://github.com/Semantu/create-now/blob/main/docs/architecture/08-identity-and-auth.md#flow)
(the discovery diagram: WebID → profile, email → WebFinger → issuer link | WebID link | no answer
→ webid.email), 063 decisions 1 and 2. Parallel track: nothing existing calls this module.

**Tests**
- Quick gate: `npx linked build && node --test test/issuer-discovery.test.mjs`.
- Full gate: `npx linked build && npm test`.

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

**Depends on:** nothing (A2 uses its URL). **Plan doc:** `docs/plans/004-…`. **Size:** medium,
2–3 phases.

**Scope**
- Serve the app's Client ID Document at `{SITE_ROOT}/.well-known/linked-client.jsonld`, built from
  configuration: `client_id` (the document's own URL), `client_name`, `logo_uri`, `redirect_uris`
  (`{SITE_ROOT}/auth/oidc/callback`, plus app-claimed links for native builds), `client_uri`,
  `policy_uri`, `tos_uri`, and the theme extension under its one key
  (`https://linked.cm/ns/signin#theme`).
- **Define the theme schema here** ([contract 3](#3-client-id-document-and-theme-a3--webidemail-w3-w4-cn-c3)):
  TypeScript types, a JSON Schema and `validateClientTheme(doc)` that drops invalid values and
  reports them, plus the font allow-list. webid.email imports this definition (W4); it is not
  served as a schema and webid.email does not publish one.
- Validate the configured theme at startup with that function; log and drop invalid values.
- `Cache-Control` so issuers can cache it.

**Files**
- A new module for the document and the theme, e.g. `src/utils/clientIdDocument.ts` (types, schema,
  `validateClientTheme`, `buildClientIdDocument(config)`), imported by subpath from webid.email.
  Keep it free of Express so W4 can import it server-side without the provider.
- `src/backend.ts`, `AuthBackendProvider.setupBeforeControllers`: routes are registered with
  `this.registerRoute(method, path, ...handlers)` (from `BackendProvider`; `'use'` today, and
  `registerRoute('get', '/health', …)` is the documented form), tracked so `dispose()` can remove
  them on HMR. The document route is one more `registerRoute('get', '/.well-known/linked-client.jsonld', …)`.
- `SITE_ROOT` is read as `process.env.SITE_ROOT` at use time, never normalised (the links in
  `sendVerificationEmail` and `sendResetPasswordLink` concatenate it directly; `expressjwt` uses it
  as the audience). The `.well-known` prefix is already in `expressjwt`'s `unless` list, so the
  document is served without a token check.
- Tests: `test/client-id-document.test.mjs` (build the document from a config, validate themes);
  the serving check can go through the provider as `test/serving.mjs` does, or `curl` against a
  running app for the Verify step.

**Pitfalls**
- A document served with a trailing-slash `SITE_ROOT` would advertise `//.well-known/…`; strip it
  once when building the document (the rest of the package keeps its raw reading).
- `http://` is accepted only for `localhost`: refuse to build a document with a non-localhost
  `http://` `SITE_ROOT` at startup rather than serving one the issuer will reject.
- `validateClientTheme` must reject `url(` and anything but a plain CSS colour in the colour
  fields, and only allow-listed fonts: webid.email renders these values into its own page.
- Configuration has no object today (see A0's pitfalls): the document's values come from
  environment variables or a static the app sets before `setupBeforeControllers`; choose
  consistently with A0 and name the variables in the readme.
- The JSON Schema is an artifact other code imports, so its path is part of contract 3 once W4
  starts: say in the Outcome which subpath exports it.
- Tests run against `lib/`: build first.

**Architecture.** [arch-08 §Branding: the Client ID Document](https://github.com/Semantu/create-now/blob/main/docs/architecture/08-identity-and-auth.md#branding-the-client-id-document)
(fields, the theme as a declarative namespaced extension, panel art as `<img>`, no third-party code
on the issuer page, dev clients), 063 decisions 4 and 5. Parallel track: the route is additive; an
app without sign-in config can serve nothing at that path (404) rather than a half-built document.

**Tests**
- Quick gate: `npx linked build && node --test test/client-id-document.test.mjs`.
- Full gate: `npx linked build && npm test`.

**Verify**
- `curl` returns valid JSON-LD with the configured values; an invalid theme value is dropped with a
  log line.
- webid.email's W3 test client accepts it (once W3 exists).

---

## A5 — Emailed sign-in code and link

**Depends on:** nothing. **Plan doc:** `docs/plans/005-…`. **Size:** medium, ~3 phases.
Implements [contract 5](#5-emailed-sign-in-code-a5--webidemail-w4).

**Scope** (a generic passwordless method next to password; webid.email's pages use it in W4, and
any Linked app may)
- `sendSigninCode(email)`: emails a short code plus a link carrying it. Single use, short expiry,
  rate-limited and enumeration-safe exactly like `sendResetPasswordLink` (answers `true` for every
  well-formed email, whether or not an account exists; a limited request gets the rate-limited
  result). With no email provider the code goes to the server log, as reset links do.
- `signinWithCode(email, code)`: checks the code against the email it was sent to, marks that email
  verified, and ends in the normal step: find or create the Person (IRI from the configured
  derivation) and its `UserAccount`, then the session, as the other methods do. A wrong, expired or
  already-used code is refused with one message.
- A React form and a `useAuth()` method, since the password method has both
  (`SigninWithPasswordForm`, `useAuth().signinWithPassword`); the form is registered in
  `src/index.ts` like the others.
- Readme: the two methods, their rate-limit rules and environment variables, the dev log line.

**Files**
- `src/helpers/credentialToken.ts`: `TOKEN_KINDS` (`reset`, `verify`; each with its token, expiry
  and consume-marker property on `AuthCredential` and a TTL read once from the environment with
  `readTtlFromEnv`), `hashToken`, `clearUnsentToken`, `consumeCredentialToken` (the atomic
  single-use consume). A new kind, e.g. `signinCode`, follows this exactly: three new properties
  in `src/ontologies/auth.ts` and `src/shapes/AuthCredential.ts`, a TTL variable
  (`AUTH_SIGNIN_CODE_TTL`, minutes rather than the reset link's hour).
- `src/helpers/password.ts`: `PasswordHelper.generateToken`, `resetPasswordTokenFields`,
  `consumeResetPasswordToken` show the token lifecycle a credential goes through.
- `src/helpers/emailVerification.ts`: `markEmailVerified(personId, email)` is what a successful
  code sign-in calls.
- `src/utils/rateLimit.ts`: `limitRequest(rule, request, response, accountKey?)` and
  `RATE_LIMIT_DEFAULTS`. Two new rules, one for the request (as `passwordResetRequest`: per IP and
  per email) and one for the check (per IP and per email, so a code cannot be guessed).
- `src/utils/email.ts`: `sendAuthEmail(options, {purpose, url})` sends through `LinkedEmail` and,
  with `DEV_AUTH` on and no provider, prints the link to the log; its `purpose` union is
  `'reset' | 'verify'` and the redaction list is built from the link's `token` parameter.
- `src/backend.ts`: `sendResetPasswordLink` (the template to copy: rate limit, token fields,
  credential lookup by WebID then by `UserAccount.email`, email, `clearUnsentToken` on failure) and
  `createAccount`'s create callback (Person, `AuthCredential`, `UserAccount` through
  `Auth.login(provider, findAccount, createAccount, name)`); `declareCallable` at the bottom, where
  both new methods are declared `'public'`.
- `src/hooks/useAuth.tsx` (`Server.call(packageName, 'signinWithPassword', …)` is the pattern) and
  `src/components/SigninWithPasswordForm.tsx` / `ForgotPasswordForm.tsx` for the form.

<a id="a5-pitfalls"></a>**Pitfalls**
- **A short code is not a 160-bit token.** `consumeCredentialToken` looks a token up by its hash
  across all credentials, and `hashToken`'s comment says a plain hash is enough *because* the token
  is 160 random bits. A six-to-eight-character code must be looked up by the email it was issued
  to, then compared, and the check must be rate-limited per email, or codes can be guessed. The
  link can carry a long token (the credential's) and the code a short one, both single use on the
  same credential; how the two are stored is the first tasks-mode decision, within contract 5.
- **The dev log is gated on `DEV_AUTH`, not on "no provider".** `devAuthEnabled()` in
  `src/utils/email.ts` requires `DEV_AUTH=true` as well as no `LinkedEmail` provider; contract 5
  says "with no email provider", and contract 2 deprecates `DEV_AUTH` in CN. webid.email (W1) and
  CN's `local` mode must set `DEV_AUTH=true` for the log line to appear, or this package needs a
  separate switch. Reported to the master plan; A5 does not change the gate on its own.
- **The new user's WebID must come from the configured derivation (A0).** `createAccount` calls
  `emailToWebID` directly today. If A5 lands before A0, it calls the same function and A0 rewires
  every call site; if after, it uses A0's seam. Either way rebase on `main` before the PR and check
  which it is.
- **Every method is dispatched unless declared.** `test/exposure.test.mjs` fails on a provider
  method not in `declareCallable`/`declareInternal`; any helper that takes an email or a person id
  must live outside the class (as the OAuth helpers do) or be declared internal.
- `RATE_LIMIT_DEFAULTS` is an exhaustive `Record<RateLimitRuleName, …>`: adding a rule name
  without a default does not compile. Env overrides follow `AUTH_RATE_LIMIT_<SNAKE_RULE>_<IP|ACCOUNT>`.
- `test/log-hygiene.test.mjs` checks that failures never log the address or the token; the code
  joins the redaction list. The dev log line is the one place the code is printed on purpose.
- Tests run against `lib/`: build first. The unit tests stub the store with `test/fakeStore.mjs`
  and capture `LinkedEmail` instead of sending (see `test/password-reset.test.mjs`).

**Architecture.** [arch-08 §Verified email decides the WebID](https://github.com/Semantu/create-now/blob/main/docs/architecture/08-identity-and-auth.md#verified-email-decides-the-webid)
(an emailed sign-in link is one of the three ways an email is verified; "sign in as A another way:
an emailed code"), [§Dev-mode identity](https://github.com/Semantu/create-now/blob/main/docs/architecture/08-identity-and-auth.md#dev-mode-identity)
(links to the server log without a provider), [§webid.email service](https://github.com/Semantu/create-now/blob/main/docs/architecture/08-identity-and-auth.md#webidemail-service)
(webid.email's own sign-in is a normal `@_linked/auth` session), 063 decision 9 (a short code in
the same email as the link, so a link opened on one device can be typed on another). Parallel
track: password sign-in, reset and verification keep their methods, tokens and rate-limit rules;
the new kind has its own properties so a reset and a code never consume each other.

**Tests**
- Quick gate: `npx linked build && node --test test/signin-code.test.mjs` (new; alongside
  `test/password-reset.test.mjs`, which it copies the harness from) and
  `node --test test/exposure.test.mjs test/rate-limit.test.mjs test/log-hygiene.test.mjs`.
- Full gate: `npx linked build && npm test`; `npm run test:integration` with the
  `AUTH_TEST_FUSEKI_*` variables set (a code sign-in against a real dataset in
  `test/integration/accounts.fuseki.test.mjs` or a new file next to it).

**Verify**
- Unit and integration tests: a code sign-in creates a session and marks the email verified
  (`emailVerifiedAt` on the credential); a wrong, expired or reused code is refused; a second
  request replaces the first code; the request and the check are rate-limited; with `DEV_AUTH` and
  no provider the code and link appear in the log; the answer to `sendSigninCode` is the same for
  an unknown email.
- The existing methods' tests pass unchanged; `npm test` and `npm run test:integration` pass.

**Done when:** both methods are callable from the client, a Linked app with no email provider can
sign in from the log line in dev, the readme documents them, and the release carries a changeset.

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

- [x] A0 — [#119](https://github.com/linked-fw/auth/pull/119), report [005](../reports/005-webid-derivation-hmac.md)
- [x] A1 — [#122](https://github.com/linked-fw/auth/pull/122), plan doc [003](003-issuer-discovery.md), report [007](../reports/007-issuer-discovery.md)
- [ ] A2
- [ ] A3
- [ ] A5
- [ ] A4
