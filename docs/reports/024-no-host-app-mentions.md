---
date: 2026-11-02
summary: >
  Comments, the readme and current docs no longer name the private app built on auth; examples
  use "My App" and example.org. No behaviour change, no changeset. Test fixtures under test/ still
  use the old names.
packages: [auth]
---

# 024 — No host-app mentions

## PR

**What changed.** Every mention of the private host app is gone from `src/` (comments in
`backend.ts`, `SigninWithPasswordForm`, `utils/auth.ts`, `issuerDiscovery.ts`, `oidcSignin.ts`,
`nativeOidcSignin.ts`, `webID.ts`), from `readme.md` (the Client ID Document examples now use
`'My App'` and `https://example.org/…`) and from `docs/` outside `docs/reports/`. Links to the
host's architecture docs and plans were dropped; plan 001 states their rules inline and calls the
app "the host app" (cookie prefix example `my-app` → `my-app_`). **Verification:** `npx linked
build` (`✔ Build successful`), `npm test` (`# pass 626`, `# fail 0`). **Deviations:** none.
**Follow-ups:** `test/` (outside the scanned paths) still uses the app's name and domain as
fixture data: `client-id-document.test.mjs` (`'Create.Now'`, `https://create.now/…`),
`cookie-prefix*.test.mjs` (`cn`, `cn_`), `issuer-tokens.test.mjs` (`cn.test`) and a comment in
`oidc-callback.test.mjs`.

## Details

Plan 001's three contract headings changed (their anchors end in `host-app-…`); every in-file
link to them was updated.
