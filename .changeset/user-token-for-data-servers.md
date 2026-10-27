---
'@_linked/auth': minor
---

A Solid-OIDC sign-in keeps the issuer's access token for data servers when it is a DPoP-bound JWT:
sealed, server-side, under the session's id, dropped with the session or at its `exp`
(`@_linked/auth/utils/issuerTokens`, `setIssuerTokenStore` for a store of the app's own). The
backend provider installs the hook `globalThis[Symbol.for('@_linked/auth:userTokenHeaders')]`, which
`@_linked/server`'s `RemoteDataset` calls to send the user's token as `x-linked-user-token` with a
fresh `DPoP` proof. Data servers verify both with `verifySolidAccessToken`
(`@_linked/auth/utils/solidAccessToken`). Adds `jose` as a dependency.
