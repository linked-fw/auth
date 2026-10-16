---
"@_linked/auth": minor
---

One verified email is one account. `signinOAuth` now signs a Google or Apple identity into an existing account when the provider's verified email equals the account's verified email, also when the account has a password (it used to answer `sign_in_to_link`). An account whose email is not verified keeps the old rules, and a different or unverified email never reaches it. Links (`IdentityToken`) now record the provider's verified email (`auth:email`), from `signinOAuth` and `linkOAuthIdentity`: a linked identity whose email has since changed no longer signs in to the old account; its link is removed and it continues by its new email. A link written by an earlier release is followed while the provider's email still resolves to its account, and gets the email recorded.

`startOidcSignin` and `startNativeOidcSignin` accept a `providerHint` with no `input`: the sign-in starts at the default issuer with `provider_hint` and no `login_hint`, so "Continue with Google" needs no typed email.
