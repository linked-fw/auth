---
summary: >
  Step A0 of the WebID sign-in track: a configurable email → WebID derivation (`Auth.webIdFor`,
  default today's `emailToWebID`) that every call site in backend.ts goes through, and the shared
  HMAC derivation (`hmacWebId`, `hmacWebIdFor`, `HMAC_WEBID_TEST_VECTOR`) exported from
  `@_linked/auth/utils/webID` for webid.email and CN's dev mode.
status: Review
---

# 002 — Configurable WebID derivation and the shared HMAC function

Seeded from step A0 of [001 — WebID sign-in track](001-webid-signin-track.md#a0--configurable-webid-derivation-and-the-shared-hmac-function)
and its [contract 1](001-webid-signin-track.md#1-webid-derivation-a0--webidemail-w2-cn-c2a).
Ideation and plan are done (arch-08 §WebID derivation, §Dev-mode identity; CN plan 063 decision 6).
This doc carries the tasks.

## Scope (from the sub-plan)

- A configurable `webIdFor(email)`: every place auth turns an email into a Person IRI calls the
  configured function. **The default is today's `emailToWebID`**, so existing apps keep their WebIDs.
- An exported HMAC derivation `hmacWebId(email, {secret, issuer})` → `{issuer}/id/{h}#me`,
  `h` = first 128 bits of `HMAC-SHA256(secret, trim(lowercase(email)))` as 32 lowercase hex
  characters, and its factory `hmacWebIdFor({secret, issuer})`.
- A published test vector `HMAC_WEBID_TEST_VECTOR = {email, secret, issuer, webId}` with
  `secret = 'local-dev-webid-secret'`, `issuer = 'http://localhost:4050'` and an email with mixed
  case and surrounding spaces.

## Contracts (provided)

Contract 1 of the sub-plan, unchanged:

```ts
// src/utils/auth.ts
class Auth {
  static webIdFor: (email: string) => string = emailToWebID;
}

// src/utils/webID.ts  (subpath @_linked/auth/utils/webID)
export interface HmacWebIdOptions { secret: string; issuer: string }
export function hmacWebId(email: string, options: HmacWebIdOptions): string;
export function hmacWebIdFor(options: HmacWebIdOptions): (email: string) => string;
export const HMAC_WEBID_TEST_VECTOR: { email: string; secret: string; issuer: string; webId: string };
```

## Tasks-mode choices (within the plan)

1. **Seam: a static on `Auth`**, `Auth.webIdFor`, as contract 1 says (next to `userType` and
   `accountType`). An app sets it before sign-in requests are served, e.g.
   `Auth.webIdFor = hmacWebIdFor({secret, issuer})` in its backend setup. No setter in
   `utils/webID.ts`: one seam.
2. **Trailing slash on `issuer` is refused**, not trimmed: the contract says the issuer carries none,
   and trimming would let two spellings of one issuer pass silently. `hmacWebIdFor` and `hmacWebId`
   throw on an issuer ending in `/`, on an empty issuer and on an empty secret. The factory checks
   its options once, when it is created, so a misconfigured app fails at startup.
3. **Empty email** throws, as `emailToWebID` does; every caller in `backend.ts` already catches a
   throw and answers "Invalid email format".
4. **Exported from the subpath** `@_linked/auth/utils/webID`, not the package root (the root has no
   named exports; sub-plan A0 pitfalls).
5. The HMAC uses `node:crypto` (`createHmac`). `utils/webID.ts` is imported only server-side
   (`backend.ts`, `utils/auth.ts`); check that no client entry imports it before adding the import.

## Phases

### Phase 1 — derivation, seam and call sites

Tasks
- [x] `src/utils/webID.ts`: `HmacWebIdOptions`, `hmacWebId`, `hmacWebIdFor` and
      `HMAC_WEBID_TEST_VECTOR` next to `emailToWebID` (unchanged). The vector's `webId` is computed
      once with an independent implementation (`openssl`/`node -e`) and pasted as a literal.
- [x] `src/utils/auth.ts`: `static webIdFor: (email: string) => string = emailToWebID`, with a doc
      comment on when to set it.
- [x] `src/backend.ts`: the five calls (`markOAuthEmailVerified`, `signinWithPassword`,
      `createAccount`, `sendResetPasswordLink`, `signinOAuth`) call `Auth.webIdFor`; the
      `emailToWebID` import goes.
- [x] `test/webid.test.mjs`: default derivation unchanged (`Auth.webIdFor === emailToWebID`, a known
      UUID v5 value); HMAC matches the test vector; normalisation of case and spaces; result shape
      (`{issuer}/id/` + 32 lowercase hex + `#me`); trailing-slash issuer, empty secret and empty
      email refused; the factory equals the plain function; `backend.ts` calls the configured
      function (a stub set as `Auth.webIdFor` is called by `sendResetPasswordLink` and
      `signinWithPassword`, and the built `backend.js` no longer calls `emailToWebID`).

Validation
- `npx linked build && node --test test/webid.test.mjs` passes.
- `npm test` passes with the existing tests untouched.

### Phase 2 — docs, changeset, full gate

Tasks
- [x] `readme.md`: a "WebID derivation" section (default, `Auth.webIdFor`, the HMAC function and
      factory, the test vector, the subpath import).
- [x] `.changeset/`: a `minor` entry.
- [x] Full gate: `npx linked build && npm test`; `npm run test:integration` with the
      `AUTH_TEST_FUSEKI_*` variables set.

Validation
- Both gates pass; results recorded below.

### Dependencies

Phase 2 needs Phase 1 (the readme documents its exports). No parallel work inside the step. Other
agents work on A1, A3 and A5 in this repo; rebase on `main` before the PR (the changeset directory
and `backend.ts` may conflict with A5).

## Progress

**Phase 1 — done.**
- `npx linked build && node --test test/webid.test.mjs`: `# pass 12`, `# fail 0`.
- `npm test`: `# tests 321`, `# pass 321`, `# fail 0` (309 before; the existing tests unchanged).
- Deviation within the plan's latitude: CN's browser components (`AccessManagementPanel.tsx`,
  `DocumentInvitePanel.tsx`) import `@_linked/auth/utils/webID` for `emailToWebID`, so the module
  must stay browser-safe. `hmacWebId` loads `node:crypto` at call time through
  `process.getBuiltinModule` (Node ≥ 22.3) instead of a static import; the built `webID.js` imports
  only `uuid`. Calling it in a browser throws "runs only on the server". Contract 1 is unchanged.

**Phase 2 — done.**
- `readme.md`: "WebID derivation" under "How to use on Backend". `.changeset/webid-derivation-hmac.md`: minor.
- `npx linked build && npm test`: `# tests 321`, `# pass 321`, `# fail 0`.
- `npm run test:integration` (`AUTH_TEST_FUSEKI_URL=http://localhost:3030`, throwaway `mem`
  datasets): `# tests 34`, `# pass 34`, `# fail 0`.

## Review

Against the step's scope and Verify list: all scope items are in, contract 1 is unchanged, the
existing tests pass untouched, and both gates pass.

- **Medium — stale comments.** `emailToWebID`'s doc comment and `WEBID_EMAIL_NAMESPACE`'s still
  said CN and webid.email both use UUID v5; arch-08 now has webid.email minting with HMAC.
- Low — the readme example passes `process.env.WEBID_SECRET` (`string | undefined`); a TypeScript
  app needs a guard. `hmacWebIdFor` throws at startup on a missing secret, so a misconfiguration
  fails early.
- Low — the "configured function is called" check is behavioural for `sendResetPasswordLink` and
  `signinWithPassword` and structural (the built `backend.js` has five `Auth.webIdFor(` calls and
  no `emailToWebID`) for the OAuth paths and `createAccount`.

## Iteration 1 — Ideation

### Gap 1 of 1: stale comments in `utils/webID.ts`
Only option inside the scope: rewrite the two comments to the current design (the UUID v5 rule is
the default of `Auth.webIdFor`; webid.email uses `hmacWebId`). No code change.

## Iteration 1 — Plan

`src/utils/webID.ts` comments only. No contract change.

## Iteration 1 — Phases

### Phase 3: fix the stale comments
- [x] Rewrite the `WEBID_EMAIL_NAMESPACE` and `emailToWebID` comments.

Validation: `npx linked build && npm test` passes.

