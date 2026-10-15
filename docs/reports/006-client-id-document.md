---
summary: >
  The app's Solid-OIDC Client ID Document is served at {SITE_ROOT}/.well-known/linked-client.jsonld
  when Auth.signinClient is set, and @_linked/auth/utils/clientIdDocument defines the sign-in theme
  extension once (types, JSON Schema, font allow-list, validateClientTheme) for webid.email to
  import.
---

# 006 — The Client ID Document

## Outcome

An app that sets `Auth.signinClient` serves its Client ID Document, the file a Solid-OIDC issuer
fetches to learn the app's name, redirect URIs and how to style its sign-in page. An app that sets
nothing serves nothing there. The theme extension is defined once in this package, and webid.email
imports the same definition to read the themes of the documents it fetches.

Step A3 of [plan 001](../plans/001-webid-signin-track.md).

## What changed

- `src/utils/clientIdDocument.ts` (subpath `@_linked/auth/utils/clientIdDocument`, no Express or
  Node built-ins):
  - constants `SIGNIN_THEME_KEY` (`https://linked.cm/ns/signin#theme`), `CLIENT_ID_DOCUMENT_PATH`,
    `OIDC_CALLBACK_PATH`, `SIGNIN_THEME_FONTS` and the layout, scheme and colour lists;
  - types `SigninTheme`, `SigninClientConfig`, `ClientIdDocument`, `ThemeProblem`;
  - `SIGNIN_THEME_JSON_SCHEMA` (draft 2020-12, `$id` `https://linked.cm/ns/signin/theme`);
  - `validateClientTheme(doc)` → `{theme, problems}`: keeps the valid values of a document's theme
    and reports each dropped one with its path and reason; never throws;
  - `buildClientIdDocument(config, siteRoot)` → `{document, problems}`.
- `src/utils/auth.ts`: `static signinClient?: SigninClientConfig` on `Auth`, the same kind of seam
  as `Auth.webIdFor`.
- `src/backend.ts`: `setupBeforeControllers` builds the document once when `Auth.signinClient` is
  set, logs dropped theme values, and registers `GET /.well-known/linked-client.jsonld`
  (`application/ld+json`, `Cache-Control: public, max-age=600`). A bad `SITE_ROOT` or configured
  URL is a `FatalConfigError`. The builder is a module function: the exposure guard treats every
  provider method as callable.
- `readme.md`: section *Client ID Document*; `SITE_ROOT` row updated.
- `test/client-id-document.test.mjs`: 26 tests (builder, validator, schema, serving over HTTP).

Rules the validator applies: layout, scheme and font from their lists; colours are hex, numeric
`rgb()`/`hsl()` or a lowercase CSS named colour (never `url(`, `var(`, `calc(`); logo and panel art
URLs are `https:` (or `http:` on localhost), without whitespace, quotes, angle brackets,
parentheses, backticks or backslashes, kept as their normalised `href`; brand name 1–80
characters; unknown keys dropped. The document additionally declares a public client
(`grant_types: ['authorization_code']`, `response_types: ['code']`, `scope: 'openid webid email'`,
`token_endpoint_auth_method: 'none'`) so an issuer does not fall back to its defaults.

## Verify

- `npx linked build && npm test`: 347 tests, 347 pass, 0 fail (321 before).
- `curl` against an app on the built package, `SITE_ROOT=http://localhost:4077/` and a theme with
  `colors.panel: 'url(https://evil.example/x.png)'`:

  ```
  HTTP/1.1 200 OK
  Content-Type: application/ld+json; charset=utf-8
  Cache-Control: public, max-age=600

  {"@context":["https://www.w3.org/ns/solid/oidc-context.jsonld"],"client_id":"http://localhost:4077/.well-known/linked-client.jsonld","client_name":"Create.Now","redirect_uris":["http://localhost:4077/auth/oidc/callback"],"client_uri":"http://localhost:4077","logo_uri":"http://localhost:4077/logo.svg","grant_types":["authorization_code"],"response_types":["code"],"scope":"openid webid email","token_endpoint_auth_method":"none","https://linked.cm/ns/signin#theme":{"layout":"two-column","font":"Inter","colors":{"primary":"#1a73e8"},"panelArt":"http://localhost:4077/art.svg"}}
  ```

  Server log: `[auth] Client ID Document: dropped theme value colors.panel = "url(https://evil.example/x.png)": not a plain CSS colour`
- ajv 8 (2020-12) compiles the schema and agrees with the validator on a valid and an invalid
  theme.
- webid.email's W3 test-client check is deferred until W3 exists.

## Follow-ups

- W3: run its test client against a document from `buildClientIdDocument`.
- W4: the schema's subpath is `@_linked/auth/utils/clientIdDocument` (contract 3).
- A `SITE_ROOT` with a path prefix gives a `client_id` under that prefix while the route is
  registered at the root path: backlog [003](../backlog/003-site-root-path-prefix.md).
- No test compiles the schema with a 2020-12 validator (auth depends on no ajv 8); the test checks
  the `$id` rule and `$ref`s directly.
