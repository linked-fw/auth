# How to use Auth Package

## Overview

The Auth package facilitates authentication in your application using JSON Web Tokens (JWT). It employs `express-jwt` for stateless authentication. In browsers the **server** sets the tokens as httpOnly cookies; native apps (Capacitor) register their own storage with `setAuthTokenStorageMethods`.

Signing in returns two tokens:

- an **access token** — a JWT (`typ: 'access'`, `aud` = `SITE_ROOT`, `sid` = the session) that authenticates requests as a Bearer header or `accessToken` cookie;
- a **refresh token** — an opaque random value. Only its SHA-256 hash is stored (as a `RefreshToken` shape, through your app's storage — route it like `AuthCredential`). `validateToken` exchanges it for new tokens and **rotates** it: the old one stops working, and presenting it again revokes the session. Signing out revokes the session; a password reset revokes all of the account's sessions.

A refresh token is never accepted as an access token. Apps that verify tokens themselves should use `verifyAccessToken` from `@_linked/auth/utils/jwt` instead of `jwt.verify`.

Default lifetimes: the access token lasts **15 minutes** (1 hour in development) and the client refreshes it about a minute before it expires. A session ends after **7 days without a refresh** (idle timeout) and at the latest **60 days after sign-in** (absolute lifetime). Each refresh token expires at the earliest of `AUTH_REFRESH_TOKEN_TTL` (60 days, 30 in development), the idle timeout and the absolute lifetime.

### How tokens travel (browsers)

| Cookie (set by the server) | httpOnly | SameSite | Path | Lifetime |
|---|---|---|---|---|
| `accessToken` | yes | Lax | `/` | until the token's `exp` |
| `refreshToken` | yes | Strict | `/call/@_linked/auth` | until the stored record's expiry |
| `linkedAuthSession` (`1`, no secret) | no | Lax | `/` | as the refresh token |

- The access cookie authenticates full page loads (server-side rendering sets `request.linkedAuth` from it). The client also keeps the access token from the response body **in memory** and sends it as the `Authorization` header with `Server.call`.
- The refresh token is only sent to this package's endpoints and never appears in a response body a browser can read. `validateToken` reads it from the cookie and sets new cookies.
- `linkedAuthSession` lets the client know a session exists without exposing it, so anonymous page loads skip the refresh round trip.
- Signing out (and a failed refresh) clears all three.
- `Secure` is set when the request is https (`req.secure`) or `SITE_ROOT` is https. **Behind a TLS-terminating proxy, set `app.set('trust proxy', …)`** so `req.secure` (and `req.ip`) reflect the client connection.

### Two Linked apps on one host: a cookie prefix

Browsers do not separate cookies by port, so two Linked apps on one host (for example an app on `localhost:4040` developed against a local issuer on `localhost:4050`) would share `accessToken`, `refreshToken`, `linkedAuthSession` and the session cookie `linked.auth`: signing out of one would sign out the other. So every auth cookie carries a prefix of the app's own, and **by default there is nothing to set**: the prefix comes from the app's `APP_PREFIX` (every Linked app's `.env` has one), made a safe cookie-name token with `_` appended. `APP_PREFIX=webid-email` gives `webid-email_accessToken`, `webid-email_refreshToken`, `webid-email_linkedAuthSession` and `webid-email_linked.auth`; `APP_PREFIX=cn` gives `cn_…`. The token keeps letters, digits, `_`, `.` and `-`, turns every other run of characters into `-`, and trims `-`, `_` and `.` from both ends (`My App!` → `My-App_`).

The prefix in effect, first match wins:

1. `Auth.cookiePrefix = 'own_'` (from `@_linked/auth/utils/auth`) in the backend setup, before `setupBeforeControllers` runs; `Auth.cookiePrefix = ''` opts out of any prefix;
2. `AUTH_COOKIE_PREFIX=own_` in the server environment (read once; empty counts as unset), when you want a specific name;
3. `APP_PREFIX`, as above;
4. none: an app without `APP_PREFIX` keeps the plain names.

Prefixes may contain letters, digits, `_`, `.` and `-` only; an invalid `AUTH_COOKIE_PREFIX` throws.

**The browser bundle needs the same prefix**: the client reads `process.env.AUTH_COOKIE_PREFIX` and `process.env.APP_PREFIX` (resolved the same way) to find the `linkedAuthSession` hint, like the token lifetimes. Inline them into the client bundle through the Linked CLI's `createViteConfig({define})`, which lands on the client environment only (not a top-level Vite `define`, which the server would inherit). The simplest is to define the prefix the server resolves:

```ts
import {resolveCookiePrefix} from '@_linked/auth/utils/cookieNames';
createViteConfig({define: {'process.env.AUTH_COOKIE_PREFIX': JSON.stringify(resolveCookiePrefix(process.env))}});
```

Without it, a page load that was not server-rendered as signed in skips the refresh and shows the user signed out.

An issuer that reads the hint cookie uses its own prefixed name (`sessionHintCookieName()`). Changing the prefix of a running app (including setting `APP_PREFIX` for the first time, or upgrading to a release with this default while `APP_PREFIX` is set) signs its users out once: the old cookies are no longer read. `ACCESS_COOKIE`, `REFRESH_COOKIE` and `SESSION_HINT_COOKIE` (`@_linked/auth/utils/cookies`) are the base names; `accessCookieName()`, `refreshCookieName()` and `sessionHintCookieName()` give the names in use.

The client refreshes ~60 s before the access token's `exp`, again when the tab becomes visible or focused with a stale token, and once after a `Server.call` gets a 401 (then retries that call once). Concurrent refreshes share one request.

### Native apps

Call `setAuthTokenStorageMethods(get, set, remove)` (from `@_linked/auth/utils/token`) before rendering `ProvideAuth`. The client then sends `x-linked-auth-transport: body`, the server returns the refresh token in the response body, and both tokens are stored through your functions (`expires` in seconds). Other non-browser clients (scripts, tests) can send that header too. For WebID sign-in in a native app, see *Native apps (Capacitor)* under *Sign in through a Solid-OIDC issuer*.

## Upgrading to 3.4

> **Breaking: `removeAccount()` no longer answers a plain boolean.** It answers `true` when the
> account was deleted, and `{error, action, …}` otherwise. That object is truthy, so a truthy
> result no longer means deleted: compare `=== true`.
>
> ```ts
> // before (3.x): signs the user out even when nothing was deleted
> if (await auth.removeAccount()) signout();
>
> // after (3.4)
> const result = await auth.removeAccount({ password });
> if (result === true) signout();
> else showError(result.error);
> ```

3.4 is released as a minor version, so check every `removeAccount()` call when you upgrade. Most apps only need the first point below.

- **Deleting an account now needs proof.** `removeAccount()` with no argument fails with
  `{error, action: 'reauthenticate', methods}` for any account with a password or a linked
  Google/Apple identity. Temporary and dev accounts, and accounts with neither (e.g. Facebook-only
  or WebID-token accounts), still need only a session.
  - Apps that use `RemoveAccountButton` need no change for password accounts. If you offer Google
    or Apple sign-in, pass `getOAuthSource` (see *Delete account* below).
  - Apps with their own delete UI call `getReauthenticationMethods()` first and send
    `removeAccount({password})` or `removeAccount({provider, source})`.
  - The Google/Apple ID token must have been issued at most 10 minutes ago.
  - Apple's redirect (`form_post`) flow on the web cannot supply the proof, because the page
    state is lost on the redirect. Use Apple's popup mode.
- **Three new callable methods:** `verifyEmail` (`public`), `resendEmailVerification` (`user`) and
  `getReauthenticationMethods` (`user`). auth declares them itself. An app on
  `rpcExposure: 'enforce'` that pins auth's surface in its own table must add them, or a drift
  check against that table will refuse to start.
- **Sign-in and password reset no longer say whether an email is registered.** Sign-in answers
  "Invalid email / password combination." for an unknown email, an account without a password and
  a wrong password alike; it used to answer "This email is not registered" or "No password found
  for this email". `sendResetPasswordLink` answers `true` for every well-formed email. A UI that
  showed "not registered", or offered sign-up on that answer, should show the generic text instead
  (see *Sign-in and reset answers*).
- **Passwords have a minimum length** of 6 characters (`MIN_PASSWORD_LENGTH` from
  `@_linked/auth/helpers/password`), checked on the server for sign-up, reset and password change.
  A shorter one gets `{error: 'Password must be at least 6 characters', action: 'invalid_password'}`.
- **Email verification** (new, nothing to change): sign-up sends a verification link and the
  session reports `emailVerified`. Add the `/auth/verify-email` route (see *Setup Verify Email*)
  and register an email provider (see *Email configuration*).

## Upgrading from 1.x: migrate stored auth data

2.0 moves auth's ontology from `http://lincd.org/ont/auth/` to `https://linked.cm/ont/auth/`. Every auth class and property changed IRI, so credentials, refresh tokens and the synced shape descriptions written by 1.x are **invisible** to 2.0 until they are rewritten: every password sign-in fails as if the password were wrong ("Invalid email / password combination."). Nothing is lost; the data just has to be migrated once per dataset that auth shapes are stored in (wherever your storage config routes `AuthCredential`, `RefreshToken`, `Password`, `IdentityToken` and `Authentication`).

```ts
import {
  migrateAuthNamespace,
  hasLegacyAuthData,
} from '@_linked/auth/utils/migrateNamespace';

// `store` is the dataset itself (e.g. the FusekiStore), not a dataset router.
console.log(await migrateAuthNamespace(store, { dryRun: true })); // { before: N, after: N, ... }
console.log(await migrateAuthNamespace(store)); // { before: N, after: 0, dryRun: false }
```

1. Back up the dataset.
2. Deploy 2.0 and run `migrateAuthNamespace(store)` against each dataset holding auth data, from a one-off script or a deploy step. Users cannot sign in between the deploy and the migration, so run it straight away.
3. Check that `after` is `0`. Running it again is harmless: it reports `before: 0` and changes nothing.

The migration rewrites every IRI starting with the legacy namespace, in subject, predicate and object position, in the default graph and every named graph, in one SPARQL UPDATE request (one transaction on Fuseki). Literals are left alone.

To catch a dataset that was missed, call `hasLegacyAuthData(store)` at boot and warn (or refuse to start) when it returns `true`. It only looks up typed auth records, so it is cheap. `countLegacyAuthTriples(store)` scans the whole dataset.

## Installation

To integrate the Auth package, follow these steps:

1. Wrap your routes with `<ProvideAuth>` component. Define the `userType` and `accountType` and any additional `availableAccountTypes`.

```tsx
import { FreeAccount } from 'lincd-dating/lib/shapes/FreeAccount';
import { Person } from 'lincd-dating/lib/shapes/Person';
import { PaidAccountTier1 } from 'lincd-dating/lib/shapes/PaidAccountTier1';

<ProvideAuth
  userType={Person}
  accountType={FreeAccount}
  availableAccountTypes={[PaidAccountTier1]}
>
  {/* Your application code */}
</ProvideAuth>;
```

2. Set the environment variables `AUTH_ACCOUNT_TYPE` and `AUTH_USER_TYPE` to match the types imported in the `ProvideAuth` component.

```json
"AUTH_ACCOUNT_TYPE": "lincd-dating/lib/shapes/FreeAccount",
"AUTH_USER_TYPE": "lincd-dating/lib/shapes/Person",
```

3. Set the secrets. **Outside `NODE_ENV=development` or `test` the server refuses to start without them** (development falls back to insecure defaults and warns).

| Variable | Required | Meaning |
|---|---|---|
| `JWT_SECRET` | yes (outside development/test) | signs access tokens — `openssl rand -base64 48` |
| `SESSION_SECRET` | yes (outside development/test) | signs the session cookie — `openssl rand -base64 48` |
| `SITE_ROOT` | yes | the access token audience, and the base URL of the links in emails and of the Client ID Document |
| `AUTH_ACCESS_TOKEN_TTL` | no | access token lifetime in seconds (default 900; development 3600) |
| `AUTH_REFRESH_TOKEN_TTL` | no | refresh token lifetime in seconds (default 60 days; development 30) |
| `AUTH_SESSION_IDLE_TTL` | no | a session not refreshed for this long ends (default 7 days; `0` = off) |
| `AUTH_SESSION_MAX_TTL` | no | a session ends this long after sign-in (default 60 days; `0` = off) |
| `AUTH_PASSWORD_RESET_TTL` | no | how long a password reset link works, in seconds (default 3600). A link works once, and a newer link replaces it |
| `AUTH_EMAIL_VERIFICATION_TTL` | no | how long an email verification link works, in seconds (default 7 days). A link works once, and a newer link replaces it |
| `AUTH_SESSION_CLEANUP` | no | `false` stops the daily background cleanup of old `RefreshToken` records |
| `AUTH_SESSION_CLEANUP_AFTER` | no | how long revoked/expired records are kept before cleanup deletes them (default 30 days) |
| `AUTH_COOKIE_PREFIX` | no | prefix of every auth cookie name, when you want a specific one; unset or empty, the prefix is `APP_PREFIX` plus `_`, see *Two Linked apps on one host* above |
| `APP_PREFIX` | no | the app's identifier (set by every Linked app); gives the default cookie prefix (`webid-email` → `webid-email_`). Without it and without `AUTH_COOKIE_PREFIX`, cookie names have no prefix |
| `AUTH_COOKIE_SECURE` | no | `true`/`false` overrides the https detection |
| `AUTH_COOKIE_SAMESITE` | no | `lax`/`strict`/`none` for both token cookies (`none` forces Secure; for a frontend on another site) |
| `AUTH_COOKIE_DOMAIN` | no | cookie domain (default: the host) |
| `AUTH_REFRESH_COOKIE_PATH` | no | path of the refresh cookie (default `/call/@_linked/auth`; prefix it when the app is served under a path) |
| `AUTH_RATE_LIMIT` | no | `off` turns the rate limits off; see *Rate limits* below for per-limit settings |

4. If you offer Sign in with Apple or Google, set the client IDs that identity tokens must be issued to. **Without them that provider's sign-in is rejected** (fail closed): a token issued to any other app is never accepted.

| Variable | Meaning |
|---|---|
| `APPLE_CLIENT_ID` | the Services ID used for Sign in with Apple on the web (comma-separate several) |
| `APPLE_CLIENT_ID_IOS` | the app's bundle ID, for native Sign in with Apple (comma-separate several) |
| `GOOGLE_CLIENT_ID` | the Google OAuth web client ID |
| `GOOGLE_CLIENT_ID_IOS` | the Google OAuth iOS client ID |
| `GOOGLE_CLIENT_ID_ANDROID` | the Google OAuth Android client ID |
| `AUTH_APPLE_NONCE` | `optional` (default) or `required`; see *Apple sign-in nonce* below. Any other value counts as `required` |
| `AUTH_OAUTH_NONCE_TTL` | seconds a sign-in nonce can be redeemed (default 600) |

Old refresh token records are deleted by `cleanupExpiredSessions(store?, {olderThan})` from `@_linked/auth/utils/sessions`. The backend provider runs it in the background a few minutes after startup and then at most once a day per process; turn that off with `AUTH_SESSION_CLEANUP=false` when a separate job does it.

## How to use on Frontend

Import the useAuth hook in your page to access functions like `signin`, `validateToken`, and `signout`.

### Get user and userAccount

```tsx
import { useAuth } from 'lincd-auth/lib/hooks/useAuth';
import { FreeAccount } from 'lincd-dating/lib/shapes/FreeAccount';
import { Person } from 'lincd-dating/lib/shapes/Person';

const auth = useAuth<Person, FreeAccount>();
// Person Shapes
const user = auth.user;
// UserAccount Shapes
const userAccount = auth.userAccount;
```

### Signin with OAuth

```tsx
const auth = useAuth();
// Google: the ID token from Google Sign-In. Apple: the identity token (plus, on first consent,
// the givenName/familyName Apple hands the client).
const result = await auth.signinOAuth('google', { authentication: { idToken } });
if ('error' in result) {
  if (result.action === 'sign_in_to_link') {
    // An account with this email already exists, its email is not verified, and the provider
    // may not be attached to it on its own (it has a password, or another identity). Ask the user
    // to sign in the way they did before, then connect the provider from inside that session:
    //   await auth.linkOAuthIdentity('google', { authentication: { idToken } });
  }
  showError(result.error);
}
```

The server verifies the provider's token and finds the account from what the provider vouches
for, never from what the client sent:

1. An identity already linked to an account (provider + subject) signs in to that account while
   it keeps the email it was linked with. **The email decides, not the provider's subject:** when
   the provider's verified email has changed (a renamed Google Workspace account, say), the link
   is removed and the sign-in continues by the new email (steps 2–4), so it never reaches the old
   account again. A token without a verified email (Apple sends none on some sign-ins) follows its
   link.
2. Otherwise the verified email is resolved through the current email-derived WebID,
   `UserAccount.email`, and `AuthCredential.email`. The latter two keep accounts created with an
   older, application-specific Person WebID reachable after upgrading Auth. If those identifiers
   point to several people or accounts, sign-in fails closed with `action: 'account_conflict'`.
3. One unambiguous account is reached only when the provider verifies the email (Google, Apple),
   and then:
   - **always when the account's email is verified too** (a verification link, a sign-in code,
     an earlier provider sign-in): one verified email is one account, whatever sign-in methods it
     already has, a password included;
   - otherwise only when the account has **no password** and is not linked to a provider without
     verified emails or to a different identity at the same provider. A password account can be
     created before its email is verified (see *Email verification*), so it may have been
     registered by someone else in advance; attaching to it by email would hand them the user's
     sign-in.

   Anything else answers `{error, action: 'sign_in_to_link'}`. A different email never reaches
   the account, and neither does an email the provider has not verified.
4. Otherwise a new account is created, without a password.

Each sign-in that reaches an account stores a link (`IdentityToken` with `sub`,
`identityProvider` and the provider's verified `email`; `linkOAuthIdentity` stores the same, so a
provider connected with another address, such as Apple's private relay, keeps signing in while
the provider keeps that address). A link written before 3.14 has no `email`: it is followed while
the provider's email still resolves to its account (step 2), and gets the email recorded.
The provider's token itself is never stored. Links written before 3.0.7
carry no provider (they are Apple links) and may hold the raw Apple identity token; it is removed
the next time that user signs in. To remove all of them at once:

```sparql
PREFIX auth: <https://linked.cm/ont/auth/>
DELETE { GRAPH ?g { ?t auth:token ?v } } WHERE { GRAPH ?g { ?t a auth:IdentityToken ; auth:token ?v } }
```

#### Apple sign-in nonce

Ask the server for a nonce before starting Sign in with Apple, give it (or its SHA-256, hex) to
Apple as the request's `nonce`, and send the raw nonce back with the identity token:

```tsx
const { nonce } = await auth.createOAuthNonce();
// native: pass sha256hex(nonce) to Apple; Apple JS: pass nonce as is
const result = await auth.signinOAuth('apple', { identityToken, nonce });
```

The server checks that it issued the nonce (it is signed with `JWT_SECRET`), that it has not
expired, that the token's `nonce` claim carries it, and that it was never used before (a used
nonce is recorded as `UsedOAuthNonce` until it expires). A stolen identity token is then useless
without its nonce and can never sign in twice. Issuing a nonce stores nothing.

With `AUTH_APPLE_NONCE=optional` (the default) a sign-in that sends no nonce is still accepted,
so existing clients keep working while they are updated; it has no replay protection. Set
`AUTH_APPLE_NONCE=required` once every client sends one. A nonce the client made up itself is
always rejected.

`AuthCredential.userHasPassword()` tells whether the signed-in user can sign in with a password
(an OAuth-only account cannot).

### Sign out

Signing out revokes the session on the server, which also clears the auth cookies (native apps: the tokens are removed from storage), so its refresh token can no longer be used. (The access token itself stays valid until it expires — at most 15 minutes by default.)

```tsx
import {useAuth} from 'lincd-auth/lib/hooks/useAuth';
import {Person} from 'lincd-dating/lib/shapes/Person';
import {FreeAccount} from 'lincd-dating/lib/shapes/FreeAccount';


const auth = useAuth<Person, FreeAccount>();
<button onClick={() => auth.signout()}>
```

### Validate Token

If you want to redirect the user to specific pages upon authentication, you can use the `validateToken` function.

```tsx
useEffect(() => {
  const validateToken = async () => {
    const validToken = await auth.validateToken();
    if (validToken) {
      // navigate when the token is valid
    } else {
      // navigate to the signin page
    }
  };
  validateToken();
}, []);
```

### Sign-in and reset answers

Sign-in and password reset give the same answer whether or not an account exists for the email,
so they cannot be used to find out who has an account:

- `signinWithPassword` answers `{error: 'Invalid email / password combination.'}` for an unknown
  email, an account without a password (OAuth-only) and a wrong password. The paths without a
  password hash still run one bcrypt compare, so they take about as long as a wrong password.
- `sendResetPasswordLink` answers `true` for every well-formed email, whether or not an account
  exists and whether or not the email could be sent. `ForgotPasswordForm` shows "If an account
  exists for this email, we've sent a link." Show the same in a custom form.
  - Known limit: for a real account the server stores a reset token and sends the email before
    it answers, so the answer takes measurably longer than for an unknown email. This is
    accepted: the `passwordResetRequest` limits (3 per hour per email, 10 per hour per IP) make
    testing emails by timing slow.

Sign-up still answers "This email address is already in use" when a person, account or credential
exists for the email: it signs the user in at once, so it cannot give one answer for both cases.
It is rate limited to 10 per hour per IP (`signup`), which makes it a slow way to test emails.

### Sign in with an emailed code

A passwordless method next to password: the user types their email, gets an eight-digit code and a
link carrying it, and signs in with either. The code in the email lets a link opened on one device
be typed on another. Signing in with a code proves control of the email, so it is marked verified,
and an email without an account gets one (the person at the WebID `Auth.webIdFor` derives, and
its account).

```tsx
const auth = useAuth();

const sent = await auth.sendSigninCode(email); // true, or {error, action?, retryAfter?}
// ...the user types the code from the email
const result = await auth.signinWithCode(email, code);
if ('error' in result) showError(result.error); // action: 'invalid_code' | 'rate_limited'
```

- `sendSigninCode(email)` answers `true` for every well-formed email, account or not, and whether
  or not the email could be sent, like `sendResetPasswordLink`. A new request replaces the earlier
  code.
- `signinWithCode(email, code)` checks the code against the email it was sent to. Case and
  surrounding spaces in the email, and spaces or dashes in the code, are ignored. A wrong,
  expired or already used code, or a code for another email, all answer `{error: 'This sign-in
  code is invalid or has expired.', action: 'invalid_code'}`. A wrong code, or one tried with
  another email, leaves the right one working; an expired one is used up.
- The code works once, for `AUTH_SIGNIN_CODE_TTL` seconds (default 15 minutes). The person's
  `AuthCredential` stores only a hash of an HMAC of the email and code, keyed with a key derived
  from `JWT_SECRET`, so a copy of the store does not give the codes away (a new `JWT_SECRET` ends
  outstanding codes). An email with no account keeps its code on a pending credential, which has
  no person and stores only the keyed hash of the email (`signinCodeEmailHash`), so signup,
  password sign-in, reset and OAuth never see it; the first sign-in attaches it to the person:
  one that has the email by then, or a new one. Pending credentials of codes that were never used
  are not removed yet ([backlog 004](docs/backlog/004-signin-code-hardening.md)).
- **The first proof of an email ends unproven access.** Sign-up does not verify the email, so
  someone may have registered the owner's email with a password of their own, waiting for the
  owner. When a code sign-in reaches a person whose email was not verified yet, that person's
  password hashes are removed and every session of their accounts is revoked, before the new
  session starts. The owner can set a password through a reset link.
- Eight digits are guessable without a limit: `signinWithCode` allows 5 attempts per email per 15
  minutes (`signinCode`), from any number of addresses, and `sendSigninCode` 3 requests per email
  per hour (`signinCodeRequest`). A wrong guess does not end the code, so the per-email limit is
  the only bound on guessing: **do not turn `signinCode`'s account limit off**
  (`AUTH_RATE_LIMIT_SIGNIN_CODE_ACCOUNT`) without first ending codes after a few wrong guesses.
  See *Rate limits*.
- The link is `${SITE_ROOT}/auth/signin-code?email=…&code=…`. Render `SigninWithCodeForm` at that
  route (see *Setup sign-in by code*): it shows the code filled in, asks the user to type their
  email, and signs in when they press Sign in. Elsewhere it is the form that asks for the email
  and then the code, showing the email the code was sent to.

### Email verification

Verification is a **soft flag**: sign-up signs the user in at once, as before, and sends a
verification link. Nothing in auth is blocked for an unverified account. **Each app decides what
an unverified account may not do.**

- `useAuth().emailVerified` on the client, `request.linkedAuth.emailVerified` on the server.
  It is read from the store when the session is built (sign-in and refresh), so the access token
  can be stale for up to one refresh. Before a sensitive action, re-check on the server with
  `personEmailVerified(personId)` from `@_linked/auth/helpers/emailVerification`.
- The link is `${SITE_ROOT}/auth/verify-email?token=…`. The app needs a route there that renders
  `VerifyEmailCallback` (see *Setup Verify Email*). The link works once, for
  `AUTH_EMAIL_VERIFICATION_TTL` seconds (default 7 days); only a hash of the token is stored.
- An email also counts as verified after a completed password reset (the link came from the
  inbox), after a sign-in with an emailed code, and after a Google or Apple sign-in whose email
  the provider has verified.
- Dev accounts (`signinDev`) normally report `emailVerified: false`.

```tsx
const auth = useAuth();

if (!auth.emailVerified) {
  // e.g. a banner with a "send the link again" button
  const result = await auth.resendEmailVerification();
  if ('sent' in result) showInfo('We sent you a new link.');
  else if ('verified' in result) showInfo('Your email is already verified.');
  else showError(result.error); // action: 'no_email' | 'rate_limited' | 'email_failed'
}
```

`resendEmailVerification` needs a session, sends to the account's email and replaces any earlier
link. `verifyEmail(token)` needs no session and signs no one in; when the user is signed in,
`useAuth().verifyEmail` refreshes the session so `emailVerified` turns true at once. An invalid or
expired token answers `{error, action: 'resend_verification'}`.

### Delete account

`RemoveAccountButton` asks for proof in its confirm dialog before it deletes the account:

- an account with a password gets a password field;
- an account without a password but with a linked Google/Apple identity gets "Confirm with
  Google/Apple", which calls your `getOAuthSource(provider)`;
- temporary and dev accounts, and accounts with no password and no Google/Apple link (e.g.
  Facebook-only or WebID-token accounts), have nothing to check and are deleted with a plain
  confirm, on the session alone.

auth does not ship the provider SDKs. `getOAuthSource` runs the provider's sign-in and resolves to
what `signinOAuth` takes as its second argument, so pass the same function your sign-in buttons
use:

```tsx
import { RemoveAccountButton } from '@_linked/auth/components/RemoveAccountButton';

// The helper behind your sign-in buttons: runs the provider (popup or native) and returns
// signinOAuth's second argument.
async function getOAuthSource(provider: 'google' | 'apple') {
  if (provider === 'google') {
    const idToken = await getGoogleIdToken(); // Google Identity Services / native Google sign-in
    return { authentication: { idToken } };
  }
  const { nonce } = await auth.createOAuthNonce();
  // Apple JS in popup mode: AppleID.auth.init({..., usePopup: true, nonce})
  const identityToken = await getAppleIdentityToken(nonce);
  return { identityToken, nonce };
}

// sign-in
await auth.signinOAuth(provider, await getOAuthSource(provider));

// account deletion
<RemoveAccountButton getOAuthSource={getOAuthSource} />;
```

The ID token must have been issued **at most 10 minutes** before the delete, it is verified as
`signinOAuth` verifies it, and its subject must be linked to the signed-in account. A fresh token
is the "recent sign-in" check. **Apple's redirect (`form_post`) flow on the web cannot be used
here**: the page, and the delete in progress, are gone when Apple redirects back. Use popup mode.

A custom delete UI asks first what the account confirms with, then sends the proof in the same
call:

```tsx
const { methods } = await auth.getReauthenticationMethods(); // ['password'] | ['google', 'apple'] | []

const result = methods.includes('password')
  ? await auth.removeAccount({ password })
  : methods.length
    ? await auth.removeAccount({ provider: methods[0], source: await getOAuthSource(methods[0]) })
    : await auth.removeAccount();

if (result !== true) {
  // action: 'reauthenticate' (missing or wrong proof; result.methods lists what to ask for)
  // or 'rate_limited'
  showError(result.error);
}
```

Without a proof, or with a wrong one, `removeAccount` answers `{error, action: 'reauthenticate',
methods}` and deletes nothing. Checking a proof is rate limited (`reauthenticate`).

## How to use on Backend

When a user is authenticated, the request on the server will be updated. This example usage of retrieving user information from the request in the backend.

```tsx
import { BackendProvider } from 'lincd-server-utils/lib/utils/BackendProvider';
import { Person } from 'lincd-dating/lib/shapes/Person';
import { FreeAccount } from 'lincd-dating/lib/shapes/FreeAccount';

export default class SPBackendProvider extends BackendProvider {
  getProfiles() {
    // get linkedAuth from request
    const auth = this.request.linkedAuth;

    // if the user has successfully signed in, "auth" will be available.
    // and if not, return false.
    if (!auth) {
      console.warn('No user authenticated.');
      return false;
    }

    const user = auth.userAccount.accountOf as Person;
    const userAccount = auth.userAccount as FreeAccount;

    // now you can use 'user' and 'userAccount' in your backend logic
    // ...
  }
}
```

### WebID derivation

Sign-in methods that start from an email (password, sign-up, reset links, Google/Apple/Facebook)
turn it into the user's WebID, the IRI of their Person, with `Auth.webIdFor(email)`. The default is
`emailToWebID`: a UUID v5 under `https://webid.email/id/`, so an app that sets nothing keeps the
WebIDs it has.

An app that derives WebIDs another way sets `Auth.webIdFor` once in its backend setup, before
requests are served. `@_linked/auth/utils/webID` exports the keyed rule webid.email mints WebIDs
with:

```ts
import { Auth } from '@_linked/auth/utils/auth';
import { hmacWebIdFor } from '@_linked/auth/utils/webID';

// {issuer}/id/{h}#me, h = first 128 bits of HMAC-SHA256(secret, trim(lowercase(email))) as hex
Auth.webIdFor = hmacWebIdFor({ secret: process.env.WEBID_SECRET, issuer: 'https://webid.email' });
```

- `hmacWebId(email, {secret, issuer})` is the same rule as a plain function. Both throw on an empty
  secret or issuer and on an issuer ending in `/`; `hmacWebIdFor` checks them when it is called, so
  a misconfigured app fails at startup. They run on the server only.
- The secret is permanent: changing it changes every WebID derived with it. Without it nobody can
  turn an email into a WebID.
- `HMAC_WEBID_TEST_VECTOR` (`{email, secret, issuer, webId}`, with the local dev secret
  `local-dev-webid-secret` and issuer `http://localhost:4050`) is the published example every
  implementation of the rule asserts.
- Changing the derivation of an app that already has users changes their WebIDs: their existing
  Person IRIs need migrating.

### Issuer discovery

For WebID sign-in, `@_linked/auth/utils/issuerDiscovery` finds the Solid-OIDC issuer that signs a
user in, from the email or WebID they typed. Nothing in auth calls it yet; it is server-only.

```ts
import { createIssuerDiscovery } from '@_linked/auth/utils/issuerDiscovery';

const discovery = createIssuerDiscovery({ defaultIssuer: 'https://webid.email' });

await discovery.discover('rene@semantu.com');
// { ok: true, source: 'webfinger', issuer: 'https://login.semantu.com', issuers: [...], loginHint: 'rene@semantu.com' }
await discovery.discover('https://pod.example/profile/card#me');
// { ok: true, source: 'webid', issuer: 'https://pod.example', issuers: [...], webId: '…#me' }
```

- **A WebID** (an `http(s)` URL): its profile is fetched (Turtle preferred, JSON-LD read with
  inline contexts only; a remote `@context` is never fetched) and `solid:oidcIssuer` of that WebID
  is read. The reader may miss an issuer but never reads one the profile does not assert for that
  WebID: statements in named graphs, values under scoped contexts and plain JSON-LD strings not
  coerced with `@type: @id` are ignored, and a JSON-LD document too costly to read has no issuers. A WebID never falls back: no issuer gives `{ok: false, reason: 'no-issuer'}`, a profile
  that cannot be fetched `'unreachable'`, a URL that may not be fetched `'refused'`.
- **An email**: `GET https://<domain>/.well-known/webfinger?resource=acct:<email>`. An issuer link
  (`http://openid.net/specs/connect/1.0/issuer`) gives `source: 'webfinger'`; a WebID link
  (`http://www.w3.org/ns/solid/terms#webid`) is read as above and gives `'webfinger-webid'`.
  Anything else gives `source: 'fallback'` with the default issuer and a `reason`: `skipped` (the
  domain is on the skip list, nothing was requested), `no-answer`, `timeout`, `error` or
  `webid-without-issuer`. `loginHint` is the email trimmed and lowercased.
- Results are returned, never thrown, and frozen. `issuer` is the first of `issuers`, as written
  in the source (an issuer is compared with a token's `iss` exactly).

Options (all optional; the module reads no environment variables):

| Option | Default | |
|---|---|---|
| `defaultIssuer` | `https://webid.email` | Issuer for emails whose domain gives no answer. Checked at setup |
| `skipDomains` | `DEFAULT_SKIP_DOMAINS` | gmail.com, outlook.com, icloud.com, … : straight to the default issuer |
| `timeoutMs` | `3000` | Deadline per request, redirects included (an email whose WebFinger names a WebID makes two requests) |
| `maxResponseBytes` | `262144` | A larger answer counts as none |
| `cacheTtlMs` / `negativeCacheTtlMs` | 10 min / 5 min | Answers / no-answers; a domain that timed out or was unreachable is not asked again for `negativeCacheTtlMs`. Concurrent lookups of one email or WebID share a request |
| `cacheMaxEntries` | `1000` | Oldest entry goes first |
| `allowLocalhost` | `false` | Also fetch `http://` and loopback hosts, for development (an issuer on `http://localhost:4050`) |
| `fetch` | global `fetch` | Replaces it (tests, a custom agent) |

The URLs come from user input, so only `https://` is fetched, IP literals in private, link-local,
unique-local, multicast and IPv4-carrying IPv6 ranges (NAT64, 6to4) are refused, redirects (at most 3) are checked hop by hop, and issuer or
WebID links that fail these checks are ignored. The module does not resolve host names itself;
pass `fetch: createGuardedFetch({allowLocalhost})` from `@_linked/auth/utils/guardedFetch` (as the
Solid-OIDC sign-in below does) so a public name that resolves, or rebinds, to a private address is
refused before a connection. `fetchOidcIssuers(webId, options)` reads a profile's issuers without the cache, and
`readOidcIssuers(body, contentType, documentUrl, webId)` reads them from a document already
fetched.

### Client ID Document

An app that signs users in through a Solid-OIDC issuer (webid.email, or a user's own) serves a
Client ID Document: the issuer fetches it to learn the app's name, its redirect URIs and how to
style the sign-in page. Set `Auth.signinClient` once in the backend setup, before
`setupBeforeControllers` runs, and auth serves the document at
`{SITE_ROOT}/.well-known/linked-client.jsonld`. Without it nothing is served there.

```ts
import { Auth } from '@_linked/auth/utils/auth';

Auth.signinClient = {
  clientName: 'Create.Now',
  logoUri: 'https://create.now/logo.svg',
  policyUri: 'https://create.now/privacy', // also clientUri (default SITE_ROOT) and tosUri
  redirectUris: ['com.example.app:/callback'], // optional, e.g. app-claimed links of native builds
  theme: {
    layout: 'two-column', // or 'card'
    colors: { primary: '#1a73e8', accent: '#ff8000', background: 'white', panel: '#0b1020', text: '#222' },
    font: 'Inter',
    scheme: 'light', // or 'dark'
    brand: { name: 'Create.Now', logoUri: 'https://create.now/logo.svg' },
    panelArt: 'https://create.now/art/bow.svg', // an image or animated SVG, shown as an <img>
  },
};
```

- The `client_id` is the document's own URL; `redirect_uris` starts with
  `{SITE_ROOT}/auth/oidc/callback`. The document also declares a public client
  (`token_endpoint_auth_method: none`, the code flow, scope `openid webid email`).
- `SITE_ROOT` loses one trailing slash and may not have a query or fragment. It and the configured
  `logoUri`, `clientUri`, `policyUri` and `tosUri` must be `https:`; `http:` is allowed only on
  `localhost`. Extra `redirectUris` may also use an app's own scheme, but never `javascript:`,
  `data:`, `file:`, `blob:` or `vbscript:`. Anything else stops the server at startup.
- The theme sits under the key `https://linked.cm/ns/signin#theme`, which other issuers ignore.
  Every field is optional. Colours are plain CSS colours: hex, `rgb()`/`hsl()` with numbers, or a
  lowercase named colour; never `url(` or `var(`. Fonts come from `SIGNIN_THEME_FONTS`: `system-ui`,
  Inter, Roboto, Open Sans, Lato, Montserrat, Source Sans 3, Nunito, Poppins, Work Sans,
  Merriweather, Lora, Playfair Display. Logo and panel art URLs follow the `https:` rule, may not
  contain whitespace, quotes, angle brackets, parentheses, backticks or backslashes, and are kept
  in their normalised form. The issuer enforces the art's size limits.
- At startup an invalid theme value is logged (`[auth] Client ID Document: dropped theme value …`)
  and left out of the document; the rest is served.
- It is served as `application/ld+json` with `Cache-Control: public, max-age=600`.

`@_linked/auth/utils/clientIdDocument` holds the definition of the theme, for issuers that render
it: the `SigninTheme` type, `SIGNIN_THEME_JSON_SCHEMA`, `SIGNIN_THEME_FONTS`, and
`validateClientTheme(doc)`, which reads the theme of a fetched document and returns
`{theme, problems}`: the valid values, and each dropped one with its path and reason. It never
throws. `buildClientIdDocument(config, siteRoot)` builds the document itself. The module imports
neither Express nor Node built-ins.

### Sign in through a Solid-OIDC issuer

An app can sign users in with their WebID: the user types an email or a WebID, the browser goes to
their issuer (webid.email by default, or the one their WebID or email domain names), and comes back
signed in. It is a method next to the others, ending in the same step: the verified WebID is the
Person's IRI, which gets a `UserAccount` and a session. The issuer's tokens are not kept.
Opt in with `Auth.oidcSignin`, next to `Auth.signinClient` (the Client ID Document above):

```ts
import { Auth } from '@_linked/auth/utils/auth';

Auth.signinClient = { clientName: 'Create.Now' };
Auth.oidcSignin = {
  // all optional:
  defaultIssuer: 'https://webid.email', // for emails whose domain names no issuer
  allowLocalhost: false, // true for a local issuer such as http://localhost:4050
  requireEmail: false, // refuse issuers that send no email claim
  onEmailMismatch: async ({ hinted, returned, hasAccount }) =>
    (await hasAccount(hinted)) && !(await hasAccount(returned)) ? 'refuse' : 'signin',
  onResult: (outcome) => (outcome.ok ? '/dashboard' : undefined),
};
```

**Start.** The client calls `startOidcSignin({input?, prompt?, providerHint?, returnTo?})`
(`Server.call('@_linked/auth', 'startOidcSignin', …)`) and navigates to the `url` it returns.

- `input` is an email or a WebID. A WebID's profile names its issuer. For an email, its domain's
  WebFinger answer does, else the default issuer gets the email as `login_hint` (see Issuer
  discovery).
- `input` may be left out when a `providerHint` is given: a "Continue with Google" button needs no
  email first. The sign-in starts at the default issuer with `provider_hint` and no `login_hint`,
  and the provider decides the email (so no mismatch can be reported).
- An issuer must be an `https:` URL with no query, no fragment and no `/.well-known/` (a
  profile or WebFinger answer naming anything else gets `invalid_issuer`), and its metadata must
  name exactly that issuer.
- `prompt: 'none'` asks for a silent sign-in. `providerHint` (letters, digits, `-`, `_`) is sent as
  `provider_hint`, e.g. `google`. `returnTo` is a path on this site (`/…`; anything else is
  ignored).
- The request uses the code flow with PKCE (`S256`), `state` and `nonce`. A fresh DPoP key's
  thumbprint is sent as `dpop_jkt`, and the scope is `openid webid email`. The `client_id` is
  `{SITE_ROOT}/.well-known/linked-client.jsonld`, or `clientId` when set.
- The pending sign-in (PKCE verifier, nonce, DPoP key, hinted email, `returnTo`) is kept in the
  browser's server-side session (express-session), keyed by `state`: at most 5 at once, for
  10 minutes.
- Failures come back as `{error, action}`, with `action` one of:
  - `not_configured`;
  - `invalid_input`;
  - `issuer_not_found` (a WebID whose profile names no usable issuer);
  - `invalid_issuer`;
  - `issuer_unreachable`;
  - `no_session`;
  - `rate_limited`.

**Callback.** The issuer sends the browser to `GET {SITE_ROOT}/auth/oidc/callback`:

1. The pending sign-in is taken from the browser's session by `state`, once. A callback opened in
   another browser, replayed, or older than 10 minutes ends in `invalid_state`.
2. The code is exchanged with a DPoP proof. The ID token's signature is checked against the
   issuer's JWKS, and its `iss`, `aud`, `exp`, `iat` and `nonce` are checked; `iss` must be the
   issuer the user was sent to.
3. `webid` and `auth_time` are required, and so is `email` with `requireEmail`.
4. The issuer check: `iss` must be a `solid:oidcIssuer` in the `webid`'s profile (one trailing
   slash is ignored). The profile is not fetched when the issuer is the root of the WebID's origin
   (`https://webid.email` for `https://webid.email/id/…`); an issuer with a path is always checked.
5. When the user typed one email and the token carries another, `onEmailMismatch` decides:
   `'signin'` (the default: the returned email wins) or `'refuse'`. Its `hasAccount(email)` looks
   accounts up inside the callback; it is never callable.
6. The person at the WebID and its account are found or created, and a session starts as for the
   other methods (cookies). The token's email is trusted only when it proves the WebID: the issuer
   verified it and it is the email this WebID derives from (`Auth.webIdFor`). Only then is it
   stored on a new account and marked verified, since any issuer can claim any email for its own
   WebIDs. A sign-in to a person with a password but no verified email removes that password and
   its sessions, as a code sign-in does.
7. The browser is redirected to `onResult(outcome)`'s answer. The default is the start's
   `returnTo` (or `/`), or `/signin?oidc_error=<error>` on failure. No email goes into the URL.
   `outcome` is `{ok: true, webId, issuer, email?, emailProven, isNewAccount, returnTo?, mismatch?}`
   or `{ok: false, error, returnTo?, mismatch?}`, where `mismatch` is `{hinted, returned}` and
   `email` is what the issuer claims (trust it only with `emailProven`).

The callback's error codes:

| `error` | Meaning |
|---|---|
| `login_required`, `interaction_required` | A silent sign-in that needs the user |
| `access_denied` | The user or the issuer refused |
| `issuer_unreachable` | The issuer's metadata, keys or token endpoint could not be reached |
| `issuer_refused` | The WebID's profile does not name the token's issuer, or cannot be read |
| `invalid_token` | A check on the ID token failed |
| `missing_claim` | No `webid`, no `auth_time`, or no `email` with `requireEmail` |
| `invalid_state` | No pending sign-in for this browser and `state` |
| `email_mismatch` | `onEmailMismatch` refused |
| `rate_limited` | Too many callbacks from this IP |
| `failed` | Anything else |

Every request to an issuer, a profile or a WebFinger endpoint goes through `createGuardedFetch`.
It allows only `https:` (`http:` and loopback with `allowLocalhost`). Host names are resolved and
refused when any address is private; the connection goes to the addresses that were checked; and
redirects are not followed. Every response body is capped (`maxResponseBytes`, 1 MB) and the whole
response must arrive in time (`responseTimeoutMs`, 10 s). At startup the server stops (`FatalConfigError`) without a `client_id`
(neither `Auth.signinClient` nor `clientId`) or when `SITE_ROOT` is not `https:` (`http:` only on
localhost).

The exchange itself is `createOidcRelyingParty({clientId, redirectUri, …})` from
`@_linked/auth/utils/oidcSignin`, with `begin` and `complete`. It is free of Express and the
store, and its results are returned, never thrown.

#### Native apps (Capacitor)

A native build signs in the same way, following RFC 8252: the issuer opens in the **system
browser**, never a WebView (`ASWebAuthenticationSession` on iOS, Custom Tabs on Android), and comes
back through a link the app claims. The system browser shares no cookie with the app, so the
server keeps nothing between the two steps: the pending sign-in (PKCE verifier, nonce, DPoP key,
hinted email, issuer, redirect URI) is sealed by the server (AES-256-GCM, a key derived from
`JWT_SECRET`) and held on the device, in the token storage the app registered.

```ts
import { setOidcSigninBrowser } from '@_linked/auth/utils/nativeOidcSignin';
import { setAuthTokenStorageMethods } from '@_linked/auth/utils/token';

setAuthTokenStorageMethods(get, set, remove); // as for every native app (see Native apps above)
setOidcSigninBrowser(openSystemBrowser); // see the two recipes below

// in a component
const auth = useAuth();
const answer = await auth.startNativeOidcSignin({
  input: 'ada@example.com', // an email or a WebID; may be left out with a providerHint
  redirectUri: 'https://example.com/auth/oidc/native', // one of Auth.signinClient.redirectUris
  // prompt: 'none', providerHint: 'google'
});
// signed in: answer.auth, answer.outcome; or {waiting: true, state}; or {error, action}
```

1. `startNativeOidcSignin` calls the server's `startNativeOidcSignin` RPC, which finds the issuer and
   answers `{url, state, pending}` (`pending` is the sealed record). The client keeps
   `{state, pending}` under the storage key `oidcPending` for 10 minutes; a new start replaces it.
2. It opens `url` with the function given to `setOidcSigninBrowser(open)`. `open(url, {redirectUri})`
   resolves to the URL the issuer returned to, or to nothing when that link reaches the app through
   its URL listener instead; it rejects when the user cancels (`browser_failed`, and the record is
   removed).
3. `completeOidcSignin(callbackUrl)` (also on `useAuth`) reads `state` from the URL. A URL whose
   `state` is not the pending one is refused on the device (`invalid_state`) without a call, and
   the pending sign-in stays. Otherwise the record is removed (it is used once) and the server's
   `completeNativeOidcSignin` RPC runs the callback's steps 2–6 above. It answers with the session's
   tokens in the body, which are stored with the app's token storage, and with `outcome`.
   Failures are `{error, action, outcome}`, `action` being the callback's error codes.
   `onEmailMismatch` applies; `onResult` is not called, since nothing is redirected.

Both RPCs answer `not_native` to a caller that does not send `x-linked-auth-transport: body`
(the header a client with registered token storage sends): a web page cannot send it to another
site, so it cannot sign its visitor in to an account it chose (login CSRF). The server opens the
record only when it is intact and younger than 10 minutes, when the callback
URL is the record's redirect URI (scheme, host and path) with its `state`, and while that redirect
URI is still configured. Start errors add `invalid_redirect_uri` to the web start's list: the
`redirectUri` must be one of `Auth.signinClient.redirectUris`, written as a URL parser writes it
(`https://example.com/auth/oidc/native`, not `https://Example.com/...`), with no query or fragment.
The web callback `{SITE_ROOT}/auth/oidc/callback` is never a native redirect URI.

**The system browser.** auth does not pin a plugin; the app passes `open`:

- **A plugin that resolves to the callback URL** (an `ASWebAuthenticationSession` wrapper on iOS):
  the sign-in completes inside `startNativeOidcSignin`. For a Universal Link, iOS 17.4 and later
  match an `https:` callback (`ASWebAuthenticationSession.Callback.https(host:path:)`, which needs
  the `webcredentials:` associated domain below); earlier versions match only a custom scheme.

  ```ts
  setOidcSigninBrowser((url, { redirectUri }) => AuthSession.start({ url, callback: redirectUri })); // your plugin
  ```

- **A browser tab whose link arrives through the app** (Custom Tabs on Android, with
  `@capacitor/browser` and `@capacitor/app`): `open` resolves to nothing and the app's
  `appUrlOpen` listener completes the sign-in.

  ```ts
  import { Browser } from '@capacitor/browser';
  import { App } from '@capacitor/app';

  setOidcSigninBrowser(async (url) => {
    await Browser.open({ url });
  });
  // where useAuth is available, once
  App.addListener('appUrlOpen', async ({ url }) => {
    if (!url.startsWith('https://example.com/auth/oidc/native')) return;
    await Browser.close().catch(() => {});
    const answer = await auth.completeOidcSignin(url);
  });
  ```

**App-claimed links.** List every link the app returns through in the Client ID Document, next to
the web callback:

```ts
Auth.signinClient = {
  clientName: 'Example',
  redirectUris: [
    'https://example.com/auth/oidc/native', // Universal Link (iOS) and App Link (Android)
    'com.example.app:/oidc/callback', // optional custom scheme (RFC 8252 §7.1), reverse domain
  ],
};
```

Prefer the `https:` link: only the domain's owner can claim it, while another app can register the
same custom scheme (PKCE and the device-held DPoP key keep an intercepted code useless, but the
sign-in then fails). Use a path of its own, not `/auth/oidc/callback`. When the app is not installed
the link opens in the browser, so serve a page there that says to open the app.

The domain proves the claim with two files at `https://<domain>/.well-known/`, served with
`Content-Type: application/json`, over `https:`, without redirects. auth does not serve them; the
app does (the token check already skips `/.well-known/`).

`apple-app-site-association` (no file extension):

```json
{
  "applinks": {
    "details": [
      {
        "appIDs": ["<TEAM_ID>.<BUNDLE_ID>"],
        "components": [{ "/": "/auth/oidc/native", "comment": "WebID sign-in" }]
      }
    ]
  },
  "webcredentials": { "apps": ["<TEAM_ID>.<BUNDLE_ID>"] }
}
```

The iOS app has the Associated Domains capability with `applinks:<domain>` and
`webcredentials:<domain>` (entitlement `com.apple.developer.associated-domains`). A custom scheme
goes in `Info.plist` under `CFBundleURLTypes`.

`assetlinks.json`:

```json
[
  {
    "relation": ["delegate_permission/common.handle_all_urls"],
    "target": {
      "namespace": "android_app",
      "package_name": "<PACKAGE_NAME>",
      "sha256_cert_fingerprints": ["<SIGNING_CERT_SHA256>"]
    }
  }
]
```

The Android app's `AndroidManifest.xml` has, on its main activity, an intent filter with
`android:autoVerify="true"`, the action `android.intent.action.VIEW`, the categories `DEFAULT` and
`BROWSABLE`, and `<data android:scheme="https" android:host="<domain>" android:path="/auth/oidc/native" />`
(a custom scheme: a second filter with `android:scheme="com.example.app"`).

What the app owner supplies:

| Value | Where it comes from | Where it goes |
|---|---|---|
| Hosting domain | the `https:` domain the app's link is on, usually the app's `SITE_ROOT` domain | the link in `redirectUris`; `applinks:` and `webcredentials:` entries; the Android intent filter's `host`; where both files are served |
| Bundle ID | Xcode target, e.g. `com.example.app` | `appIDs` and `webcredentials.apps` as `<TEAM_ID>.<BUNDLE_ID>` |
| Team ID | Apple Developer account, Membership (10 characters) | the same prefix |
| Package name | Android `applicationId`, e.g. `com.example.app` | `package_name` |
| Signing certificate SHA-256 | Play Console, App integrity, App signing key certificate (also the upload key's, for builds you install yourself; `keytool -list -v -keystore …` for a local key) | `sha256_cert_fingerprints`, colon-separated hex, one entry per key |
| Custom scheme (optional) | the reverse of a domain the owner controls | `redirectUris`, `CFBundleURLTypes`, the second intent filter |

`@_linked/auth/utils/nativeOidcSignin` holds the client side (`setOidcSigninBrowser`,
`startNativeOidcSignin`, `completeOidcSignin`, `OIDC_PENDING_STORAGE_KEY`); it imports no React.

## RPC surface

auth declares which of its provider methods the server may dispatch over HTTP
(`/call/@_linked/auth/<method>` for `AuthBackendProvider`,
`/call/@_linked/auth/<AuthCredential shape>/<method>` for `AuthCredentialProvider`), with
`declareCallable` and `declareInternal` from `@_linked/server-utils/utils/callable`. Every method
of both providers is declared, so a server running `server.rpcExposure: 'enforce'` (or
`LINKED_RPC_EXPOSURE=enforce`) keeps sign-in working **without the app declaring any of auth's
methods**, and in `warn` mode nothing of auth's is logged as undeclared.

| Level | Methods | What the server does |
|---|---|---|
| `public` | `AuthBackendProvider`: `signinWithPassword`, `createAccount`, `signinOAuth`, `createOAuthNonce`, `signinTemporary`, `signinDev`, `sendResetPasswordLink`, `sendSigninCode`, `signinWithCode`, `startOidcSignin`, `startNativeOidcSignin`, `completeNativeOidcSignin`, `resetPassword`, `verifyEmail`, `validateToken`, `signout` | runs, signed in or not |
| `user` | `AuthBackendProvider`: `linkOAuthIdentity`, `resendEmailVerification`, `getReauthenticationMethods`, `removeAccount`; `AuthCredentialProvider`: `userHasAuthCredential`, `userHasPassword` | 401 without a session, before the method runs |
| internal | `AuthBackendProvider`: `upgradePasswordHash`, `getPasswordForUser`, `getOrCreateAccount`, `loadAccountForSession`, `loadUserForSession`, `checkSignin`, `validateRequestToken`, `refreshSession`, `getTokenFromRequest`, `getTokenCandidates`, `getRefreshTokenFromRequest`; `AuthCredentialProvider`: `createNewCredential`, `hasAuthCredential` | 501 over HTTP in every mode; backend code can still call them |

Why these levels:

- Sign-in, sign-up and recovery run before there is a session. `validateToken` (the refresh-token
  exchange) and `signout` must answer a caller whose access token has already expired, so they
  are public too. `resetPassword` without a reset token is the signed-in password change; it
  checks the session and the current password itself. `verifyEmail` is opened from an emailed
  link, often in a browser without a session.
- The internal methods either act on a person, credential or account named by their arguments
  (setting a password hash, reading one, creating an account, telling whether any person has a
  password), or are the request and token plumbing behind sign-in, which the client never calls.
  `AuthCredential.hasAuthCredential(person)` is gone from the client for that reason: ask about
  the signed-in user with `AuthCredential.userHasAuthCredential()` or `userHasPassword()`.

**Subclassing `AuthBackendProvider`.** An override of a callable method keeps the level auth
declared (the strictest one up the class chain), and an override of an internal method stays
internal. A method the subclass adds is undeclared until the subclass declares it on its own
class:

```ts
import { declareCallable } from '@_linked/server-utils/utils/callable';

export default class AppAuthProvider extends AuthBackendProvider {
  async myExtraMethod() { /* ... */ }
}
declareCallable(AppAuthProvider, { myExtraMethod: 'user' });
```

An app that used to declare auth's methods itself can drop those declarations. Declaring the same
level again is harmless, and an app's `declareInternal` still wins over auth's `declareCallable`.

**Keep auth's data off the generic query plane.** The declarations above cover auth's provider
methods only. The generic query endpoints (`/call/@_linked/server/*Query`, `/api/*`) read and write
shapes directly, so wrap the store that holds auth's shapes with `withAccess` and give it no
access, as its own store object (it may point at the same dataset as other shapes):

```js
// linked.backend.storage.js
import { withAccess } from '@_linked/server-utils/utils/QueryAccess';
import { AuthCredential } from '@_linked/auth/shapes/AuthCredential';
import { Password } from '@_linked/auth/shapes/Password';
import { RefreshToken } from '@_linked/auth/shapes/RefreshToken';
import { IdentityToken } from '@_linked/auth/shapes/IdentityToken';
import { Authentication } from '@_linked/auth/shapes/Authentication';
import { UsedOAuthNonce } from '@_linked/auth/shapes/UsedOAuthNonce';

const credentials = withAccess(new FusekiStore({ endpoint }), { read: 'none', write: 'none' });
LinkedStorage.setDatasetForShapes(credentials,
  AuthCredential, Password, RefreshToken, IdentityToken, Authentication, UsedOAuthNonce);
```

Without it, a store's default rule decides who may query password hashes, refresh tokens and
reset tokens.

## Rate limits

The calls that check a credential, send an email or create something are rate limited by the
client's IP address and, where the call names an account, by that account (the normalized email,
or the signed-in account). An account is counted whether it exists or not, so a limited answer
does not reveal whether it does.

| Rule | Calls | Per IP | Per account |
|---|---|---|---|
| `signin` | `signinWithPassword` | 10 / minute | 5 / minute (by email) |
| `signup` | `createAccount` | 10 / hour | |
| `passwordResetRequest` | `sendResetPasswordLink` (sends an email) | 10 / hour | 3 / hour (by email) |
| `passwordReset` | `resetPassword` with a reset token | 10 / minute | |
| `passwordChange` | `resetPassword` without a token (checks the current password) | 10 / minute | 5 / 15 minutes |
| `tokenRefresh` | `validateToken` when it exchanges a refresh token | 60 / minute | |
| `oauth` | `signinOAuth`, `linkOAuthIdentity` | 20 / minute | 10 / minute (`linkOAuthIdentity`) |
| `temporarySignin` | `signinTemporary` (creates a person and account) | 30 / hour | |
| `credentialLookup` | `AuthCredentialProvider.hasAuthCredential` | 60 / minute | |
| `emailVerificationRequest` | `resendEmailVerification` (sends an email) | 10 / hour | 3 / hour (signed-in account) |
| `emailVerify` | `verifyEmail` | 10 / minute | |
| `signinCodeRequest` | `sendSigninCode` (sends an email) | 10 / hour | 3 / hour (by email) |
| `signinCode` | `signinWithCode` (guessing an eight-digit code) | 10 / minute | 5 / 15 minutes (by email) |
| `reauthenticate` | `removeAccount` when it checks a password or ID token | 10 / minute | 5 / 15 minutes (signed-in account) |
| `oidcSignin` | `startOidcSignin`, `startNativeOidcSignin` (may fetch WebFinger, a profile and issuer metadata) | 20 / minute | |
| `oidcCallback` | `GET /auth/oidc/callback` and `completeNativeOidcSignin` (call the issuer's token endpoint); a limited callback redirects with `oidc_error=rate_limited` | 20 / minute | |

A limited call answers `{error: 'Too many attempts. Please wait a moment and try again.', action:
'rate_limited', retryAfter}` (seconds) with a `Retry-After` header, in place of its usual result.
`hasAuthCredential`, which returns a boolean, fails with status 429 instead. Every attempt counts,
including refused ones. A call made outside any HTTP request (a job, a script) is never limited;
backend code that calls these while serving a request counts against that request's client.

| Variable | Meaning |
|---|---|
| `AUTH_RATE_LIMIT` | `off` (or `false`/`0`) turns every limit off, e.g. for a test run |
| `AUTH_RATE_LIMIT_<RULE>_<IP\|ACCOUNT>` | one limit as `<max>/<windowSeconds>`, or `off`. The rule in upper snake case: `AUTH_RATE_LIMIT_SIGNIN_IP=20/60`, `AUTH_RATE_LIMIT_PASSWORD_RESET_REQUEST_ACCOUNT=5/3600`, `AUTH_RATE_LIMIT_EMAIL_VERIFICATION_REQUEST_ACCOUNT=5/3600`, `AUTH_RATE_LIMIT_SIGNIN_CODE_ACCOUNT=5/900` (never `off`: it is the only per-email bound on guessing a sign-in code) |

In code, `configureRateLimits({signin: {ip: {max: 20, windowSeconds: 60}}})` from
`@_linked/auth/utils/rateLimit` does the same (the environment wins), and `resetRateLimits()`
clears the counters and overrides between tests.

- **The counters are in memory, per process.** Behind a load balancer with N instances a client
  gets up to N times the limit. For a global limit, give every instance one shared store with
  `setRateLimitStore(store)`: anything with an atomic `increment(key, ttlMs)` returning the new
  count and a `get(key)`, sync or async (Redis `INCR` + `PEXPIRE` and `GET` fit). The in-memory
  store sweeps expired counters on write and caps how many it holds.
- **The client IP is Express's `request.ip`**, never `X-Forwarded-For` read directly. Behind a
  reverse proxy, set Express's [`trust proxy`](https://expressjs.com/en/guide/behind-proxies.html)
  to the proxies in front of the app; otherwise every client has the proxy's address and shares
  one budget per rule. Trusting more hops than there are proxies lets a client pick its own
  address.

## Email configuration

auth sends three emails, the password reset link, the email verification link and the sign-in
code (with its link), through `LinkedEmail` from `@_linked/server-utils`. Register a provider once at server startup:

```ts
import { LinkedEmail } from '@_linked/server-utils/utils/LinkedEmail';

LinkedEmail.setDefaultProvider({
  async send(options) {
    // options: {to: [{email_address: {address, name}}], subject, htmlbody, from?, bounce_address?}
    await myMailService.send(options);
  },
});
```

The emails use `APP_NAME` in the subject and greeting, and `SITE_ROOT` in the links.

**Without a provider, nothing is sent.** Sign-up still creates the account (it stays
unverified), `sendResetPasswordLink` and `sendSigninCode` still answer `true`, and the unsent
link's token (or code) is removed again. A provider that throws or rejects is handled the same
way, and its error is logged without the address, the link or the code. With `DEV_AUTH=true` and
no provider, the link is printed to the server log instead, so local sign-up, reset and code
sign-in can be tested without mail:

```
[@_linked/auth] dev: verify link: https://app.test/auth/verify-email?token=…
[@_linked/auth] dev: reset link: https://app.test/auth/reset-password?token=…
[@_linked/auth] dev: signin-code link: https://app.test/auth/signin-code?email=ada%40example.test&code=12345678 (code 12345678)
```

The sign-in code line is the one place a code is logged on purpose; a test or a local issuer reads
the code from it. `DEV_AUTH` also opens `signinDev`, so it must stay unset in production.

## Setup Reset Password

To enable reset password, define a route for the reset password callback component in your app:

```tsx
reset_password_callback: {
  path: '/auth/reset-password',
  component: lazy(
    () =>
      import(
        '@_linked/auth/components/ForgotPasswordCallback' /* webpackPrefetch: true */
      ),
  ),
},
```

## Setup sign-in by code

The sign-in code email links to `${SITE_ROOT}/auth/signin-code?email=…&code=…`. Define a route
there that renders `SigninWithCodeForm`; with both values in the URL it shows the code filled in,
asks the user to type their email, and signs in when they press Sign in. It never signs in on its
own, because mail scanners open links and would use the code up, and it never takes the email
from the link on trust, because a link someone made from their own email and code would sign the
user in to that other account. Use the same component wherever the user should start a code sign-in. It reads the URL with
React Router's `useSearchParams`, and calls `onLoggedIn(authResponse)` once signed in.

```tsx
signin_code: {
  path: '/auth/signin-code',
  component: lazy(
    () =>
      import(
        '@_linked/auth/components/SigninWithCodeForm' /* webpackPrefetch: true */
      ),
  ),
},
```

## Setup Verify Email

The verification link points at `${SITE_ROOT}/auth/verify-email?token=…`. Define a route there
that renders `VerifyEmailCallback`. It redeems the token once, works signed in or out, and offers a
new link when the token is invalid and the user is signed in. It reads the token with React
Router's `useSearchParams`.

```tsx
verify_email_callback: {
  path: '/auth/verify-email',
  component: lazy(
    () =>
      import(
        '@_linked/auth/components/VerifyEmailCallback' /* webpackPrefetch: true */
      ),
  ),
},
```

`VerifyEmailCallback` takes an optional `onEmailVerified` callback, e.g. to redirect once the email
is verified.
