---
"@_linked/auth": patch
---

Google and Apple sign-in now reuse an unambiguous OAuth-only account when its verified email is stored on `UserAccount` or `AuthCredential`, even if the Person uses a legacy non-email-derived WebID. If the email matches multiple people or accounts, sign-in fails closed with `action: "account_conflict"` instead of selecting an arbitrary account or creating another one. Password-protected accounts still require the owner to sign in before linking the provider.
