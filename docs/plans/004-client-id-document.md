---
summary: >
  Step A3 of the WebID sign-in track: serve the app's Solid-OIDC Client ID Document at
  {SITE_ROOT}/.well-known/linked-client.jsonld, built from configuration, and define the sign-in
  theme extension once (types, JSON Schema, font allow-list, validateClientTheme) for webid.email
  to import.
status: Tasks
---

# 004 — The Client ID Document

**Source:** step A3 of [001 — WebID sign-in track](001-webid-signin-track.md#a3--the-client-id-document)
and its [contract 3](001-webid-signin-track.md#3-client-id-document-and-theme-a3--webidemail-w3-w4-cn-c3).
**Design:** arch-08 §Branding: the Client ID Document; plan 063 decisions 4 and 5. Ideation and
plan are done there; this doc is the tasks breakdown and the record of the choices tasks mode
leaves open.

## Scope (from the sub-plan)

- Serve the app's Client ID Document at `{SITE_ROOT}/.well-known/linked-client.jsonld`, built
  from configuration: `client_id` (the document's own URL), `client_name`, `logo_uri`,
  `redirect_uris` (`{SITE_ROOT}/auth/oidc/callback`, plus app-claimed links for native builds),
  `client_uri`, `policy_uri`, `tos_uri`, and the theme under `https://linked.cm/ns/signin#theme`.
- Define the theme schema here: TypeScript types, a JSON Schema, `validateClientTheme(doc)` that
  drops invalid values and reports them, and the font allow-list.
- Validate the configured theme at startup; log and drop invalid values.
- `Cache-Control` so issuers can cache it.
- An app without sign-in config serves nothing at that path (404).

Not in scope: the webid.email side (fetching, caching, the dev-client list, size limits on panel
art; W3/W4), the redirect and callback route itself (A2).

## Choices left to tasks mode

1. **Configuration seam: a static on `Auth`**, `Auth.signinClient?: SigninClientConfig`, next to
   `Auth.webIdFor` (A0 chose the same kind of seam). The app sets it before
   `setupBeforeControllers` runs. Unset → no route, so the path 404s. `SITE_ROOT` stays an
   environment variable read at startup.
2. **One pure module, `src/utils/clientIdDocument.ts`** (subpath
   `@_linked/auth/utils/clientIdDocument`): no Express, no Node built-ins, so webid.email can import
   it anywhere. It exports the constants (`SIGNIN_THEME_KEY`, `CLIENT_ID_DOCUMENT_PATH`,
   `OIDC_CALLBACK_PATH`, `SIGNIN_THEME_FONTS`), the types (`SigninTheme`, `SigninClientConfig`,
   `ClientIdDocument`, `ThemeProblem`), `SIGNIN_THEME_JSON_SCHEMA`, `validateClientTheme(doc)` and
   `buildClientIdDocument(config, siteRoot)`.
3. **`validateClientTheme(doc)` takes the whole Client ID Document** (as the contract names it),
   reads the theme under its key and returns `{theme, problems}`: `theme` holds only the valid
   values (or is `undefined`), `problems` lists each dropped value with its path and reason. It
   never throws on bad input; webid.email feeds it fetched documents.
4. **Colour values:** hex (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`), `rgb()`/`rgba()`/`hsl()`/
   `hsla()` with numeric arguments only, and the CSS named colours plus `transparent`. Anything
   else, `url(` and `var(` included, is dropped.
5. **Font allow-list:** a short list of common open-licence families webid.email can self-host,
   plus `system-ui`. The list is the contract; webid.email ships the files.
6. **URLs** (`brand.logoUri`, `panelArt`): `https:`, or `http:` only on `localhost`. The same rule
   for the document's own fields; a bad `SITE_ROOT` or a bad configured URL fails at startup
   (`FatalConfigError`) rather than serving a document the issuer rejects. Extra `redirectUris`
   (app-claimed links) may use a custom scheme but never non-localhost `http:`.
7. **Protocol fields** a Solid-OIDC public client needs, so the issuer does not fall back to its
   defaults (`oidc-provider` defaults to `client_secret_basic`): `@context`
   (`https://www.w3.org/ns/solid/oidc-context.jsonld`), `grant_types: ['authorization_code']`,
   `response_types: ['code']`, `scope: 'openid webid email'`, `token_endpoint_auth_method: 'none'`.
   No `refresh_token`: the relying party discards the issuer's tokens (contract 4).
8. **Served as** `application/ld+json` with `Cache-Control: public, max-age=600`.

## Phases

### Phase 1 — The theme definition and the document builder

Tasks
- `src/utils/clientIdDocument.ts`: constants, types, font allow-list, named colours,
  `SIGNIN_THEME_JSON_SCHEMA`, `validateClientTheme(doc)`, `buildClientIdDocument(config, siteRoot)`
  (strips one trailing slash from `SITE_ROOT`, refuses non-localhost `http:`, validates the
  configured theme and returns the drops with the document).
- `test/client-id-document.test.mjs`: document fields from a config; trailing slash stripped;
  non-localhost `http:` refused, `localhost` accepted; extra redirect URIs appended; valid theme
  kept intact; each invalid value dropped and reported (`url(`, `var(`, `expression(`, unknown
  layout/scheme/font, non-https logo and panel art, unknown keys, wrong types); a document without
  a theme validates to `undefined` with no problems; the JSON Schema accepts the valid theme's
  shape and names the same enums and font list as the validator.

Validation: `npx linked build && node --test test/client-id-document.test.mjs` passes.

### Phase 2 — Serving it from the provider

Tasks
- `Auth.signinClient` static in `src/utils/auth.ts` (type-only import of the config).
- `AuthBackendProvider.setupBeforeControllers`: when `Auth.signinClient` is set, build the
  document once (fatal on a missing or bad `SITE_ROOT`), log every dropped theme value, and
  `registerRoute('get', CLIENT_ID_DOCUMENT_PATH, …)` sending it with the content type and
  `Cache-Control`. Nothing registered when unset.
- HTTP tests in `test/client-id-document.test.mjs` (Express app with the provider, as
  `session-cookie.test.mjs` does): configured → 200, JSON-LD, the headers, invalid theme value
  absent and logged; unconfigured → 404.

Validation: `npx linked build && npm test` passes (321 existing + new).

### Phase 3 — Docs, changeset, Verify

Tasks
- `readme.md`: a "Client ID Document" section (configuration, the served fields, the theme
  fields, the font list, the subpath webid.email imports).
- `.changeset/*.md` (minor).
- Verify: `curl` against a running app serving the document with an invalid theme value.

Validation: Verify output recorded below; full gate green.

**Dependencies:** 1 → 2 → 3, sequential (each builds on the module from phase 1).

## Progress

- [x] Phase 1 — `npx linked build && node --test test/client-id-document.test.mjs`: 17 pass, 0 fail
- [x] Phase 2 — `npx linked build && npm test`: 341 tests, 341 pass, 0 fail (321 before + 20 new). The exposure guard flagged a provider method, so the document is built by a module function and `setupBeforeControllers` only registers the route
- [x] Phase 3 — readme section *Client ID Document*, changeset (minor). Verify below.

## Verify

App on the built package, `SITE_ROOT=http://localhost:4077/` (trailing slash), a theme with
`colors.panel: 'url(https://evil.example/x.png)'`:

```
$ curl -si http://localhost:4077/.well-known/linked-client.jsonld
HTTP/1.1 200 OK
Content-Type: application/ld+json; charset=utf-8
Cache-Control: public, max-age=600

{"@context":["https://www.w3.org/ns/solid/oidc-context.jsonld"],"client_id":"http://localhost:4077/.well-known/linked-client.jsonld","client_name":"Create.Now","redirect_uris":["http://localhost:4077/auth/oidc/callback"],"client_uri":"http://localhost:4077","logo_uri":"http://localhost:4077/logo.svg","grant_types":["authorization_code"],"response_types":["code"],"scope":"openid webid email","token_endpoint_auth_method":"none","https://linked.cm/ns/signin#theme":{"layout":"two-column","font":"Inter","colors":{"primary":"#1a73e8"},"panelArt":"http://localhost:4077/art.svg"}}
```

Server log: `[auth] Client ID Document: dropped theme value colors.panel = "url(https://evil.example/x.png)": not a plain CSS colour`

webid.email's W3 test-client check is deferred until W3 exists.

## Review

Review of the three phases against the step's scope and contract 3 (20/20 tests passing; the
schema also compiled with ajv 8 in 2020-12 mode).

- **High — the JSON Schema does not compile.** `$id: 'https://linked.cm/ns/signin#theme'` has a
  fragment, which draft 2020-12 forbids; ajv throws `data/$id must match pattern "^[^#]*#?$"`.
- **Medium — theme URLs pass through raw.** `panelArt` and `brand.logoUri` keep the input string,
  so `https://a.com/x.png") ; } body{x:y" onerror="alert(1)` passes unchanged; `new URL` tolerates
  quotes, parentheses and whitespace that would reach the issuer's page.
- **Medium — extra `redirectUris` accept `javascript:` and `data:`** (also `file:`, `blob:`).
- Low — `SITE_ROOT` with a query or fragment is accepted and produces a broken `client_id`.
- Low — a `clientName` of only spaces is accepted.
- Low — schema and validator disagree at the edges: the `webUrl` pattern rejects a bare
  `http://localhost` and accepts `http://localhost:@evil.com/`; a blank brand name passes
  `minLength: 1`.
- Low — the readme says every configured URL must be `https:`; `redirectUris` may use a custom
  scheme.
- Low — `SITE_ROOT` with a path prefix gives a `client_id` under that prefix while the route is
  registered at the root path; the package's other links concatenate `SITE_ROOT` the same way.
  Not changed here (follow-up).
- Missing tests: compiling the schema, URLs with quotes or whitespace, `javascript:`/`data:`
  redirect URIs, a query or hash in `SITE_ROOT`, a bad configured URL through the provider.

## Iteration 1 — Ideation

### Gap 1 of 3: the schema's `$id`
Use `https://linked.cm/ns/signin/theme` (no fragment). The extension key in the document stays
`https://linked.cm/ns/signin#theme`; the schema id is only an identifier and is not served. The
test asserts the 2020-12 `$id` rule and that every `$ref` resolves (auth has no ajv dependency, and
adding one is out of scope); ajv compiles it in the Outcome check.

### Gap 2 of 3: raw theme URLs
Keep the parsed `url.href` instead of the input: the URL parser percent-encodes quotes, spaces and
the like, so what reaches the issuer is a normalised URL. Additionally drop any input containing
whitespace, quotes, `<`, `>`, `(`, `)` or a backslash, so an odd value is reported, not silently
rewritten. Simplest rule that leaves only safe URLs.

### Gap 3 of 3: dangerous redirect schemes
Refuse `javascript:`, `data:`, `file:`, `blob:` and `vbscript:` in extra `redirectUris` at startup,
as remote `http:` is.

The cheap lows go in the same pass: refuse a query or fragment in `SITE_ROOT`, trim and require a
non-blank `clientName`, align the schema's `webUrl` pattern and brand-name pattern, fix the readme
line. The path-prefix low stays a follow-up.

## Iteration 1 — Plan

`src/utils/clientIdDocument.ts`: new `$id`; `isAllowedWebUrl` refuses unsafe characters and
callers keep `new URL(value).href`; `webUrl` pattern
`^(https://|http://localhost(:[0-9]+)?(/|$))[^\s"'<>()\\]*$`; brand-name schema `pattern: '\S'`;
`buildClientIdDocument` refuses a query/hash in `SITE_ROOT`, blank `clientName` and the dangerous
schemes. Tests for each. Readme wording.

## Iteration 1 — Phases

### Phase 4: review fixes
Tasks: the plan above. Validation: `npx linked build && npm test` all pass; ajv compiles the schema
(scratch install).

Done. `npx linked build && npm test`: 347 tests, 347 pass, 0 fail (321 before + 26 new). ajv 8
(2020-12, ajv-formats, scratch install) compiles the schema: `compiled: https://linked.cm/ns/signin/theme`,
a valid theme → `true`, an invalid one → `false` with errors at `css`, `/colors/primary`, `/font`,
`/panelArt`. The path-prefix `SITE_ROOT` low remains a follow-up.
