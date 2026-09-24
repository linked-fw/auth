---
'@_linked/auth': patch
---

The ontology no longer registers by importing itself.

It carried `import * as _this from './<prefix>.js'` and passed that namespace to
`linkedOntology()`. Under `tsc` the self-reference survives; under a bundler it does
not — Rollup treats it as a circular import and elides it, so the binding is
`undefined` and a consuming app dies at boot with `_this is not defined`.

Registration now lives in a `<prefix>.register.ts` sibling, imported from the package
entry. Nothing changes for consumers: importing this package still registers the
ontology.
