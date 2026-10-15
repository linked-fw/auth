---
'@_linked/auth': minor
---

Serve the app's Solid-OIDC Client ID Document at `{SITE_ROOT}/.well-known/linked-client.jsonld` when `Auth.signinClient` is set (nothing is served otherwise). `@_linked/auth/utils/clientIdDocument` defines the sign-in theme extension (`https://linked.cm/ns/signin#theme`): the `SigninTheme` type, `SIGNIN_THEME_JSON_SCHEMA`, the font allow-list `SIGNIN_THEME_FONTS`, `validateClientTheme(doc)` (drops invalid values and reports them) and `buildClientIdDocument(config, siteRoot)`. Invalid configured theme values are logged and left out; an `http:` SITE_ROOT other than localhost stops startup.
