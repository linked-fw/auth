---
'@_linked/auth': patch
---

`RequireAuth` now redirects to the sign-in route when validation ends without a session. Before, on a full page load (for example right after signout) it rendered nothing and stayed on the protected page.
