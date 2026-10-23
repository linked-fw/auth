---
'@_linked/auth': minor
---

Requires `@_linked/core` ^2.38.0 and `@_linked/server-utils` ^1.16.0.

Breaking changes (from core 2.38.0):
- Requires `ghcr.io/linked-fw/fuseki:6.2.0-2`, or a store that builds its class hierarchy from the registry. The integration tests now run on that image.
- `IDataset.graphQuery` is required. Auth has no dataset implementation of its own, so nothing else changes here.
