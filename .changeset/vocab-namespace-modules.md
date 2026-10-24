---
'@_linked/auth': patch
---

Vocabulary ranges raised to the releases with generated accessor modules: `@_linked/schema`
^1.8.0, `@_linked/sioc` ^1.6.0, `@_linked/xsd` ^1.4.0 (and `@_linked/core` ^2.41.0, which they
require). Auth imports only their shapes (`schema/shapes/Person`, `sioc/shapes/UserAccount`), whose
exports are unchanged, so no source changed.
