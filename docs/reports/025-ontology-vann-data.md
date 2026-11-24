---
date: 2026-11-10
summary: >
  The ontology's data carries its suggested prefix and namespace as vann triples. Patch.
packages: [auth]
---

# 025 — Ontology vann data

## PR

**What changed.** The `owl:Ontology` node in `src/data/auth.ttl` states
`vann:preferredNamespacePrefix "auth"` and `vann:preferredNamespaceUri "https://linked.cm/ont/auth/"`,
the prefix this ontology registers today, so Turtle output does not change. Its generated modules are unchanged: the generator reads the new vann data and finds them current. No import path
or export changed. Changeset: patch.

**Verification.**

- `linked generate-ontology --check` (exit 0):

  ```
  auth: 37 terms from src/data/auth.ttl
  Every ontology module is current.
  ```

- `linked build`: `✔ Build successful`.
- `npm test`: `# pass 626 # fail 0`.

**Deviations.** None.

**Follow-ups.** `linkedOntology` (in `@_linked/core`) still registers the name as a prefix; its removal is
recorded in core's backlog 117.

## Details

The same change across the linked vocabularies, with all their verification outputs, is in
`@_linked/core`'s report 118 (linked vocabularies: vann data and one declaration).
