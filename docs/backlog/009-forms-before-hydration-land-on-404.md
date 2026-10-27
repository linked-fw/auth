---
summary: >
  Auth's forms now post before hydration (report 022), so credentials stay out of the URL, but the
  post goes to the page's own URL, which an app usually does not handle (Create Now answers 404),
  so the typed values are lost. Consider rendering the forms disabled until hydrated.
status: Open
---

# 009 — A pre-hydration submit lands on a 404

Since report 022 every form in this package renders `method="post"` with no `action`. A submit
before React hydrates is then a native POST to the page's own URL. Nothing reaches the URL, the
history or an access log, but apps serve pages on GET only: Create Now answers
`POST /signin -> 404`, and the person sees an error page and types again.

## First questions

- Render the submit buttons `disabled` until hydrated (a `useHydrated` hook in this package), so
  there is no pre-hydration submit at all? The server HTML then shows a form that cannot be sent
  yet, for the moment before hydration.
- Or keep it as it is: the window is short, and webid.email already waits for hydration.
