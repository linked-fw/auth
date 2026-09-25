---
'@_linked/auth': minor
---

Require `@_linked/core@^2.22.8` (was `^2.0.1`), and pin it in the lockfile.

The declared range was wide enough that the resolved core depended on whatever the
consumer — or this repo's own CI, via `package-lock.json` — happened to install. Core
decides how a shape's IRI is minted, so a stale core made this package emit legacy
`data.lincd.org` IRIs instead of the arch-02 `linked.cm` scheme. Which IRIs a published
package produces should not be a function of the installer's dependency tree.

Minor rather than patch: this raises the minimum core a consumer must resolve, so it
changes what gets installed rather than only what this package does internally.
