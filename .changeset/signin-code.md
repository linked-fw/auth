---
'@_linked/auth': minor
---

Sign in with an emailed code, a passwordless method next to password. `sendSigninCode(email)` emails a six-digit code and a link carrying it (`${SITE_ROOT}/auth/signin-code?email=…&code=…`); `signinWithCode(email, code)` redeems it once, marks the email verified and signs in, creating the person (at the WebID `Auth.webIdFor` derives) and account for an email that has none. Codes live `AUTH_SIGNIN_CODE_TTL` seconds (default 15 minutes) and are rate-limited by the new `signinCodeRequest` and `signinCode` rules. With `DEV_AUTH=true` and no email provider the link and code are printed to the server log. On the client: `useAuth().sendSigninCode` / `useAuth().signinWithCode` and `SigninWithCodeForm`, which is also the page behind the link. Existing methods are unchanged.
