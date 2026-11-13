---
summary: RequireAuth sends a signed-out visitor to sign-in with ?from=<the guarded page>, so the host's sign-in page can return the visitor there.
---

# RequireAuth carries the guarded page

## PR

### Summary

`RequireAuth` sent a signed-out visitor to `signinRoute || '/signin'` and dropped where they were,
so after signing in the host app could only send them to its home page. It now adds the guarded
page as `from`:

- `src/components/RequireAuth.tsx`: the redirect goes to
  `signinUrlFrom(signinRoute || '/signin', pathname + search + hash)`. `signinUrlFrom` (exported)
  sets `from` in the sign-in route's own query, keeping its other parameters and hash and replacing
  an older `from`.
- The parameter is a value for the sign-in page to read. The package does not redirect to it
  itself; a host that does must accept only a path on its own origin (a `from` of
  `//evil.example` or `/\evil.example` names another host).

### Verification

- `npx linked build`: `✔ Build successful`.
- `npm test`: `# tests 643`, `# pass 643`, `# fail 0`.
- New tests in `test/require-auth.test.mjs`: the redirect carries a deep page with its query and
  hash as `from`; `from` is added to a sign-in route with a query of its own; `signinUrlFrom`
  merges into the query, replaces an old `from` and keeps the route's hash.

### Deviations

None.

### Follow-ups

None.
