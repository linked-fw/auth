# Native sign-out token cleanup

## Scope

Make sign-out wait for removal of both native tokens before the application
navigates away. This prevents asynchronous native storage from restoring a
refresh token when the next application mount begins.

## Behavior

- Browser token behavior is unchanged.
- Native clients still pass their refresh token to the server sign-out call.
- `signout` now waits for both access-token and refresh-token removals before
  invoking that call and before any resulting navigation.

## Verification

The hook regression test registers delayed native storage removal functions and
asserts that the server sign-out request is not sent until both removals finish.

## Notes

This was a focused bug fix without a dedicated implementation plan. The older
WebID sign-in plan remains unrelated and unchanged.
