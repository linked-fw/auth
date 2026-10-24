---
summary: Solid-OIDC sign-in keeps the ID token's given_name and family_name; a new person is created with them and a later sign-in fills empty names.
---

# OIDC name claims

## PR

### Summary

An issuer such as webid.email sends `given_name` and `family_name` in the ID token, but the
Solid-OIDC sign-in dropped them, so every person it created had empty names. Apps then named
things after the email handle instead of the person.

- `createOidcRelyingParty().complete` (`src/utils/oidcSignin.ts`) adds `givenName` and
  `familyName` to `VerifiedOidcIdentity` when the claims are non-empty strings (trimmed).
- `signInVerifiedWebId` (`src/backend.ts`) creates a new person with them, as the OAuth path
  already does. For an existing person, `fillEmptyNames` sets a given or family name that is
  empty; a name the person already has is never replaced by the issuer's.

### Verification

- `npm test`: `# pass 570`, `# fail 0` (new: the identity carries the trimmed name claims, and
  drops empty or non-string ones).
- `npm run test:integration` against the inferring Fuseki image: `# pass 49`, `# fail 0` (new: a
  new person gets the issuer's names; a later sign-in keeps them; a person created without names
  gets them filled on the next sign-in).

### Follow-ups

None.
