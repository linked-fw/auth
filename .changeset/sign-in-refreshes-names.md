---
"@_linked/auth": minor
---

Every sign-in writes the issuer's or provider's name claims over the person's stored names (Solid-OIDC, Google, Apple; a claim the sign-in does not carry leaves the stored name, nothing is written when unchanged), instead of only filling empty ones. A new person is created without empty `givenName` / `familyName` / `telephone` literals. `readProfileLiterals` (`utils/issuerDiscovery`) reads a string property of a WebID from its profile document (Turtle or JSON-LD), as `readOidcIssuers` reads its issuers.
