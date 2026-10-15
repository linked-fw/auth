---
'@_linked/auth': minor
---

Issuer discovery for WebID sign-in, in `@_linked/auth/utils/issuerDiscovery` (server-only). `createIssuerDiscovery(options)` returns `discover(input)` (also `discoverFromEmail`, `discoverFromWebId`, `clearCache`):

- for a WebID, it reads `solid:oidcIssuer` from the profile (Turtle, or JSON-LD with inline contexts);
- for an email, it asks the domain's WebFinger for an issuer link or a WebID link;
- when the domain gives no answer, it falls back to a default issuer (`https://webid.email`) with the email as login hint.

```ts
const discovery = createIssuerDiscovery({ defaultIssuer: 'https://webid.email' });
const result = await discovery.discover('alice@example.com'); // { ok, source, issuer, issuers, loginHint, … }
```

Results are returned, never thrown. Options cover a skip list of consumer domains (`DEFAULT_SKIP_DOMAINS`), a per-request timeout, a response size cap, a bounded cache whose no-answers expire, and `allowLocalhost` for development.

Only `https://` public hosts are fetched: private and loopback address literals are refused, and every redirect is checked again.

Also exported:

- `fetchOidcIssuers(webId)` and `readOidcIssuers(body, contentType, documentUrl, webId)` for checking an issuer against a profile;
- `isFetchableUrl`.

Nothing calls the module yet, and existing sign-in methods are unchanged. Adds the `n3` dependency. See the readme's "Issuer discovery".
