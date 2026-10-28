---
'@_linked/auth': patch
---

`verifySolidAccessToken` requires `typ` `at+jwt`; shares one fetch of an issuer's keys among
concurrent requests, refetches them on an unknown `kid` once the last fetch is 5 s old, and caps
the new issuers one `requester` makes it fetch at 5 a minute (`IssuerUnavailableError`); remembers a
proof's `jti` only while its `iat` is in the window and refuses a new proof with
`ProofCacheFullError` when the memory is full of live ones.
