---
"@_linked/auth": minor
---

## Verified social login + credential cleanup

Hardens Google / Apple / Facebook sign-in so provider identities are verified server-side, then linked to accounts via stable subject IDs. Also tightens password-credential checks and account deletion cleanup.

### OAuth identity verification

Provider helpers now validate tokens with the provider APIs and return a normalized `VerifiedOAuthIdentity` (`provider`, `subject`, verified email/profile fields):

- `@_linked/auth/helpers/google`
- `@_linked/auth/helpers/apple`
- `@_linked/auth/helpers/facebook` (new Facebook access-token debug + profile fetch)

Account resolution helpers:

```ts
import {
  resolveOAuthAccountInput,
  resolveVerifiedEmailAccount,
} from '@_linked/auth/helpers/oauth-account';
import { buildOAuthSubjectLinkId } from '@_linked/auth/helpers/oauth-subject-link';
```

- Prefer an existing account by verified provider `subject`
- Fall back to verified email
- Error clearly when the same subject/email maps to multiple accounts

### AuthCredential / IdentityToken

- `AuthCredential.userHasPassword()` / `AuthCredential.hasPassword(person)` — true only when a password hash exists (narrower than `hasAuthCredential`)
- `IdentityToken.getTokensBySubject(sub)` — look up tokens by OAuth subject
- Duplicate credential rows are handled safely; account deletion cleanup is more reliable

### Name validation

```ts
import { isCleanName } from '@_linked/auth/utils/name-validation';
```

Profanity filter for account-creation names (`bad-words`), with a small allowlist for known false-positive given names.
