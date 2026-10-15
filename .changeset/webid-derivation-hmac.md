---
"@_linked/auth": minor
---

Configurable WebID derivation. `webIdFor(email)` (`utils/webID`) is what every sign-in method now
uses to turn a verified email into the Person's WebID; `setWebIdFor(fn)` replaces it at startup. The
default stays `emailToWebID`, so apps that configure nothing keep their WebIDs. New server-only
`utils/hmacWebId`: `hmacWebId(email, {secret, issuer})` → `{issuer}/id/{first 128 bits of
HMAC-SHA256 as hex}#me`, with `HMAC_WEBID_TEST_VECTOR` as the published vector that webid.email
and apps' dev sign-in check themselves against.
