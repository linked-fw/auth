---
'@_linked/auth': patch
---

State the app configures is now shared by every copy of this package in one runtime (Vite's SSR runner and Node under `linked start`, or two browser bundles), through `@_linked/core`'s `sharedState`:

- the `Auth.userType`, `accountType`, `webIdFor`, `signinClient`, `oidcSignin` and `cookiePrefix` statics (now accessors; assign them as before, but `mock.method(Auth, 'webIdFor')` no longer works: assign a function instead);
- the client's access token, refresh handler, in-flight refresh and refresh timer, the visibility listeners and the `Server.call` retry hook (installed once);
- the token storage from `setAuthTokenStorageMethods` and the in-memory access token;
- the rate-limit store and `configureRateLimits` limits; the refresh session store, `setSessionLimits` and the rotations under way (two copies no longer rotate one refresh token at once);
- the browser opener from `setOidcSigninBrowser`, and the `onNewUser` / `onAccountWillBeRemoved` events;
- the `ProvideAuth` contexts: `useAuth` and `useAuthRenderLoading` from one copy see `ProvideAuth` from the other.

`FatalConfigError` is branded: match it from any copy with `isLinkedError(err, FatalConfigError)` from `@_linked/core/utils/linkedError`. Requires `@_linked/core` 2.36.0 and `@_linked/server-utils` 1.13.0 or later. See the readme's "Two copies of the package in one runtime".
