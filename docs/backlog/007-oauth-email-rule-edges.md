---
summary: >
  Two edges of the OAuth "one verified email, one account" rule (A7): a verification link clicked
  by the owner on an account someone else registered now also lets the owner's Google sign-in
  reach that account; and links written before links recorded their email are dropped when the
  provider's email no longer resolves to the account (a cross-email link made with an earlier
  linkOAuthIdentity).
status: Open
---

# 007 — Edges of the OAuth email rule

From A7 ([report 013](../reports/013-oauth-existing-account.md)). Neither blocks the step; both
need a decision before acting.

## 1. A verified email on an account someone else registered

`signinOAuth` now attaches a provider identity to any account whose email is verified, password
or not. An account's email counts as verified after its verification link is opened. Signup does
not verify the email, so someone can register a password account with another person's address;
if that person later opens the "Verify your email" message they never asked for, the account is
verified with the other's password, and their Google sign-in now lands in it (before A7 it was
refused with `sign_in_to_link`). A sign-in code already drops unproven passwords before the first
proof (`dropUnprovenAccess`); the verification link does not.

To decide: whether `verifyEmail` should drop the password and sessions of an account whose
password was set before the email was proven (as a code sign-in does), or whether the
verification message should say "if you did not create this account, ignore this".

## 2. Links from before 3.14 with a different email

Links written before links recorded the provider's email are followed while the provider's email
still resolves to the linked account, and dropped otherwise (the email decides). A link made with
an earlier `linkOAuthIdentity` for a provider with another address (e.g. Apple's private relay on
an account registered with the real address) is dropped on its first sign-in after the upgrade,
and the user gets a new account by the relay address.

To decide: a one-off migration that records each existing link's email where it is known, or a
check consumers run before upgrading. Peace Game (P1) should count such links first:

```sparql
PREFIX auth: <https://linked.cm/ont/auth/>
SELECT (COUNT(?t) AS ?links) WHERE {
  GRAPH ?g { ?t a auth:IdentityToken ; auth:account ?a . FILTER NOT EXISTS { ?t auth:email ?e } }
}
```

The ones that matter are those whose provider email differs from the account's email; only the
provider knows that, so the count is an upper bound.
