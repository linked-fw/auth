---
"@_linked/auth": minor
---

Add server-verified Google, Apple, and Facebook sign-in with safe account resolution. OAuth provider values are now validated at runtime, verified subject links take precedence over verified normalized emails, and conflicting matches fail closed. Password sign-in now handles OAuth-only accounts explicitly, and applications can use the exported `OAUTH_PROVIDERS` and `isOAuthProvider` helpers when validating provider input.
