---
'@_linked/auth': minor
---

Issuer discovery for WebID sign-in: `@_linked/auth/utils/issuerDiscovery` finds the Solid-OIDC issuer for what a user typed. For a WebID it reads `solid:oidcIssuer` from the profile (Turtle, or JSON-LD with inline contexts); for an email it asks the domain's WebFinger for an issuer link or a WebID link, and falls back to a default issuer (`https://webid.email`) when the domain gives no answer. `createIssuerDiscovery(options)` adds a skip list of consumer domains, a timeout, a response size cap, a guard against fetching non-https, loopback and private addresses, and a cache. Nothing calls it yet; existing sign-in methods are unchanged. Adds the `n3` dependency.
