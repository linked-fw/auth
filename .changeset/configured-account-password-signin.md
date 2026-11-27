---
"@_linked/auth": patch
---

Fix email/password sign-in for accounts created through a temporary session when the application configures a custom account shape. The email fallback now uses the configured account shape to find the account and its existing password credential.
