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

## Upgrading from 1.x: migrate stored auth data

2.0 moves auth's ontology from `http://lincd.org/ont/auth/` to `https://linked.cm/ont/auth/`. Every auth class and property changed IRI, so credentials, refresh tokens and the synced shape descriptions written by 1.x are **invisible** to 2.0 until they are rewritten: sign-in answers "No password found for this email". Nothing is lost; the data just has to be migrated once per dataset that auth shapes are stored in (wherever your storage config routes `AuthCredential`, `RefreshToken`, `Password`, `IdentityToken` and `Authentication`).

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
   `{error, action: 'sign_in_to_link'}`. Account creation does not verify email, so a password
   account may have been registered by someone else in advance; attaching to it by email would
   hand them the user's sign-in.
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

A limited call answers `{error: 'Too many attempts. Please wait a moment and try again.', action:
'rate_limited', retryAfter}` (seconds) with a `Retry-After` header, in place of its usual result.
`hasAuthCredential`, which returns a boolean, fails with status 429 instead. Every attempt counts,
including refused ones. A call made outside any HTTP request (a job, a script) is never limited;
backend code that calls these while serving a request counts against that request's client.

| Variable | Meaning |
|---|---|
| `AUTH_RATE_LIMIT` | `off` (or `false`/`0`) turns every limit off, e.g. for a test run |
| `AUTH_RATE_LIMIT_<RULE>_<IP\|ACCOUNT>` | one limit as `<max>/<windowSeconds>`, or `off`. The rule in upper snake case: `AUTH_RATE_LIMIT_SIGNIN_IP=20/60`, `AUTH_RATE_LIMIT_PASSWORD_RESET_REQUEST_ACCOUNT=5/3600` |

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

Make sure to install an email client, like `lincd-zeptomail`.
So that emails like 'forgot password' and 'verify email' can be sent from the backend.

## Setup Reset Password

To enable reset password, define a route for the reset password callback component in your app:

```tsx
reset_password_callback: {
  path: '/auth/reset-password',
  component: lazy(
    () =>
      import(
        'lincd-auth/lib/components/ForgotPasswordCallback' /* webpackPrefetch: true */
      ),
  ),
},
```
