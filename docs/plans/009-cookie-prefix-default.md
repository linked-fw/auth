---
summary: >
  The cookie-name prefix defaults to the app's own APP_PREFIX (sanitised, plus "_") when neither
  Auth.cookiePrefix nor AUTH_COOKIE_PREFIX is set, so Linked apps on one host get distinct cookie
  names without configuring anything. Step A8 of plan 001.
status: Implementation
---

# 009 — Cookie prefix defaults to APP_PREFIX

Step A8 of [plan 001](001-webid-signin-track.md#a8--cookie-prefix-defaults-to-app_prefix). Ideation
and plan are done (the step's definition); this doc starts at tasks mode.

## Contracts

- **Precedence:** `Auth.cookiePrefix` / `setCookiePrefix()` > `AUTH_COOKIE_PREFIX` >
  `APP_PREFIX` (sanitised) > `''`.
- **Unset means unset or empty.** `AUTH_COOKIE_PREFIX=` (blank) falls through to `APP_PREFIX`, so
  the `process.env.AUTH_COOKIE_PREFIX ?? ''` defines CN and webid.email already have stay
  consistent with the server. To opt out of any prefix: `Auth.cookiePrefix = ''`.
- **Sanitisation of `APP_PREFIX`:** every run of characters outside `[A-Za-z0-9_.-]` becomes `-`;
  leading and trailing `-`, `_` and `.` are trimmed; a non-empty result gets `_` appended, an empty
  one gives `''`. `webid-email` → `webid-email_`, `cn` → `cn_`, `My App!` → `My-App_`,
  `!!!` → `''`. Never throws (an invalid `AUTH_COOKIE_PREFIX` still does).
- **Client:** the same module reads `process.env.AUTH_COOKIE_PREFIX` and `process.env.APP_PREFIX`
  as literal tokens, so a bundler `define` of either works. `resolveCookiePrefix(env)` is exported
  so an app's Vite config can define the resolved prefix:
  `'process.env.AUTH_COOKIE_PREFIX': JSON.stringify(resolveCookiePrefix(process.env))`.

## Phases

### Phase 1 — Default from APP_PREFIX

- `src/utils/cookieNames.ts`: `cookiePrefixFromAppPrefix(appPrefix)`, `resolveCookiePrefix(env)`;
  `getCookiePrefix()` uses it with the literal env reads; doc comment.
- `test/cookie-prefix.test.mjs`: sanitisation table; precedence in fresh processes
  (`Auth.cookiePrefix` > `AUTH_COOKIE_PREFIX` > `APP_PREFIX` > `''`); blank `AUTH_COOKIE_PREFIX`
  falls through; no `APP_PREFIX` keeps today's names; the module reads `process.env.APP_PREFIX`
  literally; an esbuild define run of the built module inlines both tokens.

**Validation:** `npx linked build`; `npm test` passes (518 existing + new).

**Done.** `npm test`: `# tests 523 / # pass 523 / # fail 0` (518 existing unchanged + 5).
esbuild over the built module with `--define:process.env.APP_PREFIX="webid-email"
--define:process.env.AUTH_COOKIE_PREFIX=""` emits `AUTH_COOKIE_PREFIX = ""; ... APP_PREFIX =
"webid-email";` and the bundle returns `webid-email_linkedAuthSession`. Deviation: the unit test
simulates the define by token replacement instead of importing esbuild, which is not a dependency
of this package (the build's dependency check flagged it).

### Phase 2 — Two-app test, docs, changeset

- Integration: the two-app test starts its apps with no `AUTH_COOKIE_PREFIX` and `APP_PREFIX`
  `cn` / `webid-email`, and asserts `cn_*` / `webid-email_*` cookie names.
- `readme.md`: env table and *Two Linked apps on one host*: nothing to set; `APP_PREFIX` gives the
  default; the client bundle needs the define.
- Plan 001: A8 section after A6, contract 2 (no `cn_` / `wie_`; `APP_PREFIX` applies), Progress.
- `.changeset/cookie-prefix-default.md` (minor; apps with `APP_PREFIX` set get new cookie names on
  upgrade, signing users out once).

**Validation:** `npm test`; `npm run test:integration` (Fuseki on :3030).

**Done.** `npm test`: 523/523. `npm run test:integration`: `# tests 42 / # pass 42 / # fail 0`,
including `ok 6 - two apps in one cookie jar: signing out of one leaves the other signed in` with
`APP_PREFIX` `cn` and `webid-email` and no `AUTH_COOKIE_PREFIX`. Control: the same test with
`APP_PREFIX` removed from both apps fails (`not ok 1`).

## Dependencies

Phase 2 depends on phase 1. No parallel work.

## Review

- Medium, outside the step's scope (needs a choice in another repo): an app with `APP_PREFIX` set
  and no client `define` gets `<app>_` cookies from the server while its bundle looks for the plain
  `linkedAuthSession` hint, so a page load not server-rendered as signed in skips the refresh. The
  readme, the changeset and A8's Consumers say to define the resolved prefix; the CLI defining
  `process.env.APP_PREFIX` by default is a follow-up in A8's Consumers.
- Low, fixed: `readEnv` simplified to one helper per token; the esbuild run still inlines both.
- Low, left: a developer shell that exports `APP_PREFIX` would prefix the cookie names other unit
  tests expect (CI and `npm test` from a plain shell don't).
