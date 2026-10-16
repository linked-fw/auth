---
summary: >
  The cookie-name prefix defaults to the app's own APP_PREFIX (a safe cookie-name token plus "_",
  webid-email → webid-email_) when neither Auth.cookiePrefix nor AUTH_COOKIE_PREFIX is set, so
  Linked apps on one host get distinct cookie names without configuring anything. No APP_PREFIX:
  today's names.
---

# 012 — Cookie prefix defaults to APP_PREFIX

## Outcome

Several Linked backends often share a host, and browsers share one cookie jar per host. After
[011](011-cookie-prefix.md) each app had to set `AUTH_COOKIE_PREFIX`; now the prefix defaults to
the app's `APP_PREFIX`, which every Linked app has. Step A8 of
[plan 001](../plans/001-webid-signin-track.md#a8--cookie-prefix-defaults-to-app_prefix).

## Public API

- Precedence: `Auth.cookiePrefix` / `setCookiePrefix()` > `AUTH_COOKIE_PREFIX` (unset or empty
  falls through) > `APP_PREFIX` sanitised > `''`. `Auth.cookiePrefix = ''` opts out.
- Sanitisation (`cookiePrefixFromAppPrefix`): runs of characters outside `[A-Za-z0-9_.-]` become
  `-`; leading/trailing `-`, `_`, `.` are trimmed; `_` is appended to a non-empty result.
  `webid-email` → `webid-email_`, `cn` → `cn_`, `My App!` → `My-App_`, `!!!` → `''`. Never throws.
- `@_linked/auth/utils/cookieNames`: new `cookiePrefixFromAppPrefix(appPrefix)` and
  `resolveCookiePrefix(env)`.
- Client: reads `process.env.AUTH_COOKIE_PREFIX` and `process.env.APP_PREFIX` literally. An app's
  Vite config defines the resolved prefix:
  `'process.env.AUTH_COOKIE_PREFIX': JSON.stringify(resolveCookiePrefix(process.env))`.

## Files

`src/utils/cookieNames.ts`, `src/utils/auth.ts` (doc comment), `test/cookie-prefix.test.mjs`
(+5 tests), `test/integration/cookie-prefix.fuseki.test.mjs` and `prefixedApp.mjs`, `readme.md`
(*Two Linked apps on one host*, env table), plan 001 (A8 section, contract 2, Progress, A6 note),
`.changeset/cookie-prefix-default.md` (minor, with the upgrade note).

## Decisions (tasks mode, within the scope)

1. An empty `AUTH_COOKIE_PREFIX` counts as unset: CN's and webid.email's existing
   `process.env.AUTH_COOKIE_PREFIX ?? ''` defines and blank `.env` lines then fall through to
   `APP_PREFIX` on both sides. Opting out is `Auth.cookiePrefix = ''`.
2. The client resolves the same way from both literal tokens, and `resolveCookiePrefix` is
   exported so the define can carry the server's resolved prefix.
3. The unit test simulates the define by token replacement (esbuild is not a dependency of this
   package); the real esbuild run is recorded below.

## Validation

| Check | Result |
|---|---|
| `npm test` | `# tests 523 / # pass 523 / # fail 0` (518 existing unchanged + 5) |
| `npm run test:integration` | `# tests 42 / # pass 42 / # fail 0`; two-app test with `APP_PREFIX` `cn` / `webid-email`, no `AUTH_COOKIE_PREFIX` |
| Control | the same test with no `APP_PREFIX` in either app: `not ok 1` |
| esbuild define | `--define:process.env.APP_PREFIX="webid-email" --define:process.env.AUTH_COOKIE_PREFIX=""` emits `AUTH_COOKIE_PREFIX: orUndefined(() => "")`, `APP_PREFIX: orUndefined(() => "webid-email")`; the bundle returns `webid-email_linkedAuthSession` |

## Review

- Medium, outside the scope: an app with `APP_PREFIX` and no client define gets prefixed cookies
  from the server while its bundle looks for the plain hint, so a page load not server-rendered as
  signed in skips the refresh. Documented in the readme and the changeset; the CLI default is a
  follow-up.
- Low, left: a developer shell exporting `APP_PREFIX` changes the names other unit tests expect.

## Follow-ups

In [plan 001 §A8 Consumers](../plans/001-webid-signin-track.md#a8--cookie-prefix-defaults-to-app_prefix),
routed by CN's master plan 065:
- webid.email: drop `AUTH_COOKIE_PREFIX=wie_`; define the resolved prefix in its vite config.
- CN: drop `AUTH_COOKIE_PREFIX=cn_` (`APP_PREFIX=cn` gives the same `cn_`); define the resolved
  prefix in `vite.config.ts`.
- The Linked CLI's `createViteConfig` could define `process.env.APP_PREFIX` for the client by
  default, so apps with no define get the client default too.
