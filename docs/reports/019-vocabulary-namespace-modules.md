---
date: 2026-10-24
summary: >
  Vocabulary ranges raised to the releases whose accessor modules are generated (schema ^1.8.0,
  sioc ^1.6.0, xsd ^1.4.0, core ^2.41.0). Auth imports only shapes from them, so no source
  changed. Patch.
---

# 019 — Vocabulary packages with generated accessor modules

## Why

`@_linked/schema` 1.8, `sioc` 1.6 and `xsd` 1.4 replace the aggregated ontology objects with
generated namespace modules (`import * as schema from '@_linked/schema/ontologies/schema'`).
Auth's ranges should name the releases it is tested against.

## What changed

- `package.json`: `@_linked/schema` ^1.6.1 → ^1.8.0, `@_linked/sioc` ^1.5.1 → ^1.6.0,
  `@_linked/xsd` ^1.3.2 → ^1.4.0, `@_linked/core` ^2.39.1 → ^2.41.0 (the vocabulary releases
  require it), `@_linked/cli` (dev) ^1.56.0 → ^1.57.0; lockfile refreshed.
- No source change. The grep for the old object imports (`{schema}`, `{sioc}`, `{xsd}`,
  `{dcterms}` … from `@_linked/<vocab>/ontologies/*`) and the renamed terms finds nothing: auth
  imports `@_linked/schema/shapes/Person` and `@_linked/sioc/shapes/UserAccount`, whose exports
  did not change. `xsd.dateTime` in `UsedOAuthNonce` comes from core's internal
  `@_linked/core/ontologies/xsd`, which stays.

## Gate

- `npx linked build`: "✔ Build successful".
- `npm test`: "# tests 569 / # pass 569 / # fail 0".
- `npm ls`: one copy each of `@_linked/schema@1.8.0`, `sioc@1.6.0`, `xsd@1.4.0`, `dcmi@1.6.0`,
  `core@2.42.0`.

## Follow-ups

- Auth's own ontology (`src/ontologies/auth.ts`) is still a hand-written aggregated object over
  `src/data/auth.ttl`. Moving it to generated modules needs a `linkedOntologies` entry and its
  consumers rewritten to `import * as auth`; not done here.

## PR

### Summary

Raises auth's vocabulary ranges to the releases with generated accessor modules.

### Changes

- `@_linked/schema` ^1.8.0, `@_linked/sioc` ^1.6.0, `@_linked/xsd` ^1.4.0, `@_linked/core`
  ^2.41.0, `@_linked/cli` (dev) ^1.57.0; lockfile refreshed.
- No source change: auth imports only the vocabularies' shapes, whose exports are unchanged.

### Verification

- `npx linked build`: "✔ Build successful".
- `npm test`: "# tests 569 / # pass 569 / # fail 0".

### Deviations

None.

### Follow-ups

- Auth's own ontology to generated modules (this report, §Follow-ups).
