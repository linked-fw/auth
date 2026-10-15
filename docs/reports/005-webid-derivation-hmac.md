---
summary: >
  The email → WebID derivation is configurable through Auth.webIdFor (default: the unchanged UUID v5
  emailToWebID), and @_linked/auth/utils/webID exports the keyed HMAC rule webid.email mints WebIDs
  with, its factory and a published test vector.
---

# 005 — Configurable WebID derivation and the shared HMAC function

## Outcome

Every sign-in method that starts from an email now gets the user's WebID from one configurable
function, `Auth.webIdFor`. The default is today's `emailToWebID`, so an app that sets nothing keeps
its WebIDs. The keyed rule that webid.email mints WebIDs with is exported for webid.email itself and
for Create Now's dev sign-in, together with a test vector both of them assert.

Step A0 of [plan 001](../plans/001-webid-signin-track.md); the step's working plan is
[002](../plans/002-webid-derivation-hmac.md).

## What changed

- `src/utils/auth.ts`: `static webIdFor: (email: string) => string = emailToWebID` on `Auth`, next
  to `userType` and `accountType`. An app sets it once in its backend setup.
- `src/backend.ts`: the five derivations (`markOAuthEmailVerified`, `signinWithPassword`,
  `createAccount`, `sendResetPasswordLink`, `signinOAuth`) call `Auth.webIdFor`.
  `markOAuthEmailVerified` compares a derived WebID with the Person's IRI, so with another
  derivation configured it would otherwise have stopped marking OAuth emails verified.
- `src/utils/webID.ts` (subpath `@_linked/auth/utils/webID`):
  - `hmacWebId(email, {secret, issuer})` → `{issuer}/id/{h}#me`, `h` = first 128 bits of
    `HMAC-SHA256(secret, trim(lowercase(email)))` as 32 lowercase hex characters;
  - `hmacWebIdFor({secret, issuer})`, the same with its options bound and checked up front;
  - `HMAC_WEBID_TEST_VECTOR`: `'  Alice@Example.COM '`, `local-dev-webid-secret`,
    `http://localhost:4050` → `http://localhost:4050/id/0e6ff1840253dc6191f36612a250decd#me`.
  - Refused: an empty email, secret or issuer, and an issuer ending in `/`.
- `readme.md`: "WebID derivation" under "How to use on Backend". Changeset: minor.

## Decisions

- **The issuer's trailing slash is refused, not trimmed.** The contract says the issuer has none;
  refusing makes a misconfiguration fail at startup instead of passing silently.
- **`node:crypto` is loaded at call time** through `process.getBuiltinModule` (Node ≥ 22.3), not
  imported. Create Now's browser components import `utils/webID` for `emailToWebID`; a static import
  would put `node:crypto` into their bundle. The built `webID.js` imports only `uuid`; in a browser
  `hmacWebId` throws "runs only on the server".
- Exports stay on the subpath, not the package root, which has no named exports.

## Tests

`test/webid.test.mjs` (12): the default is `emailToWebID` with a pinned value; the vector; the
result's shape against an independent HMAC; normalisation of case and spaces; dependence on secret
and issuer; refusals; the built `backend.js` has five `Auth.webIdFor(` calls and no
`emailToWebID`; a stub set as `Auth.webIdFor` is called by `sendResetPasswordLink` and
`signinWithPassword`.

## Follow-ups

- Create Now C2a switches its dev derivation to `hmacWebIdFor` (`DEV_WEBID_SECRET`,
  `DEV_WEBID_ISSUER`) and asserts the vector; webid.email W2 mints with it.
- Create Now C2b removes the browser-side `emailToWebID` imports (invitations by email); after that
  `utils/webID` no longer needs to stay browser-safe, though nothing requires changing it.
