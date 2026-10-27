---
date: 2026-10-27
summary: >
  Every auth form renders `method="post"` (no `action`), so a submit before React hydrates posts
  to the page instead of putting the email and password in a GET URL; hydrated behaviour is
  unchanged. Patch. Found by webid.email (its backlog 001).
---

# 022 — Auth's forms post before hydration

Create Now plan 181 (backlog batch), with `@_linked/server-utils` report 005. Landed on the
integration branch `dev`.

## PR

### Summary

The forms had no `method` or `action` in the server HTML. A submit before React hydrated (a quick
person, a password manager, a slow bundle) was a native GET: webid.email's first end-to-end run
landed on `/create-account?firstName=…&email=…&password=…&confirmPassword=…`, putting the password
in the history and in access logs. The forms now render `method="post"`.

### Changes

- `src/components/SigninWithPasswordForm.tsx`, `SigninWithCodeForm.tsx` (both of its forms),
  `CreateAccountForm.tsx`, `ForgotPasswordForm.tsx`, `CreateNewPasswordForm.tsx`: `<form
  method="post">`. In CreateAccountForm and ForgotPasswordForm it comes after `{...restProps}`,
  so a caller cannot turn the form back into a GET.
- `test/forms-before-hydration.test.mjs` (new): server-renders each built form
  (`renderToString`, SigninWithCodeForm also with `?code=` in the URL) and checks every `<form>`
  tag has `method="post"` and no `action`.
- Changeset: patch.

Hydrated behaviour is unchanged: the submits still go through react-hook-form's `handleSubmit`
on the buttons' `onClick` (which calls `preventDefault`), and SigninWithCodeForm's `onSubmit`
handlers still call `preventDefault`.

### Verification

- `npx linked build`: `✔ Build successful`.
- The new test with the forms reverted (`git stash -- src`, rebuild): `# pass 0`, `# fail 6`;
  with the change: `# pass 6`, `# fail 0`.
- `npm test`: `# tests 611`, `# pass 611`, `# fail 0` (15.5 s).
- CN worktree (port 4062) on this build: `POST /signin` with a form body answers `404`, so a
  pre-hydration submit sends nothing in the URL.
- CN `npm run test:regular`: see Details.

### Deviations

- No `action`: the backlog asked for "a safe action"; with none, the browser posts to the page's
  own URL, which keeps the credentials in the body over the page's own origin. An explicit action
  would need an endpoint that every app serves.
- Not done: disabling the forms until hydration. A pre-hydration submit now lands on whatever the
  app answers for a POST to the page (CN: 404), so the person types again. Recorded as backlog 009.

### Follow-ups

- Backlog 009: a pre-hydration submit lands on a 404.
- webid.email can render the forms without waiting for hydration after the release (webid.email
  backlog 001, trimmed to that).

## Details

The three ways the webid.email backlog named were `method="post"`, disabling until hydrated, or
an always-`preventDefault` `onSubmit`. The last does nothing before hydration (React attaches the
handler then), so it does not fix the problem; disabling is a visible change for every app. The
`method` attribute alone makes the server HTML safe and leaves the hydrated forms as they were.
