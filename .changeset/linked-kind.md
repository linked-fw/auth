---
"@_linked/auth": patch
---

`package.json` says what this package is in `"linked": {"kind": "library"}` instead of `"linkedPackage": true`, which the CLI and server no longer read.
