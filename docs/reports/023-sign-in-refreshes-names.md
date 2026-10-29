---
summary: Every sign-in writes the token's name claims over the stored names (none clears one); a new person gets no empty literals; readProfileLiterals reads a WebID profile's string values for an app's name cache.
---

# Sign-in refreshes names

## PR

### Summary

An app that has no name editing of its own takes a person's name from the sign-in. Until now a
later sign-in only filled names that were empty, so a name changed at the issuer never reached
the app; and every create path wrote `""` literals for names it did not have.

- `refreshNames` (`src/backend.ts`, replaces `fillEmptyNames`): a Solid-OIDC sign-in of an
  existing person, and both existing-person paths of `signinOAuth` (a linked identity, an email
  match), write the token's `givenName` / `familyName` over the stored ones. A claim the sign-in
  does not carry leaves the stored name; unchanged names write nothing. The token's `name` claim
  stays unparsed.
- `personNameFields`: the Solid-OIDC, OAuth, `createAccount` and code sign-in creates write
  `givenName` / `familyName` only with a value; no create writes `telephone: ''`;
  `signinTemporary` creates the person with no properties.
- `readProfileLiterals(body, contentType, documentUrl, webId, predicate)`
  (`src/utils/issuerDiscovery.ts`): the plain and language-tagged string values of `predicate`
  that a profile document states about the WebID, Turtle or JSON-LD, with the same reader (and the
  same limits) as `readOidcIssuers`, which now runs through it. Create Now reads `foaf:name` with
  it for its profile-name cache; `createGuardedFetch` was already reachable as
  `@_linked/auth/utils/guardedFetch`.

### Verification

- `npm test`: `# pass 618`, `# fail 0` (new: a second sign-in with a changed name overwrites;
  a sign-in without claims keeps the names; unchanged names write nothing; the OIDC, OAuth,
  `createAccount` and code-sign-in creates write no `""`; `readProfileLiterals` on Turtle and
  JSON-LD).
- `npm run test:integration` against Fuseki: `# pass 49`, `# fail 0` (the name test now expects a
  changed name to be written and a claimless sign-in to keep it, and no literal for an unnamed
  person; a code sign-in's new person in Fuseki has no `givenName`, `familyName` or `telephone`
  triple).

### Deviations

None from Create Now's plan 226 §NM, which specifies this change; the reader is shared with issuer
discovery instead of copied into the app.

### Follow-ups

None.

## Details

Existing people keep their `""` literals until their next sign-in with a name claim; there is no
migration (the only installs are development stores that are reset).

## Addendum — review fixes

Create Now's independent review of the change (plan 226 §NM) asked for three more things, in a
second changeset (`sign-in-names-hardening`, minor):

- **Names are cleaned** before they are stored: `cleanPersonName` (`src/utils/personName.ts`,
  exported) removes C0/C1 controls and the bidirectional controls U+200E/F, U+202A–E and
  U+2066–9, collapses whitespace and caps a name at 200 characters. Every create and refresh goes
  through it (`personNameFields`). Apps use the same function for names they read elsewhere.
- **Apple only fills.** Apple's given and family name come from the client, unsigned (Apple sends
  them to the app only on first consent), so for an existing person they fill an empty name and
  never overwrite one. Names in a signed ID token (Solid-OIDC, Google) still overwrite.
- **`onSignedIn(callback)`** (`src/utils/events.ts`) runs with the person's id after every
  successful sign-in, whatever the method (`Auth.onSigninSuccessful` calls the backend's hook,
  `Auth.signedIn`, so the browser bundle does not load the event bus). Create Now drops its cached
  name of the person there.

Verification: `npm test` `# pass 626`, `# fail 0` (new: the cleaning, Apple's fill-only names,
cleaned names on refresh, the `onSignedIn` listener on a Solid-OIDC sign-in);
`npm run test:integration` `# pass 49`, `# fail 0`.
