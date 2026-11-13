---
"@_linked/auth": minor
---

`RequireAuth` sends a signed-out visitor to the sign-in route with `?from=<path, query and hash of the guarded page>` (merged into any query the sign-in route already has), so the sign-in page can return the visitor there. `signinUrlFrom(signinRoute, from)` builds that URL.
