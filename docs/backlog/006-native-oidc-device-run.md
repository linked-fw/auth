---
summary: >
  Run native Solid-OIDC sign-in (A4) on an iOS simulator and an Android emulator, and choose the
  Capacitor plugin behind setOidcSigninBrowser: an ASWebAuthenticationSession wrapper on iOS,
  Custom Tabs on Android. Deferred to Peace Game's migration (P1), the first native app to use it.
status: Open
---

# 006 — Native OIDC sign-in on devices

Recorded from step A4 (report [010](../reports/010-native-oidc-signin.md)). A4 shipped the server
and client sides and verified them against the mock issuer with synthetic callback URLs; the
device run in [plan 001 §A4](../plans/001-webid-signin-track.md#a4--native-apps-capacitor)'s
Verify was deferred to Peace Game's migration (Create Now's plan 064, step P1), which owns the
first native app and its signing identities.

## What P1 does here

- **Choose the plugin.** auth does not pin one (`setOidcSigninBrowser(open)`). iOS needs an
  `ASWebAuthenticationSession` wrapper that resolves to the callback URL (`.https(host:path:)` from
  iOS 17.4, a custom scheme before). Android can use `@capacitor/browser` (Custom Tabs) with
  `@capacitor/app`'s `appUrlOpen`. Check whether one community plugin covers both, or whether the
  app carries a small local plugin.
- **Set up the claims** with the owner's values (readme, *Native apps (Capacitor)*): bundle ID,
  Team ID, package name, signing-certificate SHA-256 (Play App Signing and upload keys), hosting
  domain, and optionally a custom scheme; serve `apple-app-site-association` and `assetlinks.json`;
  list the links in `Auth.signinClient.redirectUris`.
- **Verify** on an iOS simulator and an Android emulator: sign in through the system browser
  against webid.email, return signed in; cancel; a cold start (Android may kill the app while the
  browser is open: the pending record survives in the token storage).

## Open questions

- If the chosen plugin cannot resolve to the callback URL on iOS 17.3 and earlier with a
  Universal Link, does Peace Game list a custom scheme as well? A custom scheme lets another app on
  the device take an attacker-started sign-in ([008 §1](008-signin-security-review.md)): settle
  that first.
