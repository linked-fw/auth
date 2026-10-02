---
"@_linked/auth": minor
---

## Verified social sign-in and safe account linking

Google, Apple and Facebook sign-in are now verified on the server, and only the claims the provider vouches for decide which account is reached. Profile fields sent by the client are no longer trusted. Before this, Apple identity tokens were decoded without checking the signature and the Facebook email came straight from the client.

### Provider verification

- **Google**: the ID token is verified with `google-auth-library`, which checks the signature, issuer, expiry and that the audience is one of `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_ID_IOS` or `GOOGLE_CLIENT_ID_ANDROID`. The token must also carry `email_verified`.
- **Apple**: the identity token is checked against Apple's JWKS. It must be RS256, with the right issuer, audience (`APP_ID`, `APPLE_SIGN_IN_CLIENT_ID` or `APPLE_IOS_BUNDLE_ID`) and expiry. Its nonce must match, either exactly or as the SHA-256 hex of the nonce the client sends (`appleNonceMatches`). Any email in the token must be verified.
- **Facebook**: the access token is checked with `debug_token` using the app token (`FACEBOOK_CLIENT_ID|FACEBOOK_CLIENT_SECRET`), which must return `is_valid`, our `app_id` and a `user_id`. Only after that is `/me` called, and the profile it returns must belong to that `user_id`.

The helpers return a `VerifiedOAuthIdentity`. Provider names are validated at runtime with `OAUTH_PROVIDERS` and `isOAuthProvider`.

### Account resolution

- Every provider identity gets a subject link, an `IdentityToken` at a deterministic, hashed IRI built by `buildOAuthSubjectLinkId`. Once that link exists, signing in with that identity reaches the linked account without looking at the email.
- When no link exists, an account that matches the email is attached only if `decideEmailMatchedAccount` allows it. All of these must hold:
  - the provider verifies the email (`EMAIL_VERIFYING_PROVIDERS`, which is Google and Apple);
  - the account has no password;
  - the account is not linked to a Facebook identity, and not linked to a different identity at the same provider.

  If any of these fails, sign-in returns `action: 'sign_in_to_link'`. The new `linkOAuthIdentity(provider, payload)` links a verified identity to the account of the user who is signed in.
- If one subject or one email matches more than one account, sign-in fails closed.
- `useAuth().signinOAuth` now passes the backend's `error` and `action` back to the caller.

### Passwords and credentials

- Accounts created by OAuth have no password. `AuthCredential.userHasPassword()` and `AuthCredential.hasPassword(person)` return true only when a password hash exists.
- An empty or non-string password is refused before any lookup. New and reset passwords must be at least six characters (`utils/password-policy`).
- The bcrypt cost factor is raised from 3 to 12. Existing hashes keep working.
- Account removal deletes credentials, refresh tokens and identity tokens, and waits for async `onAccountWillBeRemoved` listeners. `onAccountWillBeRemoved` now returns an unsubscribe function.

### Names and logging

- `isCleanName` (`@_linked/auth/utils/name-validation`) rejects profane first and last names at account creation. It uses `bad-words` with a small allowlist for given names that are known false positives.
- OAuth tokens, payloads, serialized accounts and email addresses are no longer logged. That includes Google verification errors, whose message can contain the raw ID token.
