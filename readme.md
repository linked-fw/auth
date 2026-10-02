# `@_linked/auth`

Portable authentication for Linked applications. The package provides session handling, password authentication, verified OAuth sign-in, account resolution, and React helpers.

## Application setup

Wrap the client application with `ProvideAuth` and supply its user and account shapes:

```tsx
import { ProvideAuth } from '@_linked/auth/components/ProvideAuth';
import { Person } from 'profile-plus/shapes/Person';
import { UserAccount } from 'profile-plus/shapes/UserAccount';

<ProvideAuth userType={Person} accountType={UserAccount}>
  <App />
</ProvideAuth>;
```

Configure the same shapes for the backend:

```ini
AUTH_USER_TYPE=profile-plus/shapes/Person
AUTH_ACCOUNT_TYPE=profile-plus/shapes/UserAccount
```

Use `useAuth` from application components:

```tsx
import { useAuth } from '@_linked/auth/hooks/useAuth';

const auth = useAuth();
```

Package imports intentionally omit the `.js` suffix. The package export map resolves these paths to compiled ESM output.

## OAuth sign-in

`signinOAuth` accepts `google`, `apple`, or `facebook`. The backend validates the provider credential before resolving or creating an account; caller-supplied profile claims are not accepted as proof of identity.

- Google ID tokens are verified with `google-auth-library` (signature, issuer, expiry, and audience = one of the configured client IDs) and must carry `email_verified`.
- Apple identity tokens are verified against Apple's signing keys (RS256, issuer, audience, expiry). The nonce the client sends must equal the token's `nonce` claim or be the value whose SHA-256 hex digest it is; only the hashed form protects a leaked token against replay.
- Facebook access tokens are checked with `debug_token` using the app token (`is_valid`, `app_id`, `user_id`) before the profile is fetched, and the profile must belong to that user.

### Which account a provider identity reaches

1. A stored subject link for that provider and subject signs straight in.
2. Otherwise, if an account already exists for the email, it is attached only when all of these hold — and every attach writes a subject link:
   - the provider vouches for the email (Google and Apple do; Facebook's Graph API gives no verification flag, so a Facebook email never attaches to an existing account);
   - the account has no password (account creation does not verify email ownership, so a password account may have been registered by somebody else in advance);
   - the account is not already linked to a Facebook identity or to a different identity at the same provider.

   Otherwise sign-in fails with `action: 'sign_in_to_link'`: the user signs in the way they did before and calls `linkOAuthIdentity(provider, payload)` from that session, which links the verified identity to the signed-in account.
3. Otherwise a new account is created without a password.

If identifiers point to more than one account, sign-in fails closed instead of merging them.

Provider configuration uses these environment values:

```ini
DATA_ROOT=...                  # base IRI for subject links
GOOGLE_CLIENT_ID=...           # any of the three Google client IDs may be set
GOOGLE_CLIENT_ID_IOS=...
GOOGLE_CLIENT_ID_ANDROID=...
APP_ID=...                     # Apple audiences: any of these three
APPLE_SIGN_IN_CLIENT_ID=...
APPLE_IOS_BUNDLE_ID=...
FACEBOOK_CLIENT_ID=...
FACEBOOK_CLIENT_SECRET=...
```

Facebook sign-in requires permission to retrieve the user's email address.

## Password authentication

Password credentials use a normalized email address. OAuth-only accounts do not receive an implicit password; password sign-in checks that a password credential exists before attempting verification, and an empty or non-string password is refused before any lookup. New and reset passwords must be at least six characters.

Password reset email delivery requires an email provider package configured by the host application.

## Backend request context

Authenticated backend requests expose `request.linkedAuth`. Providers must still reject requests where that context is absent:

```ts
const auth = this.request.linkedAuth;
if (!auth) {
  throw new Error('Authentication required');
}

const user = auth.userAccount.accountOf;
```

## Development sign-in

`DEV_AUTH=true` enables the local development authentication path. It must not be enabled in production. Store-backed sign-in still requires the configured RDF store to be available.

## Build and test

```bash
npx linked build
npm test
```

`npm test` performs a strict TypeScript build and runs the package's Node tests.

## Security notes

- Provider names are runtime-validated even though TypeScript also constrains the public type.
- OAuth account creation uses provider-verified identifiers only.
- Conflicting verified subject and email matches are rejected for manual resolution.
- Authentication logs must not contain tokens, serialized accounts, or personal profile data.
