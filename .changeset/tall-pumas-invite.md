---
'@_linked/auth': minor
---

The six account screens are built on `@_linked/primitives`, and the last `lincd-*`
dependencies are gone.

`Button` and `Modal` came from `lincd-mui-base` and `TextField` from `lincd-input`. Those
are now `Button`, `Input`, `Dialog` and `ConfirmDialog` from `@_linked/primitives`, adapted
at each call site rather than by widening the shared components: `variant="outlined"` maps
to `outline`, `color` carries over unchanged, `startIcon` becomes a child (Button's root is
already a flex row with a gap), `fullWidth` becomes one `width: 100%` in each component's
own CSS module, `helperText` becomes a sibling paragraph beside the field, and
`endAdornment` becomes a positioned control inside a relative wrapper.

Two changes are behavioural rather than cosmetic, both improvements:

- **Every modal in this package works again.** `lincd-mui-base`'s `Modal` wraps
  `@mui/base`'s `FocusTrap`, which throws `rootRef.current.contains is not a function`
  under React 19 — opening any of them unmounted the whole React tree. The Radix-backed
  `Dialog` also brings a focus trap, Escape handling, `aria-modal`, focus restoration and a
  close affordance.
- **`RemoveAccountButton` now asks with a `ConfirmDialog` in `tone="danger"`** instead of a
  hand-built body inside a generic modal. That makes it an `alertdialog`, so a click on the
  backdrop no longer dismisses a destructive confirmation.

The screens also pick up `@_linked/css` tokens for the first time. Their colours previously
resolved through `--ld-app-color-*` and `--ld-ref-palette-*`, which are defined nowhere, so
they rendered essentially unstyled; the local overrides that fought those undefined tokens
have been removed rather than given more specificity.

Also: the full-viewport centring that lived on `CreateNewPasswordForm`'s own root moved to
`ForgotPasswordCallback`, the page that wants it. On the root it forced a `100vh` box inside
the dialog that `EditPasswordButton` renders the same form into.
