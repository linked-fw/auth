# @\_linked/auth

## 1.5.0

### Minor Changes

- [#38](https://github.com/linked-fw/auth/pull/38) [`65e425c`](https://github.com/linked-fw/auth/commit/65e425cae6c6ad96056ea12842444c73d33c8c23) Thanks [@flyon](https://github.com/flyon)! - Require `@_linked/core@^2.22.8` (was `^2.0.1`), and pin it in the lockfile.

  The declared range was wide enough that the resolved core depended on whatever the
  consumer — or this repo's own CI, via `package-lock.json` — happened to install. Core
  decides how a shape's IRI is minted, so a stale core made this package emit legacy
  `data.lincd.org` IRIs instead of the arch-02 `linked.cm` scheme. Which IRIs a published
  package produces should not be a function of the installer's dependency tree.

  Minor rather than patch: this raises the minimum core a consumer must resolve, so it
  changes what gets installed rather than only what this package does internally.

## 1.4.0

### Minor Changes

- [#36](https://github.com/linked-fw/auth/pull/36) [`8a8442b`](https://github.com/linked-fw/auth/commit/8a8442b282babddcebc21bf6c836f715aa1e8e08) Thanks [@flyon](https://github.com/flyon)! - The six account screens are built on `@_linked/primitives`, and the last `lincd-*`
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

## 1.3.4

### Patch Changes

- [#33](https://github.com/linked-fw/auth/pull/33) [`21f9c4e`](https://github.com/linked-fw/auth/commit/21f9c4eecb60bec4d07a462e4fb3362fcc82fed1) Thanks [@flyon](https://github.com/flyon)! - The ontology no longer registers by importing itself.

  It carried `import * as _this from './<prefix>.js'` and passed that namespace to
  `linkedOntology()`. Under `tsc` the self-reference survives; under a bundler it does
  not — Rollup treats it as a circular import and elides it, so the binding is
  `undefined` and a consuming app dies at boot with `_this is not defined`.

  Registration now lives in a `<prefix>.register.ts` sibling, imported from the package
  entry. Nothing changes for consumers: importing this package still registers the
  ontology.

## 1.3.3

### Patch Changes

- [#30](https://github.com/linked-fw/auth/pull/30) [`8e108c2`](https://github.com/linked-fw/auth/commit/8e108c253e85878d88474656b37711034c1ac11b) Thanks [@flyon](https://github.com/flyon)! - Point the changelog generator at this repo's real org.

  `.changeset/config.json` still named `linked-cm/auth` as the GitHub repo, but
  this package lives in `linked-fw/auth`. Every commit, PR and author link that
  `@changesets/changelog-github` wrote into `CHANGELOG.md` therefore pointed at a
  repository that does not exist. Renaming the org makes the generated links
  resolve.

## 1.3.2

### Patch Changes

- [#28](https://github.com/linked-fw/auth/pull/28) [`0cf087f`](https://github.com/linked-fw/auth/commit/0cf087f6502a1efaf422905f85afb3d210b79304) Thanks [@flyon](https://github.com/flyon)! - Compile the whole `src` folder, and let a bare import resolve under Node10.

  The build only emitted what an entry transitively reached, so any module
  nothing imported was never built — and never type-checked, so it rotted
  quietly. `include` now covers `src/**/*` with tests excluded explicitly.

  `typesVersions` maps every specifier through `lib/esm/*`, so a `types` value
  that already carried that prefix had it applied twice and no consumer on
  classic Node10 resolution could `import` the package by its bare name.

## 1.3.1

### Patch Changes

- [#25](https://github.com/linked-fw/auth/pull/25) [`11e67f0`](https://github.com/linked-fw/auth/commit/11e67f0cb8b20a7386b936efaeefe2db0c3f1fe3) Thanks [@flyon](https://github.com/flyon)! - Declare npm as the package manager for this repo, convert the build scripts off `yarn`, and mark `package-lock.json` as a generated file.

## 1.3.0

### Minor Changes

- [#19](https://github.com/linked-cm/auth/pull/19) [`4b1689e`](https://github.com/linked-cm/auth/commit/4b1689e1a1095063d01c5f0b171f751c2f7a2082) Thanks [@flyon](https://github.com/flyon)! - Rename `IdentityToken.subject` to `IdentityToken.sub`.

  `subject` is a field of the query builder, so `IdentityToken.select(t => [t.subject])` and
  `.where(t => t.subject.equals(...))` resolved to that field instead of the property and failed.
  This broke `getTokenByEmailOrSubject`, `getTokenByAccount` and `hasToken`.

  The RDF predicate is unchanged (`auth:subject`), so stored tokens need no migration. Update
  any code that reads `token.subject` from query results or passes `subject` to
  `IdentityToken.create`/`update` to use `sub`.

## 1.2.3

### Patch Changes

- [#12](https://github.com/linked-cm/auth/pull/12) [`ef1c23b`](https://github.com/linked-cm/auth/commit/ef1c23b12e7b49481d6f5124e2404279028c63fa) Thanks [@flyon](https://github.com/flyon)! - Dev signin now builds the session user as plain identity data (`{ id }`, a QResult) instead of a live `Shape` instance. A live Shape crossed the SSR/JWT serialization boundary and reached the client as an unusable `{__s, u}` reference (undefined `.id`), breaking auth-dependent UI (e.g. the workspace name showing `?`). Also removes the interim `reviveShapeRef` workaround.

## 1.2.2

### Patch Changes

- [#9](https://github.com/linked-cm/auth/pull/9) [`2fa7118`](https://github.com/linked-cm/auth/commit/2fa7118a64e3689f901c0cc8186bbe6010690d90) Thanks [@flyon](https://github.com/flyon)! - Remove the `development` export condition (pointed at `src`, which isn't shipped to npm). Monorepo dev resolves workspace source via the cli Vite plugin; standalone resolves `import → lib`. No consumer-visible change.

## 1.2.1

### Patch Changes

- [#7](https://github.com/linked-cm/auth/pull/7) [`406f7ef`](https://github.com/linked-cm/auth/commit/406f7ef365bbd5069a3e5cb68724169032aecebd) Thanks [@flyon](https://github.com/flyon)! - loadData: ESM-only JSON import — drop the dead CJS branch, add the `{ with: { type: 'json' } }` import attribute.

## 1.2.0

### Minor Changes

- [#5](https://github.com/linked-cm/auth/pull/5) [`ed9add7`](https://github.com/linked-cm/auth/commit/ed9add71319bc306be42bae527c5fb2faeef37fc) Thanks [@flyon](https://github.com/flyon)! - **ESM-only.** Dropped the CommonJS build; ships ES modules only (`type: module`, no `require` export condition). Fixed the root `types` field. CJS projects on Node 22+ can `require()` it (sync ESM) or use dynamic `import()`.

### Patch Changes

- [#5](https://github.com/linked-cm/auth/pull/5) [`0f1f502`](https://github.com/linked-cm/auth/commit/0f1f5028e1a36415d98616b7ef9d40f90ad30263) Thanks [@flyon](https://github.com/flyon)! - Migrated all `lincd-sioc` references to `@_linked/sioc` (the new package
  name; sioc was extracted from `lincd.org/modules/` to its own workspace

  - git repo — see the `@_linked/sioc@1.1.0` release notes for the
    package-side story).

  Internal changes (no consumer-facing API change):

  - 10 source files updated: `UserAccount` imports across `backend.ts`,
    `hooks/useAuth.tsx`, `shapes/{AuthCredential, Authentication, IdentityToken,
Password, RefreshToken}.ts`, `types/auth.ts`, `utils/auth.ts`.
  - 3 shape-registration strings updated: `['lincd-sioc', 'UserAccount']` →
    `['@_linked/sioc', 'UserAccount']` in `shapes/{IdentityToken, Password,
RefreshToken}.ts`. The string is the package name stored on the shape
    for dispatch; the new value matches what `linkedPackage('@_linked/sioc')`
    registers.
  - `package.json`: dropped `lincd-sioc: ~1.0`, added `@_linked/sioc: workspace:*`
    (or pin to the published `@_linked/sioc@^1.1` if consuming as a
    published package).

  Consumers should update their own `lincd-sioc` deps to `@_linked/sioc`
  when they upgrade `@_linked/auth` to this version, to avoid having
  both packages installed side-by-side.

  Context: see create-now plan-011 report (docs/reports/009-legacy-lincd-eradication.md).

## 1.1.0

### Minor Changes

- [#2](https://github.com/linked-cm/auth/pull/2) [`7c8d701`](https://github.com/linked-cm/auth/commit/7c8d701c8da685a54ebf88ee5dab1a8ee0537576) Thanks [@flyon](https://github.com/flyon)! - - `feat(webid)`: UUID v5 derivation with public namespace; restore `telephoneToWebID` with dedicated phone namespace
  - `fix(backend)`: use `UserAccount.email` lookup instead of `webIDToEmail(user.id)`
  - `feat(signin-dev)`: `AuthBackendProvider.signinDev` + `useAuth.signinDev` hook
  - `fix(signin-dev)`: tolerate boolean `true` in `DEV_AUTH` env var; select a real decorated property when looking up Person
  - `fix(build)`: switch to explicit per-step build pipeline so silent build failures no longer ship empty tarballs

## 1.0.6

### Patch Changes

- [`9c5b6aa`](https://github.com/linked-cm/auth/commit/9c5b6aac3c5b497077bdbf687132e489cfd3ada3) - Initial release under the new publishing setup.
