---
'@_linked/auth': minor
---

Email verification, uniform sign-in and reset answers, and proof for account deletion.

**Check every `removeAccount()` call: a truthy result no longer means deleted.** `removeAccount`
now answers `true` when the account was deleted and `{error, action, …}` otherwise. That object is
truthy, so compare `=== true`.

```ts
// before: signs the user out even when nothing was deleted
if (await auth.removeAccount()) signout();

// after
const result = await auth.removeAccount({ password });
if (result === true) signout();
else showError(result.error);
```

**Account deletion asks for proof.** `removeAccount()` with no proof answers
`{error, action: 'reauthenticate', methods}` for an account with a password or a linked
Google/Apple identity. Send `removeAccount({password})` or `removeAccount({provider, source})`,
where `source` is what `signinOAuth` takes as its second argument; the ID token must have been
issued at most 10 minutes ago. The new `getReauthenticationMethods()` tells which to ask for.
Temporary and dev accounts, and accounts with neither a password nor a Google/Apple link (e.g.
Facebook-only), still need only a session.

- `RemoveAccountButton` asks for the password itself. If you offer Google or Apple sign-in, pass
  the new `getOAuthSource(provider)` prop: run the provider's sign-in and resolve to the same value
  your sign-in passes to `signinOAuth`. Apple's web redirect (`form_post`) flow cannot supply the
  proof; use popup mode. `className` is now optional.

**Email verification (a soft flag).** Sign-up sends a link to
`${SITE_ROOT}/auth/verify-email?token=…`. The session reports `emailVerified`
(`useAuth().emailVerified`, `request.linkedAuth.emailVerified`); your app decides what an
unverified account may not do. A completed password reset, or a Google/Apple sign-in whose email
the provider has verified, also verifies the email.

- Add a `/auth/verify-email` route that renders `VerifyEmailCallback`
  (`@_linked/auth/components/VerifyEmailCallback`, optional `onEmailVerified`).
- New methods: `verifyEmail(token)` (public) and `resendEmailVerification()` (user), also on
  `useAuth()`.
- The access token's `emailVerified` is updated on the next refresh. Before a sensitive action,
  check on the server with `personEmailVerified(personId)` from
  `@_linked/auth/helpers/emailVerification`.

**New callable methods.** auth declares `verifyEmail` (`public`), `resendEmailVerification`
(`user`) and `getReauthenticationMethods` (`user`) itself. An app on `rpcExposure: 'enforce'` that
pins auth's surface in its own table must add them, or its drift check refuses to start.

**New types** (`@_linked/auth/types/auth`): `ReauthenticationMethod`, `RemoveAccountProof`,
`RemoveAccountResult`, `VerifyEmailResult`, `ResendEmailVerificationResult`;
`AuthSession.emailVerified` and `VerifiedOAuthIdentity.issuedAt`.

**Configuration**

- `AUTH_EMAIL_VERIFICATION_TTL`: how long a verification link works, in seconds (default 7 days).
- Register an email provider with `LinkedEmail.setDefaultProvider`. Without one, nothing is sent
  and nothing fails; with `DEV_AUTH=true` the reset and verification links are printed to the
  server log instead. The unused ZeptoMail dependency is removed.
- New rate-limit rules: `emailVerificationRequest` (10/hour per IP, 3/hour per account),
  `emailVerify` (10/minute per IP) and `reauthenticate` (10/minute per IP, 5 per 15 minutes per
  account), overridable as `AUTH_RATE_LIMIT_<RULE>_<IP|ACCOUNT>`.

**Behaviour changes**

- Sign-in answers "Invalid email / password combination." whether or not the email is registered
  or has a password, and `sendResetPasswordLink` answers `true` for every well-formed email. A UI
  that showed "not registered" should show the generic answer.
- `createAccount` refuses an email that already has a person, account or credential
  (`action: 'change_email_or_log_in'`).
- The server requires a password of at least 6 characters (`MIN_PASSWORD_LENGTH` from
  `@_linked/auth/helpers/password`) for sign-up, reset and password change, and answers
  `{error: 'Password must be at least 6 characters', action: 'invalid_password'}`. Show the
  server's error on your sign-up page.
- Values put into reset and verification emails are HTML-escaped.
- A failed email send is caught and logged without the address or the link, and the link that
  could not be sent is withdrawn.
- Reset and verification links are used up atomically, so one link cannot be redeemed twice.
- `signinDev` refuses a token without `sub`.

See the readme sections *Upgrading to 3.4*, *Sign-in and reset answers*, *Email verification*,
*Delete account*, *Email configuration*, *Setup Verify Email*, *RPC surface* and *Rate limits*.
