---
'@_linked/auth': minor
---

The ontology registers without data. `src/data/auth.json` held a placeholder (`auth:ExampleClass`, which nothing uses), so it is deleted and
the ontology no longer passes a `loadData`; apps stop logging that its data "is not Turtle text;
skipped".

- **Breaking:** the `loadData` export of `ontologies/auth` is removed, and `data/auth.json` is no
  longer in `lib/esm/`.
