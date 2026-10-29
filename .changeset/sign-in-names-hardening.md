---
"@_linked/auth": minor
---

Sign-in names are cleaned before they are stored (`cleanPersonName`, `utils/personName`: control and bidirectional characters removed, whitespace collapsed, at most 200 characters). Apple's names, which the client sends unsigned, only fill an empty name; names from a signed ID token still overwrite. `onSignedIn(callback)` (`utils/events`) runs after every successful sign-in, whatever the method.
