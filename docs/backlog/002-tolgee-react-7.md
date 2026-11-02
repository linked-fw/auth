---
summary: >
  `@tolgee/react` 5 -> 7 (Renovate wants to skip 6) is deferred: we decided not to upgrade
  Tolgee for now. Four auth components still call `useTranslate()`, but no known consumer app or
  linked-fw repo renders a `TolgeeProvider`, and Tolgee throws without one -- so those components can
  only render inside an app that sets Tolgee up itself. Moving them to LINKED translations and
  dropping Tolgee is likely the better outcome than either upgrading or deferring.
status: Deferred -- held by the shared Renovate preset; replaces Renovate PR linked-fw/auth#55
---

# 002 — `@tolgee/react` 7 is deferred

**Status:** deferred. We decided not to upgrade Tolgee for now. Renovate PR
[#55](https://github.com/linked-fw/auth/pull/55) (`@tolgee/react` to v7) is superseded by this
note, and majors of `@tolgee/**` are disabled in
[`linked-fw/renovate-config`](https://github.com/linked-fw/renovate-config). Remove that rule
when this is picked up.

## How it is used here

- Declared in `dependencies` as `^5.16.2`.
- **Still imported** -- it is not dead code. `useTranslate` from `@tolgee/react` is called in
  `ForgotPasswordForm`, `SigninWithPasswordForm`, `RemoveAccountButton` and `CreateAccountForm`
  (all under `src/components/`), always as `t(prefix + '.key', 'English default')`.
- **But nothing provides it.** `useTolgeeContext` in `@tolgee/react` 5 throws
  `Couldn't find tolgee instance, did you forgot to use TolgeeProvider?` when neither a
  `TolgeeProvider` nor the global-context plugin is present. Neither the known consumer apps nor any
  linked-fw repo (GitHub code search, 2026-10-02) renders a `TolgeeProvider`, and those apps do
  not import these four components. So today they work only in an app that configures Tolgee
  itself.

## What changes between 5 and 7

- **6.0.0** (2025-01): cache returns plain objects instead of `Map`s; `getRequiredRecords`
  renamed/changed; `onNsUpdate` removed in favour of the `update` event; **`useSuspense` on the
  React `TolgeeProvider` is now off by default**. React peer widened to include React 19.
- **7.0.0** (2026-03): the only breaking change listed is the Angular integration moving to
  Angular 20. Nothing React-specific.
- `useTranslate()` / `t(key, default)` -- the only API auth uses -- is unchanged across both.

Sources: tolgee-js release notes for
[v6.0.0](https://github.com/tolgee/tolgee-js/releases/tag/v6.0.0) and
[v7.0.0](https://github.com/tolgee/tolgee-js/releases/tag/v7.0.0).

So the upgrade itself is probably cheap for auth. It is deferred because Tolgee is not the
direction: translations are moving to LINKED translations (`@_linked/translation`).

## Recommendation: remove rather than upgrade

Replace the four `useTranslate()` calls with LINKED translation keys (or, as a minimum, with the
English defaults they already carry), then drop `@tolgee/react` from `dependencies`. That removes
both the hold and a hook that throws in any app without a `TolgeeProvider`. Not done here.

## When this is picked up

1. Confirm whether any consumer still wraps auth in a `TolgeeProvider` (search consumer apps,
   not just linked-fw) -- if one does, its translation keys under `prefix` are the contract to
   preserve when moving to LINKED translations.
2. If, against the recommendation, Tolgee is kept: upgrade straight to 7, and check the
   provider's `useSuspense` default (off since 6) in whichever app provides Tolgee.
3. Remove the `@tolgee/**` major hold from `renovate-config`.
