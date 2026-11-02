---
'@_linked/auth': minor
---

`Auth.signinNames` (`'overwrite' | 'fillEmpty'`, default `'overwrite'`) decides what a sign-in of an existing person does with the names it carries. `'overwrite'` keeps the current behaviour: Solid-OIDC and Google name claims are written over the stored names. `'fillEmpty'`, for an app where people edit their names in the app, only fills an empty name and never replaces one. Apple's unsigned names only fill in either mode, and new people are created with the sign-in's names as before. Any other value throws a `TypeError`.
