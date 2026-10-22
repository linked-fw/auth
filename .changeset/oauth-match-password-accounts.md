---
'@_linked/auth': minor
---

Opt-in `AUTH_OAUTH_MATCH_PASSWORD_ACCOUNTS=true`: a Google or Apple sign-in whose email the provider verified reaches the existing account with that email even when the account has a password and its email was never verified, as sign-in by email did before 3.0.7. For apps whose accounts were created before emails were verified. It reopens pre-account hijacking for those accounts, so it is off by default; Facebook, unverified provider emails and an account already linked to a different identity at the same provider are still refused.
