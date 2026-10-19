---
"@_linked/auth": patch
---

Resolve password-reset credentials through the account matched by email, so legacy OAuth accounts whose generated WebID differs from `UserAccount.accountOf` can set a password safely. Password sign-in sessions now also include the stored account email.
