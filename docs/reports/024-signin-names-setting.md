---
summary: Auth.signinNames ('overwrite' default | 'fillEmpty') decides whether a sign-in's name claims replace an existing person's stored names or only fill empty ones.
---

# Sign-in names setting

## PR

### Summary

Since 3.21.0 every sign-in of an existing person writes the Solid-OIDC or Google name claims over
the stored names (report 023). An app where people edit their names in the app loses those edits
at the next sign-in. `Auth.signinNames` makes this a setting of the app:

- `src/utils/auth.ts`: `Auth.signinNames: SigninNames` (`'overwrite' | 'fillEmpty'`), kept in the
  shared `Auth` state like the other statics, default `'overwrite'`. The setter throws a
  `TypeError` for any other value, so a typo fails at startup instead of silently overwriting.
- `src/backend.ts` `refreshNames`: fills only when the caller asks (`fillOnly`, Apple) or the app
  set `'fillEmpty'`. Every existing-person path goes through it (Solid-OIDC web and native,
  `signinOAuth` by linked identity and by email match), so the setting covers every method.
  Person creation is unchanged.
- `readme.md`: a *Names from sign-in* section under *How to use on Backend*; `signinNames` added
  to the list of shared `Auth.*` statics.

### Verification

- `npx linked build`: `✔ Build successful`.
- `npm test`: `# tests 640`, `# pass 640`, `# fail 0`.
- New tests: `test/oauth.test.mjs` (default and refused values; `fillEmpty` with Google keeps
  stored names and fills an empty one, writes nothing when both are stored, fills both for a person
  with none, a missing claim leaves the empty name; `overwrite` with a missing claim keeps the
  stored name; Apple stays fill-only under `fillEmpty`; a new Google person still gets the names),
  `test/oidc-callback.test.mjs` (`overwrite`: unchanged claims write nothing, a missing claim keeps
  the stored name; `fillEmpty`: a changed claim does not replace, the empty name is filled, both
  stored writes nothing, no claims leaves empty names empty, a new person still gets the claims).
- Not run: `npm run test:integration` (needs the Fuseki of `test/integration/docker-compose.yml`);
  the change is in `refreshNames`' choice of fields, which the store-free tests cover, and the
  store write is unchanged.

### Follow-ups

None.
