---
'@_linked/auth': minor
---

`ProvideAuth` takes a `renderLoading`, which every `RequireAuth` shows while the session is validated (its own `renderLoading` still wins). Without either, `RequireAuth` now renders nothing instead of the text `...`.
