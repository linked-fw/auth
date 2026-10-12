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

The client refreshes ~60 s before the access token's `exp`, again when the tab becomes visible or focused with a stale token, and once after a `Server.call` gets a 401 (then retries that call once). Concurrent refreshes share one request.

### Native apps

Call `setAuthTokenStorageMethods(get, set, remove)` (from `@_linked/auth/utils/token`) before rendering `ProvideAuth`. The client then sends `x-linked-auth-transport: body`, the server returns the refresh token in the response body, and both tokens are stored through your functions (`expires` in seconds). Other non-browser clients (scripts, tests) can send that header too.

## Upgrading to 3.4

3.4 is a minor release, and most apps only need the first point.

- **Deleting an account now needs proof.** `removeAccount()` with no argument fails with
  `{error, action: 'reauthenticate', methods}` for any account with a password or a linked
  Google/Apple identity. Temporary and dev accounts still need only a session.
  - Apps that use `RemoveAccountButton` need no change for password accounts. If you offer Google
    or Apple sign-in, pass `getOAuthSource` (see *Delete account* below).
  - Apps with their own delete UI call `getReauthenticationMethods()` first and send
    `removeAccount({password})` or `removeAccount({provider, source})`.
  - The Google/Apple ID token must have been issued at most 10 minutes ago.
  - Apple's redirect (`form_post`) flow on the web cannot supply the proof, because the page
    state is lost on the redirect. Use Apple's popup mode.
- **Three new callable methods:** `verifyEmail` (`public`), `resendEmailVerification` (`user`) and
  `getReauthenticationMethods` (`user`). auth declares them itself. An app on
  `rpcExposure: 'enforce'` that pins auth's surface in its own table (as Create Now's
  `authExposure` does) must add them, or its drift check refuses to start.
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
| `SITE_ROOT` | yes | the access token audience |
| `AUTH_ACCESS_TOKEN_TTL` | no | access token lifetime in seconds (default 900; development 3600) |
| `AUTH_REFRESH_TOKEN_TTL` | no | refresh token lifetime in seconds (default 60 days; development 30) |
| `AUTH_SESSION_IDLE_TTL` | no | a session not refreshed for this long ends (default 7 days; `0` = off) |
| `AUTH_SESSION_MAX_TTL` | no | a session ends this long after sign-in (default 60 days; `0` = off) |
| `AUTH_PASSWORD_RESET_TTL` | no | how long a password reset link works, in seconds (default 3600). A link works once, and a newer link replaces it |
| `AUTH_EMAIL_VERIFICATION_TTL` | no | how long an email verification link works, in seconds (default 7 days). A link works once, and a newer link replaces it |
| `AUTH_SESSION_CLEANUP` | no | `false` stops the daily background cleanup of old `RefreshToken` records |
| `AUTH_SESSION_CLEANUP_AFTER` | no | how long revoked/expired records are kept before cleanup deletes them (default 30 days) |
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
    // An account with this email already exists and the provider may not be attached to it on
    // its own (it has a password, or another identity). Ask the user to sign in the way they did
    // before, then connect the provider from inside that session:
    //   await auth.linkOAuthIdentity('google', { authentication: { idToken } });
  }
  showError(result.error);
}
```

The server verifies the provider's token and finds the account from what the provider vouches
for, never from what the client sent:

1. An identity already linked to an account (provider + subject) signs in to that account.
2. Otherwise an account with the same email is reached only when the provider verifies the email
   (Google, Apple), the account has **no password**, and it is not linked to a provider without
   verified emails or to a different identity at the same provider. Anything else answers
   `{error, action: 'sign_in_to_link'}`. A password account can be created before its email is
   verified (see *Email verification*), so it may have been registered by someone else in
   advance; attaching to it by email would hand them the user's sign-in.
3. Otherwise a new account is created, without a password.

Each sign-in that reaches an account stores a link (`IdentityToken` with `sub` and
`identityProvider`). The provider's token itself is never stored. Links written before 3.0.7
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

Sign-up still answers "This email address is already in use" when a person, account or credential
exists for the email: it signs the user in at once, so it cannot give one answer for both cases.
It is rate limited to 10 per hour per IP (`signup`), which makes it a slow way to test emails.

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
  inbox) and after a Google or Apple sign-in whose email the provider has verified.
- Dev accounts (`signinDev`) always report `emailVerified: false`.

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
- temporary and dev accounts have nothing to check and are deleted with a plain confirm.

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
    ? await auth.removeAccount({ provider: 'google', source: await getOAuthSource('google') })
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
| `public` | `AuthBackendProvider`: `signinWithPassword`, `createAccount`, `signinOAuth`, `createOAuthNonce`, `signinTemporary`, `signinDev`, `sendResetPasswordLink`, `resetPassword`, `verifyEmail`, `validateToken`, `signout` | runs, signed in or not |
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
| `reauthenticate` | `removeAccount` when it checks a password or ID token | 10 / minute | 5 / 15 minutes (signed-in account) |

A limited call answers `{error: 'Too many attempts. Please wait a moment and try again.', action:
'rate_limited', retryAfter}` (seconds) with a `Retry-After` header, in place of its usual result.
`hasAuthCredential`, which returns a boolean, fails with status 429 instead. Every attempt counts,
including refused ones. A call made outside any HTTP request (a job, a script) is never limited;
backend code that calls these while serving a request counts against that request's client.

| Variable | Meaning |
|---|---|
| `AUTH_RATE_LIMIT` | `off` (or `false`/`0`) turns every limit off, e.g. for a test run |
| `AUTH_RATE_LIMIT_<RULE>_<IP\|ACCOUNT>` | one limit as `<max>/<windowSeconds>`, or `off`. The rule in upper snake case: `AUTH_RATE_LIMIT_SIGNIN_IP=20/60`, `AUTH_RATE_LIMIT_PASSWORD_RESET_REQUEST_ACCOUNT=5/3600`, `AUTH_RATE_LIMIT_EMAIL_VERIFICATION_REQUEST_ACCOUNT=5/3600` |

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

auth sends two emails, the password reset link and the email verification link, through
`LinkedEmail` from `@_linked/server-utils`. Register a provider once at server startup:

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
unverified), `sendResetPasswordLink` still answers `true`, and the unsent link's token is removed
again. A provider that throws or rejects is handled the same way, and its error is logged without
the address or the link. With `DEV_AUTH=true` and no provider, the link is printed to the server
log instead (`[@_linked/auth] dev: verify link: …`), so local sign-up and reset can be tested
without mail.

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
