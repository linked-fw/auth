---
'@_linked/auth': minor
---

The email → WebID derivation is configurable: every sign-in method that starts from an email calls `Auth.webIdFor(email)`, which defaults to `emailToWebID`, so existing apps keep their WebIDs. `@_linked/auth/utils/webID` exports the keyed rule webid.email mints WebIDs with: `hmacWebId(email, {secret, issuer})` → `{issuer}/id/{h}#me` (`h` = first 128 bits of HMAC-SHA256 over the trimmed, lowercased email), the factory `hmacWebIdFor({secret, issuer})` to set as `Auth.webIdFor`, and the published `HMAC_WEBID_TEST_VECTOR`.
