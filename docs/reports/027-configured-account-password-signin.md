---
summary: Password sign-in now resolves temporary-session accounts using the provider's configured account shape.
---

# Configured account shape in password sign-in

## PR

### Why

An application can create an account in a temporary session and store its password on the existing person. That person's ID can differ from the WebID derived from the submitted email. Password sign-in then relies on its account-by-email fallback. The fallback queried the default SIOC account shape, which could miss accounts stored under the application's configured RDF class. The correct password was refused even though its credential existed.

### Change

Use the provider's `this.accountShape` for the email fallback, matching the existing account lookup in password recovery. The WebID-first lookup, password verification, rate limiting, and generic failure response retain their existing behavior. Existing credentials require no data migration.

### Verification

- Built and tested the patch on the published `3.22.0` source revision. Package test output reported `640 passed, 0 failed`.
- A downstream API reproduction created accounts through temporary-session registration and confirmed that the configured account type matched, SIOC lookup missed, and the password existed only on the person. Before the patch both cases returned `Invalid email / password combination.` With the patch, Playwright reported `2 passed (26.8s)`, and both fresh sessions returned the original person ID.
- The downstream full run reported `335 passed, 6 failed, 2 skipped, 2 did not run`. Both targeted regressions passed. The remaining failures cover account assertions, query-plane reads, scoring, and invite copy. Their causes have not all been isolated.

### Follow-up

Package and downstream runtime verification used `3.22.0`. Current upstream main has since moved to newer major framework dependencies. CI should validate the merge target. Downstream adoption requires a compatible release carrying this change and an update of its dependency pin, tracked in the downstream auth regression plan.
