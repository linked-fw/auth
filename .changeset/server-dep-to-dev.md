---
"@_linked/auth": patch
---

Move `@_linked/server` from `dependencies` to `devDependencies`. The package's code never imports it; only a test does, so consumers no longer install a copy of it through `@_linked/auth`.
