# @\_linked/auth

## 3.16.0

### Minor Changes

- [#159](https://github.com/linked-fw/auth/pull/159) [`18ee99c`](https://github.com/linked-fw/auth/commit/18ee99c1397013f7653daed994af424da3b06c76) Thanks [@flyon](https://github.com/flyon)! - Ontology data: labels, descriptions and types for every term.
  
  - `src/data/auth.ttl`, copied into `lib/esm/data/` by the build, is the ontology's data: the
    ontology node (`dcterms:title`, `dcterms:description`, `owl:versionInfo`) and all 37 terms of
    `ontologies/auth`, each typed (`owl:Class`, `owl:ObjectProperty` or `owl:DatatypeProperty`) with an
    English `rdfs:label` and `rdfs:comment`, in the deterministic Turtle form.
  - `ontologies/auth` exports `dataFiles` and `loadData` (read through
    `@_linked/core/ontology/loadOntologyFiles`, server only), and the register module passes both, so
    the ontology sync and the shape check read the data.
  - **Breaking:** `src/data/auth.json` (a placeholder) is deleted, so `data/auth.json` is no longer in
    `lib/esm/`, and `loadData()` resolves to the Turtle text (`string[]`) instead of a JSON-LD document.

## 3.15.8

### Patch Changes

- [#157](https://github.com/linked-fw/auth/pull/157) [`37a8115`](https://github.com/linked-fw/auth/commit/37a81151b74cefdf9be491570eedf744e9c19690) Thanks [@abdipramana](https://github.com/abdipramana)! - Use the account shape configured by `AUTH_ACCOUNT_TYPE` throughout password recovery. Applications whose accounts use a custom RDF target class can now request and redeem password-reset links, and reset-email input is trimmed before normalization.

## 3.15.7

### Patch Changes

- [#155](https://github.com/linked-fw/auth/pull/155) [`0c14f49`](https://github.com/linked-fw/auth/commit/0c14f49a9f0a813dc1f95dcc29ba032327cdbf2c) Thanks [@abdipramana](https://github.com/abdipramana)! - Wait for native access and refresh tokens to be removed before completing sign-out.

- [#155](https://github.com/linked-fw/auth/pull/155) [`ca00172`](https://github.com/linked-fw/auth/commit/ca001721f94e088ba57ff1869ef7358232ffc277) Thanks [@abdipramana](https://github.com/abdipramana)! - Keep signed-in auth RPCs protected when used with supported server releases.

## 3.15.6

### Patch Changes

- [#148](https://github.com/linked-fw/auth/pull/148) [`a7e940b`](https://github.com/linked-fw/auth/commit/a7e940ba5d031f3060fc30726338ba13d3a6e1e0) Thanks [@abdipramana](https://github.com/abdipramana)! - Resolve password-reset credentials through the account matched by email, so legacy OAuth accounts whose generated WebID differs from `UserAccount.accountOf` can set a password safely. Password sign-in sessions now also include the stored account email.

## 3.15.5

### Patch Changes

- [#149](https://github.com/linked-fw/auth/pull/149) [`9611ffe`](https://github.com/linked-fw/auth/commit/9611ffe55d9724b68f881f058300f7351e35ca31) Thanks [@flyon](https://github.com/flyon)! - The provider methods that need a session are declared `'signed-in'` instead of the deprecated alias `'user'` (`linkOAuthIdentity`, `resendEmailVerification`, `getReauthenticationMethods`, `removeAccount`, `userHasAuthCredential`, `userHasPassword`). No behaviour change. Requires `@_linked/server-utils` ^1.14.0.

## 3.15.4

### Patch Changes

- [#150](https://github.com/linked-fw/auth/pull/150) [`534e012`](https://github.com/linked-fw/auth/commit/534e01253f903f539c6498ff902ac11dfb4e4836) Thanks [@flyon](https://github.com/flyon)! - State the app configures is now shared by every copy of this package in one runtime (Vite's SSR runner and Node under `linked start`, or two browser bundles), through `@_linked/core`'s `sharedState`:
  
  - the `Auth.userType`, `accountType`, `webIdFor`, `signinClient`, `oidcSignin` and `cookiePrefix` statics (now accessors; assign them as before, but `mock.method(Auth, 'webIdFor')` no longer works: assign a function instead);
  - the client's access token, refresh handler, in-flight refresh and refresh timer, the visibility listeners and the `Server.call` retry hook (installed once);
  - the token storage from `setAuthTokenStorageMethods` and the in-memory access token;
  - the rate-limit store and `configureRateLimits` limits; the refresh session store, `setSessionLimits` and the rotations under way (two copies no longer rotate one refresh token at once);
  - the browser opener from `setOidcSigninBrowser`, and the `onNewUser` / `onAccountWillBeRemoved` events;
  - the `ProvideAuth` contexts: `useAuth` and `useAuthRenderLoading` from one copy see `ProvideAuth` from the other.
  
  `FatalConfigError` is branded: match it from any copy with `isLinkedError(err, FatalConfigError)` from `@_linked/core/utils/linkedError`. Requires `@_linked/core` 2.36.0 and `@_linked/server-utils` 1.13.0 or later. See the readme's "Two copies of the package in one runtime".

## 3.15.3

### Patch Changes

- [#144](https://github.com/linked-fw/auth/pull/144) [`7177978`](https://github.com/linked-fw/auth/commit/7177978bec7dce8e8cccfcbe0400323750b46bc6) Thanks [@flyon](https://github.com/flyon)! - The `@_linked/server` devDependency range is `^3.0.0` (was `^2.0`), so a workspace that has `@_linked/server@3` installs without an ERESOLVE conflict. The package's runtime code is unchanged.

## 3.15.2

### Patch Changes

- [#142](https://github.com/linked-fw/auth/pull/142) [`d78782d`](https://github.com/linked-fw/auth/commit/d78782da120d14e9c772ca178851c79308b7f79a) Thanks [@flyon](https://github.com/flyon)! - Move `@_linked/server` from `dependencies` to `devDependencies`. The package's code never imports it; only a test does, so consumers no longer install a copy of it through `@_linked/auth`.

## 3.15.1

### Patch Changes

- [#140](https://github.com/linked-fw/auth/pull/140) [`0aa46e3`](https://github.com/linked-fw/auth/commit/0aa46e303c2f85e5bdb7dad58bcd60c05767fc0a) Thanks [@flyon](https://github.com/flyon)! - The backend entry (`@_linked/auth/backend`) now exports only `AuthBackendProvider` and `AuthCredentialProvider`. `@_linked/server` constructs every export of a backend entry, so the constants exported next to them failed at boot with `INVALID_SIGNIN_CODE_MESSAGE constructor failed: providerClass is not a constructor` (and the same for `SESSION_COOKIE_NAME`). They moved:
  
  - `SESSION_COOKIE_NAME` and `sessionCookieName` → `@_linked/auth/utils/cookieNames`
  - `INVALID_SIGNIN_CODE_MESSAGE` → `@_linked/auth/utils/signinCode`
  
  Importing them from `@_linked/auth/backend` no longer works; import them from the new paths.

## 3.15.0

### Minor Changes

- [#137](https://github.com/linked-fw/auth/pull/137) [`d8d190c`](https://github.com/linked-fw/auth/commit/d8d190ce3788ecddbfc1be72efdd020470939e8b) Thanks [@flyon](https://github.com/flyon)! - Solid-OIDC sign-in: a verified email from the app's default issuer (`Auth.oidcSignin.defaultIssuer`, webid.email unless set) now proves a WebID on that issuer's origin, so `emailProven` is true for webid.email users in production, where the app cannot derive their WebIDs. Any other issuer's email still proves its WebID only by derivation (`Auth.webIdFor`). With `NODE_ENV` `development` or `test`, any issuer's verified email counts (never in `production`, `staging` or with `NODE_ENV` unset), and a warning is logged.
  
  One account per WebID: the Solid-OIDC callback, code sign-in and signup reuse an account another method made for the WebID without a person (dev sign-in keeps none) instead of creating a second one, and report it as not new. `Auth.login`'s `createAccount` may return `isNewAccount: false` for such a reused account.

## 3.14.0

### Minor Changes

- [#135](https://github.com/linked-fw/auth/pull/135) [`8f683c4`](https://github.com/linked-fw/auth/commit/8f683c43fec2e0c28a1e8e1b3eeb1628239f7733) Thanks [@flyon](https://github.com/flyon)! - One verified email is one account. `signinOAuth` now signs a Google or Apple identity into an existing account when the provider's verified email equals the account's verified email, also when the account has a password (it used to answer `sign_in_to_link`). An account whose email is not verified keeps the old rules, and a different or unverified email never reaches it. Links (`IdentityToken`) now record the provider's verified email (`auth:email`), from `signinOAuth` and `linkOAuthIdentity`: a linked identity whose email has since changed no longer signs in to the old account; it continues by its new email, and its old link is removed once that reaches or creates an account. A link written by an earlier release is followed while the provider's email still resolves to its account, and gets the email recorded.
  
  `startOidcSignin` and `startNativeOidcSignin` accept a `providerHint` with no `input`: the sign-in starts at the default issuer with `provider_hint` and no `login_hint`, so "Continue with Google" needs no typed email.

## 3.13.0

### Minor Changes

- [#133](https://github.com/linked-fw/auth/pull/133) [`5125791`](https://github.com/linked-fw/auth/commit/512579170d7677dcd32685a60a6d19ec18c63621) Thanks [@flyon](https://github.com/flyon)! - The cookie-name prefix now defaults to the app's own `APP_PREFIX`, so several Linked apps on one host keep separate sessions without configuring anything. When neither `Auth.cookiePrefix` nor `AUTH_COOKIE_PREFIX` is set (an empty `AUTH_COOKIE_PREFIX` counts as unset), the prefix is `APP_PREFIX` made a safe cookie-name token plus `_` (`webid-email` → `webid-email_accessToken`, `webid-email_refreshToken`, `webid-email_linkedAuthSession`, `webid-email_linked.auth`); without `APP_PREFIX` the names stay as they were. The client resolves it the same way from `process.env.AUTH_COOKIE_PREFIX` and `process.env.APP_PREFIX`; `resolveCookiePrefix(process.env)` (`@_linked/auth/utils/cookieNames`) gives a Vite config the resolved prefix to `define`.
  
  **Upgrade note:** an app that has `APP_PREFIX` set and no `AUTH_COOKIE_PREFIX` gets new cookie names on upgrade, which signs its users out once. To keep the old names, set `Auth.cookiePrefix = ''`, or set `AUTH_COOKIE_PREFIX` to the prefix you used before. Such an app's browser bundle must get the same prefix: define `process.env.AUTH_COOKIE_PREFIX` as `resolveCookiePrefix(process.env)` (or define `process.env.APP_PREFIX`) in `createViteConfig({define})`; otherwise the client looks for the unprefixed session hint, and a page load that was not server-rendered as signed in shows the user signed out.

## 3.12.0

### Minor Changes

- [#131](https://github.com/linked-fw/auth/pull/131) [`48cdc30`](https://github.com/linked-fw/auth/commit/48cdc30ff5c6082127b1c298d9ac1e0d5fd3cfe1) Thanks [@flyon](https://github.com/flyon)! - A configurable cookie-name prefix, `AUTH_COOKIE_PREFIX` (or `Auth.cookiePrefix`), applied to every
  cookie auth sets and reads: `accessToken`, `refreshToken`, `linkedAuthSession` and the session
  cookie `linked.auth`, on the server and in the client's session hint. Two Linked apps on one host
  (browsers share cookies across ports) no longer sign each other out. Default empty: existing apps
  keep today's cookie names.

## 3.11.0

### Minor Changes

- [#129](https://github.com/linked-fw/auth/pull/129) [`b0860b8`](https://github.com/linked-fw/auth/commit/b0860b8d69f5e1a587a53a5df581882483ed3f25) Thanks [@flyon](https://github.com/flyon)! - Solid-OIDC sign-in in native (Capacitor) apps, following RFC 8252. `startNativeOidcSignin({input, redirectUri})` (on `useAuth`, and in `@_linked/auth/utils/nativeOidcSignin`) opens the issuer in the system browser through the function the app registers with `setOidcSigninBrowser`, never a WebView, and returns to an app-claimed link listed in `Auth.signinClient.redirectUris` (Universal Link, App Link or custom scheme). The system browser shares no cookie with the app, so the pending sign-in (PKCE verifier, nonce, DPoP key, hinted email, issuer) is sealed by the server and held on the device in the app's registered token storage. `completeOidcSignin(callbackUrl)` refuses a link for any other sign-in on the device, then finishes the exchange through the new `completeNativeOidcSignin` RPC with the same checks as the web callback, and stores the session's tokens. The readme documents `apple-app-site-association`, `assetlinks.json` and the values the app owner supplies. The web start and callback do not change.

## 3.10.0

### Minor Changes

- [#127](https://github.com/linked-fw/auth/pull/127) [`ca006d1`](https://github.com/linked-fw/auth/commit/ca006d13ab2de9451b0c0f237dd1d90b1294f637) Thanks [@flyon](https://github.com/flyon)! - Sign in through a Solid-OIDC issuer (opt-in with `Auth.oidcSignin`). `startOidcSignin({input})` finds the issuer for an email or WebID and returns its authorization URL (code flow with PKCE, a DPoP key bound with `dpop_jkt`, `login_hint`, optional `prompt=none` and `provider_hint`); the pending sign-in stays in the browser's server-side session. The callback at `/auth/oidc/callback` exchanges the code with a DPoP proof, checks the ID token's signature against the issuer's JWKS and its `iss`, `aud`, `exp` and `nonce`, requires `webid` and `auth_time`, checks that the WebID's profile names the issuer, and starts a session for the Person at the WebID. A hinted email that differs from the token's goes to `onEmailMismatch`; `onResult` chooses where the browser goes, and errors such as `login_required` are reported, not thrown. New `@_linked/auth/utils/guardedFetch`: a fetch that resolves each host and refuses private addresses before connecting (closes DNS rebinding for issuer discovery when passed as its `fetch`). New dependencies: `openid-client`, `undici`. Without `Auth.oidcSignin` nothing changes.

## 3.9.0

### Minor Changes

- [#123](https://github.com/linked-fw/auth/pull/123) [`95b34df`](https://github.com/linked-fw/auth/commit/95b34df6bbbe2d6b89198042503b61b1f1586beb) Thanks [@flyon](https://github.com/flyon)! - Sign in with an emailed code, a passwordless method next to password. `sendSigninCode(email)` emails an eight-digit code and a link carrying it (`${SITE_ROOT}/auth/signin-code?email=…&code=…`); `signinWithCode(email, code)` redeems it once, marks the email verified and signs in, creating the person (at the WebID `Auth.webIdFor` derives) and account for an email that has none. The code is stored only as a keyed hash (HMAC under a key derived from `JWT_SECRET`). The first code sign-in to a person whose email was not verified yet removes that person's password hashes and revokes their sessions, so a password set by someone who registered the email first stops working. Codes live `AUTH_SIGNIN_CODE_TTL` seconds (default 15 minutes) and are rate-limited by the new `signinCodeRequest` and `signinCode` rules. With `DEV_AUTH=true` and no email provider the link and code are printed to the server log. On the client: `useAuth().sendSigninCode` / `useAuth().signinWithCode` and `SigninWithCodeForm`, which is also the page behind the link (it fills in the code, asks the user to type their email, and signs in on a press). Existing methods are unchanged.

## 3.8.0

### Minor Changes

- [#121](https://github.com/linked-fw/auth/pull/121) [`8411c00`](https://github.com/linked-fw/auth/commit/8411c00d74d50731e1e180f9f59c635b8aee8c8c) Thanks [@flyon](https://github.com/flyon)! - Serve the app's Solid-OIDC Client ID Document at `{SITE_ROOT}/.well-known/linked-client.jsonld` when `Auth.signinClient` is set (nothing is served otherwise). `@_linked/auth/utils/clientIdDocument` defines the sign-in theme extension (`https://linked.cm/ns/signin#theme`): the `SigninTheme` type, `SIGNIN_THEME_JSON_SCHEMA`, the font allow-list `SIGNIN_THEME_FONTS`, `validateClientTheme(doc)` (drops invalid values and reports them) and `buildClientIdDocument(config, siteRoot)`. Invalid configured theme values are logged and left out; an `http:` SITE_ROOT other than localhost stops startup.

## 3.7.0

### Minor Changes

- [#122](https://github.com/linked-fw/auth/pull/122) [`1dfb46c`](https://github.com/linked-fw/auth/commit/1dfb46c1c3451fa2bd7a493a0185689dc956f70f) Thanks [@flyon](https://github.com/flyon)! - Issuer discovery for WebID sign-in, in `@_linked/auth/utils/issuerDiscovery` (server-only). `createIssuerDiscovery(options)` returns `discover(input)` (also `discoverFromEmail`, `discoverFromWebId`, `clearCache`):
  
  - for a WebID, it reads `solid:oidcIssuer` from the profile (Turtle, or JSON-LD with inline contexts);
  - for an email, it asks the domain's WebFinger for an issuer link or a WebID link;
  - when the domain gives no answer, it falls back to a default issuer (`https://webid.email`) with the email as login hint.
  
  ```ts
  const discovery = createIssuerDiscovery({ defaultIssuer: 'https://webid.email' });
  const result = await discovery.discover('alice@example.com'); // { ok, source, issuer, issuers, loginHint, … }
  ```
  
  Results are returned, never thrown. Options cover a skip list of consumer domains (`DEFAULT_SKIP_DOMAINS`), a per-request timeout, a response size cap, a bounded cache whose no-answers expire, and `allowLocalhost` for development.
  
  Only `https://` public hosts are fetched: private and loopback address literals are refused, and every redirect is checked again.
  
  Also exported:
  
  - `fetchOidcIssuers(webId)` and `readOidcIssuers(body, contentType, documentUrl, webId)` for checking an issuer against a profile;
  - `isFetchableUrl`.
  
  Nothing calls the module yet, and existing sign-in methods are unchanged. Adds the `n3` dependency. See the readme's "Issuer discovery".

## 3.6.0

### Minor Changes

- [#119](https://github.com/linked-fw/auth/pull/119) [`9742eea`](https://github.com/linked-fw/auth/commit/9742eeaa2f4073039941841edc5df87c1908cf79) Thanks [@flyon](https://github.com/flyon)! - The email → WebID derivation is configurable: every sign-in method that starts from an email calls `Auth.webIdFor(email)`, which defaults to `emailToWebID`, so existing apps keep their WebIDs. `@_linked/auth/utils/webID` exports the keyed rule webid.email mints WebIDs with: `hmacWebId(email, {secret, issuer})` → `{issuer}/id/{h}#me` (`h` = first 128 bits of HMAC-SHA256 over the trimmed, lowercased email), the factory `hmacWebIdFor({secret, issuer})` to set as `Auth.webIdFor`, and the published `HMAC_WEBID_TEST_VECTOR`.

## 3.5.1

### Patch Changes

- [#114](https://github.com/linked-fw/auth/pull/114) [`a97e35b`](https://github.com/linked-fw/auth/commit/a97e35bd0b8fb4cc05936ebf4eebfa221ac5baf4) Thanks [@abdipramana](https://github.com/abdipramana)! - Google and Apple sign-in now reuse an unambiguous OAuth-only account when its verified email is stored on `UserAccount` or `AuthCredential`, even if the Person uses a legacy non-email-derived WebID. If the email matches multiple people or accounts, sign-in fails closed with `action: "account_conflict"` instead of selecting an arbitrary account or creating another one. Password-protected accounts still require the owner to sign in before linking the provider.

## 3.5.0

### Minor Changes

- [#112](https://github.com/linked-fw/auth/pull/112) [`a8b4154`](https://github.com/linked-fw/auth/commit/a8b4154b77d1d87ba80cbf9b98a111049aaaaca5) Thanks [@flyon](https://github.com/flyon)! - `ProvideAuth` takes a `renderLoading`, which every `RequireAuth` shows while the session is validated (its own `renderLoading` still wins). Without either, `RequireAuth` now renders nothing instead of the text `...`.

## 3.4.1

### Patch Changes

- [#110](https://github.com/linked-fw/auth/pull/110) [`3249b05`](https://github.com/linked-fw/auth/commit/3249b050603d6ca1d2cdb800b90c77168f2d4a5b) Thanks [@flyon](https://github.com/flyon)! - `RequireAuth` now redirects to the sign-in route when validation ends without a session. Before, on a full page load (for example right after signout) it rendered nothing and stayed on the protected page.

## 3.4.0

### Minor Changes

- [#108](https://github.com/linked-fw/auth/pull/108) [`587635c`](https://github.com/linked-fw/auth/commit/587635ccbc1e87fde5d50154eaedfd09291d5701) Thanks [@flyon](https://github.com/flyon)! - Email verification, uniform sign-in and reset answers, and proof for account deletion.
  
  **Check every `removeAccount()` call: a truthy result no longer means deleted.** `removeAccount`
  now answers `true` when the account was deleted and `{error, action, …}` otherwise. That object is
  truthy, so compare `=== true`.
  
  ```ts
  // before: signs the user out even when nothing was deleted
  if (await auth.removeAccount()) signout();
  
  // after
  const result = await auth.removeAccount({ password });
  if (result === true) signout();
  else showError(result.error);
  ```
  
  **Account deletion asks for proof.** `removeAccount()` with no proof answers
  `{error, action: 'reauthenticate', methods}` for an account with a password or a linked
  Google/Apple identity. Send `removeAccount({password})` or `removeAccount({provider, source})`,
  where `source` is what `signinOAuth` takes as its second argument; the ID token must have been
  issued at most 10 minutes ago. The new `getReauthenticationMethods()` tells which to ask for.
  Temporary and dev accounts, and accounts with neither a password nor a Google/Apple link (e.g.
  Facebook-only), still need only a session.
  
  - `RemoveAccountButton` asks for the password itself. If you offer Google or Apple sign-in, pass
    the new `getOAuthSource(provider)` prop: run the provider's sign-in and resolve to the same value
    your sign-in passes to `signinOAuth`. Apple's web redirect (`form_post`) flow cannot supply the
    proof; use popup mode. `className` is now optional.
  
  **Email verification (a soft flag).** Sign-up sends a link to
  `${SITE_ROOT}/auth/verify-email?token=…`. The session reports `emailVerified`
  (`useAuth().emailVerified`, `request.linkedAuth.emailVerified`); your app decides what an
  unverified account may not do. A completed password reset, or a Google/Apple sign-in whose email
  the provider has verified, also verifies the email.
  
  - Add a `/auth/verify-email` route that renders `VerifyEmailCallback`
    (`@_linked/auth/components/VerifyEmailCallback`, optional `onEmailVerified`).
  - New methods: `verifyEmail(token)` (public) and `resendEmailVerification()` (user), also on
    `useAuth()`.
  - The access token's `emailVerified` is updated on the next refresh. Before a sensitive action,
    check on the server with `personEmailVerified(personId)` from
    `@_linked/auth/helpers/emailVerification`.
  
  **New callable methods.** auth declares `verifyEmail` (`public`), `resendEmailVerification`
  (`user`) and `getReauthenticationMethods` (`user`) itself. An app on `rpcExposure: 'enforce'` that
  pins auth's surface in its own table must add them, or its drift check refuses to start.
  
  **New types** (`@_linked/auth/types/auth`): `ReauthenticationMethod`, `RemoveAccountProof`,
  `RemoveAccountResult`, `VerifyEmailResult`, `ResendEmailVerificationResult`;
  `AuthSession.emailVerified` and `VerifiedOAuthIdentity.issuedAt`.
  
  **Configuration**
  
  - `AUTH_EMAIL_VERIFICATION_TTL`: how long a verification link works, in seconds (default 7 days).
  - Register an email provider with `LinkedEmail.setDefaultProvider`. Without one, nothing is sent
    and nothing fails; with `DEV_AUTH=true` the reset and verification links are printed to the
    server log instead. The unused ZeptoMail dependency is removed.
  - New rate-limit rules: `emailVerificationRequest` (10/hour per IP, 3/hour per account),
    `emailVerify` (10/minute per IP) and `reauthenticate` (10/minute per IP, 5 per 15 minutes per
    account), overridable as `AUTH_RATE_LIMIT_<RULE>_<IP|ACCOUNT>`.
  
  **Behaviour changes**
  
  - Sign-in answers "Invalid email / password combination." whether or not the email is registered
    or has a password, and `sendResetPasswordLink` answers `true` for every well-formed email. A UI
    that showed "not registered" should show the generic answer.
  - `createAccount` refuses an email that already has a person, account or credential
    (`action: 'change_email_or_log_in'`).
  - The server requires a password of at least 6 characters (`MIN_PASSWORD_LENGTH` from
    `@_linked/auth/helpers/password`) for sign-up, reset and password change, and answers
    `{error: 'Password must be at least 6 characters', action: 'invalid_password'}`. Show the
    server's error on your sign-up page.
  - Values put into reset and verification emails are HTML-escaped.
  - A failed email send is caught and logged without the address or the link, and the link that
    could not be sent is withdrawn.
  - Reset and verification links are used up atomically, so one link cannot be redeemed twice.
  - `signinDev` refuses a token without `sub`.
  
  See the readme sections *Upgrading to 3.4*, *Sign-in and reset answers*, *Email verification*,
  *Delete account*, *Email configuration*, *Setup Verify Email*, *RPC surface* and *Rate limits*.

## 3.3.0

### Minor Changes

- [#106](https://github.com/linked-fw/auth/pull/106) [`1687fe9`](https://github.com/linked-fw/auth/commit/1687fe942b228e00fed77c3b18472762dce2db7a) Thanks [@flyon](https://github.com/flyon)! - auth declares its whole RPC surface, so an app running `rpcExposure: 'enforce'` keeps sign-in working without declaring any of auth's methods itself.
  
  - Callable `public`: `signinWithPassword`, `createAccount`, `signinOAuth`, `createOAuthNonce`, `signinTemporary`, `signinDev`, `sendResetPasswordLink`, `resetPassword`, `validateToken`, `signout`. Callable `user` (401 without a session): `linkOAuthIdentity`, `removeAccount`, `userHasAuthCredential`, `userHasPassword`.
  - Now internal (never dispatched over HTTP): `hasAuthCredential`, `checkSignin`, `validateRequestToken`, `refreshSession`, `getTokenFromRequest`, `getTokenCandidates`, `getRefreshTokenFromRequest`, in addition to the methods already internal.
  - The client wrapper `AuthCredential.hasAuthCredential(person)` is removed; it answered for any person. Use `AuthCredential.userHasAuthCredential()` or `userHasPassword()` for the signed-in user.
  - The readme documents the surface, how subclasses inherit it, and that apps should wrap the store holding auth's shapes with `withAccess({read: 'none', write: 'none'})`.

## 3.2.0

### Minor Changes

- [#103](https://github.com/linked-fw/auth/pull/103) [`f39a16c`](https://github.com/linked-fw/auth/commit/f39a16cedd02fac6b54fa03af13ae0ce68ee7999) Thanks [@flyon](https://github.com/flyon)! - Rate limit the calls that check a credential, send an email or create something: `signinWithPassword` (10/min per IP, 5/min per email), `createAccount`, `sendResetPasswordLink` (3/hour per email), `resetPassword`, the refresh-token exchange in `validateToken`, `signinOAuth`, `linkOAuthIdentity`, `signinTemporary` and `hasAuthCredential`. A limited call answers `{error, action: 'rate_limited', retryAfter}` with a `Retry-After` header, the same whether the account exists or not (`hasAuthCredential` fails with 429). Counters are in memory per process, keyed by Express's `request.ip` (set `trust proxy` behind a proxy); `setRateLimitStore` plugs in a shared store. `AUTH_RATE_LIMIT=off` turns limiting off, `AUTH_RATE_LIMIT_<RULE>_<IP|ACCOUNT>=<max>/<seconds>` or `configureRateLimits` changes a limit. See *Rate limits* in the readme.

## 3.1.0

### Minor Changes

- [#96](https://github.com/linked-fw/auth/pull/96) [`e6c06a4`](https://github.com/linked-fw/auth/commit/e6c06a488ecf1237f9e56c2b71c0931e4ee4732d) Thanks [@flyon](https://github.com/flyon)! - Depend on `@_linked/react@^2.0.0` (was `^1.1.0`), and on the first releases of its linked dependencies that use it: `@_linked/primitives@^1.8.0`, `@_linked/schema@^1.5.0` and `@_linked/sioc@^1.4.0`. `@_linked/core` moves to `^2.27.0`, the core peer range `@_linked/react` 2 requires.
  
  An app on `@_linked/react` 2 no longer installs a second copy of `@_linked/react` 1 through this package. The APIs used from it — `createLinkedComponentFn`, `useStyles`, `cl` and `useQueryContext` — kept their signatures. `useQueryContext` (used by `AuthProvider` for the `user` and `userAccount` contexts) now also clears its context when `AuthProvider` unmounts, and no longer re-sets it when a new object with the same id is passed.
  
  Minor rather than major: `@_linked/react` is a regular dependency here, not a peer, so no consumer has to change anything to install this release.

## 3.0.8

### Patch Changes

- [#94](https://github.com/linked-fw/auth/pull/94) [`4137de1`](https://github.com/linked-fw/auth/commit/4137de18dcd4bdba5e09068a361b3ddd7d1867b6) Thanks [@flyon](https://github.com/flyon)! - Build with `linked build` instead of a hand-rolled `tsc` + `copyfiles` script, and drop the `rimraf`/`copyfiles` devDependencies. The published `lib/` output is unchanged.

## 3.0.7

### Patch Changes

- [#92](https://github.com/linked-fw/auth/pull/92) [`b788e2e`](https://github.com/linked-fw/auth/commit/b788e2e103e5a5e92e21498efd522d34a8390e4b) Thanks [@flyon](https://github.com/flyon)! - OAuth hardening, ported from PR [#32](https://github.com/linked-fw/auth/issues/32):
  
  - OAuth tokens, payloads and email addresses are no longer written to the log (google-auth-library puts the raw JWT in its error message).
  - The session cookie is now `linked.auth`. The old name `@_linked/auth` is not a legal cookie name, so any request that wrote `req.session` never finished.
  - Removing an account removes every credential and identity token of it; `onAccountWillBeRemoved` listeners are awaited and the subscription can be removed. With duplicate credential rows, the one with a password hash is used.
  - OAuth users are signed in by the provider's subject. A sign-in whose email matches an account that has a password (or another link at that provider) is no longer attached automatically: `signinOAuth` returns `{error, action: 'sign_in_to_link'}`, and the user links the provider after signing in with `linkOAuthIdentity`. This closes pre-account hijacking (an attacker creating a password account with someone's email before they first use Google or Apple). Raw identity tokens are no longer stored. `useAuth().signinOAuth` returns `{error, action}`.
  - Apple sign-in can carry a server-issued, single-use nonce from `createOAuthNonce`. `AUTH_APPLE_NONCE=optional` (default) checks it when present; `required` refuses tokens without one.
  
  Apps with an RPC exposure list should declare `linkOAuthIdentity: 'user'`, `createOAuthNonce: 'public'` and `userHasPassword: 'user'`.

## 3.0.6

### Patch Changes

- [#89](https://github.com/linked-fw/auth/pull/89) [`e2dc411`](https://github.com/linked-fw/auth/commit/e2dc411ed2b9d4b45a63a3617fe8d84355e641ad) Thanks [@flyon](https://github.com/flyon)! - The server no longer dispatches auth's internal provider methods over HTTP. `upgradePasswordHash` (added in 3.0.4), `getPasswordForUser`, `getOrCreateAccount`, `loadAccountForSession` and `loadUserForSession` on the backend provider, and `createNewCredential` on `AuthCredentialProvider`, are declared with `declareInternal` from `@_linked/server-utils/utils/callable`, so `/call/@_linked/auth/...` answers 501 for them in every `rpcExposure` mode. Before, in the default `warn` mode, anyone could call them, for example to set any credential's password. Calls from backend code are unaffected. Requires `@_linked/server-utils` `^1.9.0` (was `^1.8.0`).
  
  package.json `types` now points at `lib/esm/index.d.ts`. It pointed at `index.d.ts`, which is not in the package.

## 3.0.5

### Patch Changes

- [#87](https://github.com/linked-fw/auth/pull/87) [`8a5bd85`](https://github.com/linked-fw/auth/commit/8a5bd859ec5b6c9bd584523bfdaa4d84be4f23c9) Thanks [@flyon](https://github.com/flyon)! - Declares its React peer; accepts React 18 or 19. The components import `react`, which is now a `peerDependencies` entry (`^18.2.0 || ^19.0.0`) so the consumer's single React copy is used.

## 3.0.4

### Patch Changes

- [#85](https://github.com/linked-fw/auth/pull/85) [`20d8200`](https://github.com/linked-fw/auth/commit/20d820016086a0f19611cfe459e91f463ab49d57) Thanks [@flyon](https://github.com/flyon)! - Security: stronger password hashing, and changing a password while signed in now needs the current password.
  
  - **New password hashes use bcrypt cost 10** (`PASSWORD_HASH_COST`, exported from `helpers/password`). Before, the cost was 3, which bcrypt raises to its minimum of 4. This applies to `createAccount`, `resetPassword` and `AuthCredential.createNewCredential`. A hash now takes roughly 80 ms on the server.
  - **Existing hashes upgrade on the next sign-in.** After `signinWithPassword` verifies a password whose stored hash has a lower cost, it re-hashes it at cost 10 and stores it, writing only `passwordHash`. If that write fails the sign-in still succeeds; the failure is logged and the next sign-in tries again. Nothing needs migrating. New `PasswordHelper.needsRehash(hash)`.
  - **`resetPassword` without a reset token now requires the current password**, as a new fourth argument: `resetPassword(password, confirmPassword, token, currentPassword)`. It is verified against the stored hash. Without it the call returns `{error: 'Your current password is required to change your password'}`, and with a wrong one `{error: 'Your current password is incorrect'}`. Before, a signed-in session alone could change the password.
  - An account that has **no password yet** (e.g. OAuth only) can no longer get one through `resetPassword` without a token. It returns `{error, action: 'reset_password_by_email'}`; the reset email is the way to set one.
  - The reset link path (with a token) is unchanged: no current password, single-use, expiring.
  - `CreateNewPasswordForm` (and so `EditPasswordButton`) asks for the current password when it has no `token`, and now shows the server's error instead of ignoring it.
  
  **Apps with their own change-password UI** that call `resetPassword` without a token must send the current password as the fourth argument, or the change is refused.
  
  The npm package now ships only `lib/`, `readme.md`, `CHANGELOG.md` and `package.json` (a `files` list). `.github/`, `.changeset/`, `docs/`, `renovate.json`, `.gitattributes` and the `tsconfig-*.json` files are no longer in the tarball.

## 3.0.3

### Patch Changes

- [#83](https://github.com/linked-fw/auth/pull/83) [`11449ce`](https://github.com/linked-fw/auth/commit/11449ced3a4fffe24240ed59c4349898028108d6) Thanks [@flyon](https://github.com/flyon)! - Security: password reset links now expire and work only once.
  
  - A link expires **1 hour** after it is sent. Set `AUTH_PASSWORD_RESET_TTL` (whole seconds) to change that; a value that is not a positive whole number stops the server at startup, like the other `AUTH_*_TTL` settings.
  - A link works **once**. `resetPassword` removes the token as soon as it is presented with matching passwords, so a second use fails even if the first one failed later on. Mismatched passwords do not use it up.
  - Requesting a new link replaces the previous one, and changing the password while signed in ends any outstanding link.
  - Only a SHA-256 hash of the token is stored now (`forgotPasswordToken`), with its expiry in the new `AuthCredential.forgotPasswordTokenExpiresAt` property (`https://linked.cm/ont/auth/forgotPasswordTokenExpiresAt`, `xsd:dateTime`).
  
  **Links sent by earlier releases stop working.** Their tokens were stored without an expiry, so they are treated as expired; users who still have one open need to request a new link. Nothing needs migrating.
  
  `PasswordHelper.validateResetPasswordToken` now also rejects expired tokens, and the new `PasswordHelper.consumeResetPasswordToken` validates and removes a token in one step.
  
  `signinDev` (only with `DEV_AUTH=true`) no longer stores the client-supplied `email` on an account that has none. Only the email claim of the verified access token is stored; the `email` input is ignored.

## 3.0.2

### Patch Changes

- [#81](https://github.com/linked-fw/auth/pull/81) [`a293246`](https://github.com/linked-fw/auth/commit/a293246e0c0bec64ea55e19e5cc17392d5b44575) Thanks [@flyon](https://github.com/flyon)! - Security: `signinOAuth` now only accepts providers whose token the server verifies itself, which are `google` and `apple`. Any other provider, including a missing or unknown one, returns `{error: 'Unsupported OAuth provider'}` and is logged.
  
  **Facebook sign-in via `signinOAuth` is no longer accepted** until proper Facebook token verification lands. It trusted the email the client sent, without checking it against Facebook, and signed in the account that owns that email. Apps that call `signinOAuth('facebook', …)` now get the error above.
  
  The email that is signed in now always comes from the verified Google or Apple token. An `email` field sent by the client is ignored.

## 3.0.1

### Patch Changes

- [#79](https://github.com/linked-fw/auth/pull/79) [`1a11011`](https://github.com/linked-fw/auth/commit/1a11011d96772df2a65659c99f7e463799b09c30) Thanks [@flyon](https://github.com/flyon)! - Security: Apple identity tokens are now verified against their audience and issuer. Before, any token signed by Apple was accepted, including one Apple issued to a different app, and its email was signed in.
  
  **Action required if you use Sign in with Apple: set `APPLE_CLIENT_ID`** (the Services ID, for web sign-in) and/or **`APPLE_CLIENT_ID_IOS`** (the app's bundle ID, for native sign-in) on the server. Either may hold several comma-separated IDs. **Without one, Apple sign-in is rejected** (fail closed) and the server logs `No Apple client IDs configured, rejecting Apple sign-in`. This mirrors the existing `GOOGLE_CLIENT_ID*` variables.
  
  Also:
  
  - The token must be RS256, issued by `https://appleid.apple.com`, unexpired, and carry `email_verified: true` when it has an email.
  - `signinOAuth('apple', …)` without an `identityToken` is now rejected (`No Apple identity token provided`). Before, it fell through and signed in with the email the client sent.
  - An invalid Apple token now returns `{error: 'Invalid Apple identity token'}` instead of throwing.

## 3.0.0

### Major Changes

- [#70](https://github.com/linked-fw/auth/pull/70) [`30b5346`](https://github.com/linked-fw/auth/commit/30b5346ecfadbe476c05d7ee877811919f59536b) Thanks [@flyon](https://github.com/flyon)! - Server-set httpOnly auth cookies, a client refresh scheduler, 15-minute access tokens and session lifetime limits.
  
  **Breaking for browser clients**
  
  - The server now sets the auth cookies itself: `accessToken` (httpOnly, SameSite=Lax, Path=/, until the JWT `exp`), `refreshToken` (httpOnly, SameSite=Strict, Path=`/call/@_linked/auth`, until the stored expiry) and `linkedAuthSession` (a readable `1`, no secret). `Secure` follows `req.secure` (set Express `trust proxy` behind a TLS proxy) or an https `SITE_ROOT`. JavaScript can no longer read any auth cookie, and js-cookie is gone.
  - Browsers no longer receive `refreshToken` in response bodies. Native clients that call `setAuthTokenStorageMethods` still do: the client then sends `x-linked-auth-transport: body`. Other non-browser clients (scripts, tests) can send that header too.
  - `getAccessToken()` returns the access token held in memory; right after a server-rendered page load there is none until the first refresh (the page itself was authenticated by the cookie).
  - The default access token lifetime outside development is now 15 minutes (was 10 days); development is 1 hour (was 24 hours). `AUTH_ACCESS_TOKEN_TTL` still overrides it.
  
  **New**
  
  - Refresh scheduler: refreshes about 60 s before the access token expires, and when the tab becomes visible or focused with a stale token. Concurrent refreshes share one request. A `Server.call` that gets a 401 refreshes once and is retried once (through `LincdServerProxy.setAuthHandler`; requires `@_linked/server-utils` ^1.8.0). A replaced refresh token presented within the 30 s grace window — a lost refresh response — gets a fresh refresh token instead of ending the session later. A session that ends while a tab is open clears all client auth state. `auth.user` keeps its identity across refreshes when unchanged. `ENFORCE_SIGNIN` tries one refresh before signing out.
  - Session limits: `AUTH_SESSION_IDLE_TTL` (default 7 days without a refresh) and `AUTH_SESSION_MAX_TTL` (default 60 days after sign-in), `0` turns either off. A new optional `auth:sessionStartedAt` is stored on `RefreshToken`; older records fall back to their session's first `createdAt`.
  - `cleanupExpiredSessions(store?, {olderThan})` deletes refresh token records revoked or expired more than 30 days ago (`AUTH_SESSION_CLEANUP_AFTER`). The backend provider runs it in the background at most once a day per process; `AUTH_SESSION_CLEANUP=false` turns that off.
  - `validateToken(refreshToken?, {forceRefresh})`; signing out and a failed refresh clear the cookies.
  - Cookie overrides: `AUTH_COOKIE_SECURE`, `AUTH_COOKIE_SAMESITE`, `AUTH_COOKIE_DOMAIN`, `AUTH_REFRESH_COOKIE_PATH`.
  
  **Migrating an app**
  
  - Remove any code that reads or writes the `accessToken`/`refreshToken` cookies from JavaScript; keep the server reading `request.cookies.accessToken` or, better, `request.linkedAuth`.
  - Behind a TLS-terminating proxy, set `app.set('trust proxy', …)`.
  - If the frontend is served from another site than the API, set `AUTH_COOKIE_SAMESITE=none`.
  - Users stay signed in: a refresh cookie written by the previous client on `/` is still accepted once and replaced by the scoped one.

## 2.0.1

### Patch Changes

- [#68](https://github.com/linked-fw/auth/pull/68) [`5c4c2de`](https://github.com/linked-fw/auth/commit/5c4c2de781316b190b114384b884dd722bd6f1da) Thanks [@flyon](https://github.com/flyon)! - - A missing `JWT_SECRET` / `SESSION_SECRET` outside development/test now throws a `FatalConfigError`
    (`fatal: true`). @_linked/server releases that honour `fatal` abort startup on it instead of
    logging the failed provider hook and serving with broken auth.
  - Token responses (every sign-in, `validateToken`, `updateSessionData`) now carry
    `refreshTokenExpiresIn` (seconds) and `refreshTokenExpiresAt` (ISO) for the refresh token they
    return. The client sizes the refresh cookie from them, so it no longer outlives the server's
    record when `AUTH_REFRESH_TOKEN_TTL` is shorter than the client default; the access cookie keeps
    following the JWT `exp`. Without these fields (older servers) the client falls back to its
    defaults, and leaves an unchanged echoed refresh token alone instead of extending it.
    New export `storeAuthTokens` in `utils/token`.
  - A non-JWT value presented as an access token (typically the opaque refresh token) is no longer
    logged; other rejected tokens (bad signature, wrong audience or kind) are logged once per token.

## 2.0.0

### Major Changes

- [#66](https://github.com/linked-fw/auth/pull/66) [`58a8b34`](https://github.com/linked-fw/auth/commit/58a8b34752913d47e4b4d7ad0dda5c9b072d0e92) Thanks [@flyon](https://github.com/flyon)! - Auth's ontology moves from `http://lincd.org/ont/auth/` to `https://linked.cm/ont/auth/`, the first-party scheme every public package uses (`https://linked.cm/ont/{publicSlug}/`, next to its shapes at `https://linked.cm/shape/auth/`).
  
  **Breaking — stored auth data must be migrated.** Every auth class and property changed IRI. Credentials, refresh token records and the synced shape descriptions written by 1.x are invisible to this release until they are rewritten: sign-in answers "No password found for this email". Nothing is deleted. Run the migration once per dataset that auth shapes are stored in, right after deploying:
  
  ```ts
  import { migrateAuthNamespace } from '@_linked/auth/utils/migrateNamespace';
  await migrateAuthNamespace(store, { dryRun: true }); // counts only
  await migrateAuthNamespace(store); // { before: N, after: 0, dryRun: false }
  ```
  
  - `migrateAuthNamespace(dataset, {dryRun?})` rewrites every IRI under the legacy namespace (subject, predicate and object, default graph and every named graph) in one SPARQL UPDATE request. Literals are untouched. It is idempotent. `dataset` is any store with `rawQuery` (e.g. `FusekiStore`), not a dataset router.
  - `hasLegacyAuthData(dataset)` is a cheap boot-time check for records the migration has not reached; `countLegacyAuthTriples(dataset)` counts everything left.
  - The ontology terms (`auth.AuthCredential`, `auth.passwordHash`, …) keep their names; only their IRIs change. Code that hard-codes `http://lincd.org/ont/auth/` in SPARQL must be updated.
  - `RefreshToken`: `tokenHash`, `sessionId`, `account`, `createdAt` and `expiresAt` are now required, so creating a record without them is refused instead of storing a token that can never match or expire. The session store reads and writes the records through the typed query DSL without casts.

## 1.7.0

### Minor Changes

- [#64](https://github.com/linked-fw/auth/pull/64) [`8966cf5`](https://github.com/linked-fw/auth/commit/8966cf5a29e86aaffd17861662b4e0e28bd57e9b) Thanks [@flyon](https://github.com/flyon)! - Token security: refresh tokens can no longer be used as access tokens, and refresh now actually works.
  
  - **Access tokens are typed.** They carry `typ: 'access'`, `aud` (SITE_ROOT), `sid` (session) and `jti`. Every access check — the request middleware, `verifyToken`, `validateToken` — accepts only access tokens for the right audience. Previously a refresh token (a 60-day JWT) was accepted as a login. Access tokens issued by earlier releases keep working until they expire (they carry `aud`); earlier refresh tokens (no `aud`) are refused.
  - **New `verifyAccessToken(token, {audience?})`** in `@_linked/auth/utils/jwt`. Apps that verify tokens themselves should use it instead of `jwt.verify`.
  - **Refresh tokens are stored, hashed and rotated.** A refresh token is now an opaque random value; only its SHA-256 hash is stored, as a `RefreshToken` shape (new properties: `tokenHash`, `sessionId`, `createdAt`, `lastUsedAt`, `expiresAt`, `revokedAt`, `replacedBy`; the raw-token `token` property is gone). `validateToken` exchanges it for new tokens and rotates it; presenting a replaced token again revokes the whole session (a 30-second grace covers concurrent tabs). Sign-out revokes the session, a password reset revokes every session of the account, and removing an account deletes its records. The request middleware no longer refreshes.
  - **Behaviour change — refresh tokens issued by earlier releases are invalid** (they were never stored, so they cannot be checked). Users sign in again when their current access token expires, which is also what happened before: refresh never succeeded.
  - **Behaviour change — the server refuses to start without `JWT_SECRET` and `SESSION_SECRET`** unless `NODE_ENV` is `development` or `test` (an unset NODE_ENV and `staging` count as production). Generate them with `openssl rand -base64 48`. Development keeps the old fallbacks and warns.
  - Lifetimes are configurable with `AUTH_ACCESS_TOKEN_TTL` / `AUTH_REFRESH_TOKEN_TTL` (seconds); defaults are unchanged.
  - The token verification cache now drops an entry at the token's own expiry (it served expired tokens before) and is bounded.
  - Client: cookies get the right lifetime (seconds were passed to js-cookie as days); the access cookie expires with the token; `validateToken` refreshes with the refresh token alone once the access token is gone; `signout` sends the refresh token so the server can revoke the session.
  - Removed `RefreshToken.removeRefreshToken` and `RefreshToken.getRefreshTokenForAccount` (they matched on a raw token that was never stored); use `revokeSession`, `revokeAllSessionsForAccount` and `deleteAllSessionsForAccount` from `@_linked/auth/utils/sessions`.
  - `removeAccount` deletes the credential, account and person by reference (it passed whole query results to `delete`, which rejected them).

## 1.6.5

### Patch Changes

- [#58](https://github.com/linked-fw/auth/pull/58) [`514ea33`](https://github.com/linked-fw/auth/commit/514ea330ec55865081c90137440ba2070a0badb9) Thanks [@renovate](https://github.com/apps/renovate)! - Drop the unused `chalk` dependency. Nothing in the package imported it.

## 1.6.4

### Patch Changes

- [#57](https://github.com/linked-fw/auth/pull/57) [`c4f4a7e`](https://github.com/linked-fw/auth/commit/c4f4a7e5d5c38c8ada78de013cfade47d65fa31c) Thanks [@renovate](https://github.com/apps/renovate)! - Upgrade bcrypt to 6. It ships prebuilt N-API binaries for linux (glibc and musl, x64/arm64/arm), macOS and Windows inside the package, so installing no longer downloads a binary from GitHub or falls back to a node-gyp compile. Requires Node 18 or newer. Existing password hashes keep verifying — a test pins hashes produced by bcrypt 5 against the built helper.

## 1.6.3

### Patch Changes

- [#53](https://github.com/linked-fw/auth/pull/53) [`c752b50`](https://github.com/linked-fw/auth/commit/c752b5062db4eaa721a021a8dcc7fd37ca27c6c8) Thanks [@flyon](https://github.com/flyon)! - Add `shapes/index`, a side-effect-only module that registers every shape this package defines and nothing else (no components, no CSS), so `import '@_linked/auth/shapes/index'` loads the shapes in plain node as well as in a bundle. The package entry now imports it instead of listing shapes one by one.

## 1.6.2

### Patch Changes

- [#51](https://github.com/linked-fw/auth/pull/51) [`fc82382`](https://github.com/linked-fw/auth/commit/fc823821e6a8b324ce6f36d8c15862e74d3b4e2c) Thanks [@flyon](https://github.com/flyon)! - Reference UserAccount and Person by class, so loading an auth shape registers them.

  The shapes named them by `[package, name]`, which does not register anything. They
  were registered only because `emitDecoratorMetadata` happened to keep the getter
  return-type import alive in the tsc build; a consumer compiling the source with
  esbuild (a localized checkout under Vite) emits no metadata, loses the import, and
  queries traversing `account` or `credentialOf` throw `Shape class not found`.

## 1.6.1

### Patch Changes

- [#43](https://github.com/linked-fw/auth/pull/43) [`0d4c713`](https://github.com/linked-fw/auth/commit/0d4c713d2213a69a6a4cb367cce96c8b6035ae7f) Thanks [@flyon](https://github.com/flyon)! - Sourcemaps now embed their TypeScript source, so consumers no longer see 'points to missing source files' warnings.

## 1.6.0

### Minor Changes

- [#40](https://github.com/linked-fw/auth/pull/40) [`0581885`](https://github.com/linked-fw/auth/commit/0581885d4ff3841ac6b0dc709d7d605c59f479a7) Thanks [@flyon](https://github.com/flyon)! - Drop the `foaf` dependency — the last legacy `lincd` package reachable from this tree.

  `foaf` was used for types only: no emitted `.js` in `lib/` ever imported it, so the legacy
  `lincd` framework copy it pulls in (`lincd`, `lincd-jsonld`, `lincd-rdfs`,
  `lincd-design-elems`) was never loaded at runtime — it only sat in the installed tree.

  - `src/types/auth.ts` and `src/hooks/useAuth.tsx`: the import (and, in `useAuth`, the
    `type Person` alias) were entirely unused. Removed.
  - `src/backend.ts`: `type Person = FoafPerson | SchemaPerson` widened to `Shape`.
  - `src/utils/auth.ts`: `Auth.userType` widened from
    `typeof SchemaPerson | typeof FoafPerson` to `typeof Shape`, and the two
    `QResult<SchemaPerson | FoafPerson>` callback positions to `QResult<Shape>`.

  All three are widenings, so existing callers keep compiling; `AuthProviderProps.userType`
  already used `typeof Shape`, so this makes the two sides agree.

## 1.5.0

### Minor Changes

- [#38](https://github.com/linked-fw/auth/pull/38) [`65e425c`](https://github.com/linked-fw/auth/commit/65e425cae6c6ad96056ea12842444c73d33c8c23) Thanks [@flyon](https://github.com/flyon)! - Require `@_linked/core@^2.22.8` (was `^2.0.1`), and pin it in the lockfile.

  The declared range was wide enough that the resolved core depended on whatever the
  consumer — or this repo's own CI, via `package-lock.json` — happened to install. Core
  decides how a shape's IRI is minted, so a stale core made this package emit legacy
  `data.lincd.org` IRIs instead of the arch-02 `linked.cm` scheme. Which IRIs a published
  package produces should not be a function of the installer's dependency tree.

  Minor rather than patch: this raises the minimum core a consumer must resolve, so it
  changes what gets installed rather than only what this package does internally.

## 1.4.0

### Minor Changes

- [#36](https://github.com/linked-fw/auth/pull/36) [`8a8442b`](https://github.com/linked-fw/auth/commit/8a8442b282babddcebc21bf6c836f715aa1e8e08) Thanks [@flyon](https://github.com/flyon)! - The six account screens are built on `@_linked/primitives`, and the last `lincd-*`
  dependencies are gone.

  `Button` and `Modal` came from `lincd-mui-base` and `TextField` from `lincd-input`. Those
  are now `Button`, `Input`, `Dialog` and `ConfirmDialog` from `@_linked/primitives`, adapted
  at each call site rather than by widening the shared components: `variant="outlined"` maps
  to `outline`, `color` carries over unchanged, `startIcon` becomes a child (Button's root is
  already a flex row with a gap), `fullWidth` becomes one `width: 100%` in each component's
  own CSS module, `helperText` becomes a sibling paragraph beside the field, and
  `endAdornment` becomes a positioned control inside a relative wrapper.

  Two changes are behavioural rather than cosmetic, both improvements:

  - **Every modal in this package works again.** `lincd-mui-base`'s `Modal` wraps
    `@mui/base`'s `FocusTrap`, which throws `rootRef.current.contains is not a function`
    under React 19 — opening any of them unmounted the whole React tree. The Radix-backed
    `Dialog` also brings a focus trap, Escape handling, `aria-modal`, focus restoration and a
    close affordance.
  - **`RemoveAccountButton` now asks with a `ConfirmDialog` in `tone="danger"`** instead of a
    hand-built body inside a generic modal. That makes it an `alertdialog`, so a click on the
    backdrop no longer dismisses a destructive confirmation.

  The screens also pick up `@_linked/css` tokens for the first time. Their colours previously
  resolved through `--ld-app-color-*` and `--ld-ref-palette-*`, which are defined nowhere, so
  they rendered essentially unstyled; the local overrides that fought those undefined tokens
  have been removed rather than given more specificity.

  Also: the full-viewport centring that lived on `CreateNewPasswordForm`'s own root moved to
  `ForgotPasswordCallback`, the page that wants it. On the root it forced a `100vh` box inside
  the dialog that `EditPasswordButton` renders the same form into.

## 1.3.4

### Patch Changes

- [#33](https://github.com/linked-fw/auth/pull/33) [`21f9c4e`](https://github.com/linked-fw/auth/commit/21f9c4eecb60bec4d07a462e4fb3362fcc82fed1) Thanks [@flyon](https://github.com/flyon)! - The ontology no longer registers by importing itself.

  It carried `import * as _this from './<prefix>.js'` and passed that namespace to
  `linkedOntology()`. Under `tsc` the self-reference survives; under a bundler it does
  not — Rollup treats it as a circular import and elides it, so the binding is
  `undefined` and a consuming app dies at boot with `_this is not defined`.

  Registration now lives in a `<prefix>.register.ts` sibling, imported from the package
  entry. Nothing changes for consumers: importing this package still registers the
  ontology.

## 1.3.3

### Patch Changes

- [#30](https://github.com/linked-fw/auth/pull/30) [`8e108c2`](https://github.com/linked-fw/auth/commit/8e108c253e85878d88474656b37711034c1ac11b) Thanks [@flyon](https://github.com/flyon)! - Point the changelog generator at this repo's real org.

  `.changeset/config.json` still named `linked-cm/auth` as the GitHub repo, but
  this package lives in `linked-fw/auth`. Every commit, PR and author link that
  `@changesets/changelog-github` wrote into `CHANGELOG.md` therefore pointed at a
  repository that does not exist. Renaming the org makes the generated links
  resolve.

## 1.3.2

### Patch Changes

- [#28](https://github.com/linked-fw/auth/pull/28) [`0cf087f`](https://github.com/linked-fw/auth/commit/0cf087f6502a1efaf422905f85afb3d210b79304) Thanks [@flyon](https://github.com/flyon)! - Compile the whole `src` folder, and let a bare import resolve under Node10.

  The build only emitted what an entry transitively reached, so any module
  nothing imported was never built — and never type-checked, so it rotted
  quietly. `include` now covers `src/**/*` with tests excluded explicitly.

  `typesVersions` maps every specifier through `lib/esm/*`, so a `types` value
  that already carried that prefix had it applied twice and no consumer on
  classic Node10 resolution could `import` the package by its bare name.

## 1.3.1

### Patch Changes

- [#25](https://github.com/linked-fw/auth/pull/25) [`11e67f0`](https://github.com/linked-fw/auth/commit/11e67f0cb8b20a7386b936efaeefe2db0c3f1fe3) Thanks [@flyon](https://github.com/flyon)! - Declare npm as the package manager for this repo, convert the build scripts off `yarn`, and mark `package-lock.json` as a generated file.

## 1.3.0

### Minor Changes

- [#19](https://github.com/linked-cm/auth/pull/19) [`4b1689e`](https://github.com/linked-cm/auth/commit/4b1689e1a1095063d01c5f0b171f751c2f7a2082) Thanks [@flyon](https://github.com/flyon)! - Rename `IdentityToken.subject` to `IdentityToken.sub`.

  `subject` is a field of the query builder, so `IdentityToken.select(t => [t.subject])` and
  `.where(t => t.subject.equals(...))` resolved to that field instead of the property and failed.
  This broke `getTokenByEmailOrSubject`, `getTokenByAccount` and `hasToken`.

  The RDF predicate is unchanged (`auth:subject`), so stored tokens need no migration. Update
  any code that reads `token.subject` from query results or passes `subject` to
  `IdentityToken.create`/`update` to use `sub`.

## 1.2.3

### Patch Changes

- [#12](https://github.com/linked-cm/auth/pull/12) [`ef1c23b`](https://github.com/linked-cm/auth/commit/ef1c23b12e7b49481d6f5124e2404279028c63fa) Thanks [@flyon](https://github.com/flyon)! - Dev signin now builds the session user as plain identity data (`{ id }`, a QResult) instead of a live `Shape` instance. A live Shape crossed the SSR/JWT serialization boundary and reached the client as an unusable `{__s, u}` reference (undefined `.id`), breaking auth-dependent UI (e.g. the workspace name showing `?`). Also removes the interim `reviveShapeRef` workaround.

## 1.2.2

### Patch Changes

- [#9](https://github.com/linked-cm/auth/pull/9) [`2fa7118`](https://github.com/linked-cm/auth/commit/2fa7118a64e3689f901c0cc8186bbe6010690d90) Thanks [@flyon](https://github.com/flyon)! - Remove the `development` export condition (pointed at `src`, which isn't shipped to npm). Monorepo dev resolves workspace source via the cli Vite plugin; standalone resolves `import → lib`. No consumer-visible change.

## 1.2.1

### Patch Changes

- [#7](https://github.com/linked-cm/auth/pull/7) [`406f7ef`](https://github.com/linked-cm/auth/commit/406f7ef365bbd5069a3e5cb68724169032aecebd) Thanks [@flyon](https://github.com/flyon)! - loadData: ESM-only JSON import — drop the dead CJS branch, add the `{ with: { type: 'json' } }` import attribute.

## 1.2.0

### Minor Changes

- [#5](https://github.com/linked-cm/auth/pull/5) [`ed9add7`](https://github.com/linked-cm/auth/commit/ed9add71319bc306be42bae527c5fb2faeef37fc) Thanks [@flyon](https://github.com/flyon)! - **ESM-only.** Dropped the CommonJS build; ships ES modules only (`type: module`, no `require` export condition). Fixed the root `types` field. CJS projects on Node 22+ can `require()` it (sync ESM) or use dynamic `import()`.

### Patch Changes

- [#5](https://github.com/linked-cm/auth/pull/5) [`0f1f502`](https://github.com/linked-cm/auth/commit/0f1f5028e1a36415d98616b7ef9d40f90ad30263) Thanks [@flyon](https://github.com/flyon)! - Migrated all `lincd-sioc` references to `@_linked/sioc` (the new package
  name; sioc was extracted from `lincd.org/modules/` to its own workspace

  - git repo — see the `@_linked/sioc@1.1.0` release notes for the
    package-side story).

  Internal changes (no consumer-facing API change):

  - 10 source files updated: `UserAccount` imports across `backend.ts`,
    `hooks/useAuth.tsx`, `shapes/{AuthCredential, Authentication, IdentityToken,
Password, RefreshToken}.ts`, `types/auth.ts`, `utils/auth.ts`.
  - 3 shape-registration strings updated: `['lincd-sioc', 'UserAccount']` →
    `['@_linked/sioc', 'UserAccount']` in `shapes/{IdentityToken, Password,
RefreshToken}.ts`. The string is the package name stored on the shape
    for dispatch; the new value matches what `linkedPackage('@_linked/sioc')`
    registers.
  - `package.json`: dropped `lincd-sioc: ~1.0`, added `@_linked/sioc: workspace:*`
    (or pin to the published `@_linked/sioc@^1.1` if consuming as a
    published package).

  Consumers should update their own `lincd-sioc` deps to `@_linked/sioc`
  when they upgrade `@_linked/auth` to this version, to avoid having
  both packages installed side-by-side.

  Context: see create-now plan-011 report (docs/reports/009-legacy-lincd-eradication.md).

## 1.1.0

### Minor Changes

- [#2](https://github.com/linked-cm/auth/pull/2) [`7c8d701`](https://github.com/linked-cm/auth/commit/7c8d701c8da685a54ebf88ee5dab1a8ee0537576) Thanks [@flyon](https://github.com/flyon)! - - `feat(webid)`: UUID v5 derivation with public namespace; restore `telephoneToWebID` with dedicated phone namespace
  - `fix(backend)`: use `UserAccount.email` lookup instead of `webIDToEmail(user.id)`
  - `feat(signin-dev)`: `AuthBackendProvider.signinDev` + `useAuth.signinDev` hook
  - `fix(signin-dev)`: tolerate boolean `true` in `DEV_AUTH` env var; select a real decorated property when looking up Person
  - `fix(build)`: switch to explicit per-step build pipeline so silent build failures no longer ship empty tarballs

## 1.0.6

### Patch Changes

- [`9c5b6aa`](https://github.com/linked-cm/auth/commit/9c5b6aac3c5b497077bdbf687132e489cfd3ada3) - Initial release under the new publishing setup.
