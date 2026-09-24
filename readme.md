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

- Google credentials are verified with Google's token verification endpoint.
- Apple identity tokens are validated against Apple's signing keys and expected audience.
- Facebook access tokens are checked against the configured application and then exchanged for the verified profile.

Account resolution prefers a verified provider subject link and then a verified, normalized email address. If those identifiers point to different accounts, sign-in fails closed instead of merging them automatically.

Provider configuration uses the corresponding environment values:

```ini
GOOGLE_CLIENT_ID=...
APPLE_SIGN_IN_CLIENT_ID=...
FACEBOOK_APP_ID=...
FACEBOOK_APP_SECRET=...
```

Facebook sign-in requires permission to retrieve the user's email address.

## Password authentication

Password credentials use a normalized email address. OAuth-only accounts do not receive an implicit password; password sign-in checks that a password credential exists before attempting verification.

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
yarn linked build
npm test
```

`npm test` performs a strict TypeScript build and runs the package's Node tests.

## Security notes

- Provider names are runtime-validated even though TypeScript also constrains the public type.
- OAuth account creation uses provider-verified identifiers only.
- Conflicting verified subject and email matches are rejected for manual resolution.
- Authentication logs must not contain tokens, serialized accounts, or personal profile data.
