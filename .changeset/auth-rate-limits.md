---
'@_linked/auth': minor
---

Rate limit the calls that check a credential, send an email or create something: `signinWithPassword` (10/min per IP, 5/min per email), `createAccount`, `sendResetPasswordLink` (3/hour per email), `resetPassword`, the refresh-token exchange in `validateToken`, `signinOAuth`, `linkOAuthIdentity`, `signinTemporary` and `hasAuthCredential`. A limited call answers `{error, action: 'rate_limited', retryAfter}` with a `Retry-After` header, the same whether the account exists or not (`hasAuthCredential` fails with 429). Counters are in memory per process, keyed by Express's `request.ip` (set `trust proxy` behind a proxy); `setRateLimitStore` plugs in a shared store. `AUTH_RATE_LIMIT=off` turns limiting off, `AUTH_RATE_LIMIT_<RULE>_<IP|ACCOUNT>=<max>/<seconds>` or `configureRateLimits` changes a limit. See *Rate limits* in the readme.
