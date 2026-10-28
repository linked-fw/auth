---
"@_linked/auth": patch
---

Every auth form (SigninWithPasswordForm, SigninWithCodeForm, CreateAccountForm, ForgotPasswordForm, CreateNewPasswordForm) renders `method="post"`, so a submit before React hydrates posts to the page instead of putting the email and password in the URL. Hydrated behaviour is unchanged.
