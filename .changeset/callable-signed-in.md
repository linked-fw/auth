---
"@_linked/auth": patch
---

The provider methods that need a session are declared `'signed-in'` instead of the deprecated alias `'user'` (`linkOAuthIdentity`, `resendEmailVerification`, `getReauthenticationMethods`, `removeAccount`, `userHasAuthCredential`, `userHasPassword`). No behaviour change. Requires `@_linked/server-utils` ^1.14.0.
