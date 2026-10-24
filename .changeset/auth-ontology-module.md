---
'@_linked/auth': minor
---

Auth's ontology module is generated from `src/data/auth.ttl` by `linked generate-ontology`.

**Breaking:** the aggregated `auth` object is gone. Import the module as a namespace:
`import * as auth from '@_linked/auth/ontologies/auth'` (`auth.RefreshToken`, `auth.tokenHash`, …).
`ns`, `dataFiles` and `loadData` move to `@_linked/auth/ontologies/auth.data`, and `_self` is now
`_ontologyResource` there.

The shapes take `xsd` from `@_linked/xsd/ontologies/xsd` instead of core's internal module.
