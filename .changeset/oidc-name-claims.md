---
'@_linked/auth': minor
---

Solid-OIDC sign-in reads the ID token's `given_name` and `family_name` into the verified identity (`givenName`, `familyName`). A new person is created with them, and a later sign-in fills a person's empty names from them; a name the person already has is kept.
