---
summary: >
  A SITE_ROOT with a path prefix (an app served under https://host/app) gives a Client ID Document
  whose client_id and redirect URI sit under that prefix, while auth registers its routes at the
  root path of the Express app. The emailed verification and reset links concatenate SITE_ROOT
  the same way. Decide whether auth supports apps behind a path prefix, and if so how.
status: Open
---

# 003 — `SITE_ROOT` with a path prefix

Found in the review of the Client ID Document (report
[006](../reports/006-client-id-document.md)).

## The gap

`buildClientIdDocument` builds `client_id` as `{SITE_ROOT}/.well-known/linked-client.jsonld` and
the callback as `{SITE_ROOT}/auth/oidc/callback`. With `SITE_ROOT=https://host/app`, the issuer
fetches `https://host/app/.well-known/linked-client.jsonld`, but the provider registers the route
at `/.well-known/linked-client.jsonld` on the Express app. It is found only if a proxy strips
`/app`, or the app is mounted under it. The links in `sendVerificationEmail` and
`sendResetPasswordLink` already assume the same, so this is not new to the Client ID Document.

## Open questions

- Does any Linked app run behind a path prefix? If none does, refusing a `SITE_ROOT` with a path
  at startup (as a query or fragment is refused) is the simplest answer.
- If one does: is the proxy expected to strip the prefix (then today's behaviour is right and only
  needs documenting), or should auth mount its routes under the prefix?
