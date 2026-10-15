---
summary: >
  @_linked/auth/utils/issuerDiscovery finds the Solid-OIDC issuer for an email or a WebID: the
  WebID profile's solid:oidcIssuer (Turtle via n3, JSON-LD read without remote contexts), WebFinger
  issuer and WebID links, and webid.email as the fallback. It has a skip list, per-request
  deadlines, a size cap, a URL guard against SSRF and a bounded cache. Step A1; nothing calls it yet.
---

# 007 — Issuer discovery

## Outcome

A server-side module answers "which issuer signs this user in?" for whatever they typed on the
sign-in page, as arch-08 §Sign-in → Flow draws it. A typed WebID gives the issuers its profile
asserts. An email asks its domain's WebFinger, and when the domain gives no usable answer it goes to
the default issuer (webid.email) with the email as `login_hint`. The module is self-contained:
`backend.ts` and `src/index.ts` do not import it, and no existing sign-in method changed. A2
(redirect and callback) is its first caller, and will also use `fetchOidcIssuers` for the ID token's
issuer check.

Step A1 of [plan 001](../plans/001-webid-signin-track.md). PR: [#122](https://github.com/linked-fw/auth/pull/122).

## Files

| File | Responsibility |
|---|---|
| `src/utils/issuerDiscovery.ts` | The whole module: URL guard, fetch with redirects, deadline and size cap, the Turtle and JSON-LD profile readers, WebFinger, the fallback, the cache |
| `test/issuer-discovery.test.mjs` | 42 tests in 4 suites against a local `node:http` fixture; `fetch` is replaced so `https://<host>/<path>` reaches the fixture as `/<host>/<path>` |
| `package.json`, `package-lock.json` | `n3` (runtime) and `@types/n3` (dev) |
| `readme.md` | "Issuer discovery" under "How to use on Backend": usage, results, options table, safety rules |
| `.changeset/issuer-discovery.md` | minor |

## Public API (`@_linked/auth/utils/issuerDiscovery`)

```ts
import { createIssuerDiscovery } from '@_linked/auth/utils/issuerDiscovery';

const discovery = createIssuerDiscovery({ defaultIssuer: 'https://webid.email' });
const result = await discovery.discover(typed); // email or WebID
if (result.ok) redirectTo(result.issuer, result.source === 'webid' ? undefined : result.loginHint);
```

- `createIssuerDiscovery(options?)` returns `{discover, discoverFromEmail, discoverFromWebId, clearCache}`.
  `discover` treats an `http(s)://` input as a WebID and anything with an `@` as an email.
- `fetchOidcIssuers(webId, fetchOptions?)` returns `{ok: true, webId, issuers}` (possibly empty) or
  `{ok: false, reason: 'invalid-input' | 'refused' | 'unreachable'}`. It is uncached, and is meant
  for A2's issuer check.
- `readOidcIssuers(body, contentType, documentUrl, webId)` reads the issuers from a document that
  has already been fetched.
- `isFetchableUrl(href, allowLocalhost?)`, the URL guard.
- Constants: `WEBID_EMAIL_ISSUER` (`https://webid.email`), `DEFAULT_SKIP_DOMAINS`,
  `SOLID_OIDC_ISSUER`, `WEBFINGER_ISSUER_REL`, `WEBFINGER_WEBID_REL`.
- Types: `IssuerDiscoveryOptions`, `IssuerFetchOptions`, `IssuerDiscoveryResult`,
  `ProfileIssuersResult`, `FallbackReason`, `IssuerDiscoveryFailure`, `IssuerDiscovery`.

### Results

Results are returned, never thrown, and frozen. `issuer` is `issuers[0]`, in source order and as
written, because A2 compares it with `iss` exactly.

| Input → outcome | Result |
|---|---|
| WebID with issuers | `{ok: true, source: 'webid', issuer, issuers, webId}` |
| WebID: profile names none / cannot be fetched / URL refused | `{ok: false, reason: 'no-issuer' \| 'unreachable' \| 'refused', webId}`. A WebID never falls back, because webid.email cannot sign in somebody else's WebID |
| Email, WebFinger issuer link | `{ok: true, source: 'webfinger', issuer, issuers, loginHint}` |
| Email, WebFinger WebID link, profile has issuers | `{ok: true, source: 'webfinger-webid', issuer, issuers, webId, loginHint}` |
| Email, anything else | `{ok: true, source: 'fallback', issuer: defaultIssuer, issuers, loginHint, reason}`, where `reason` is `skipped` · `no-answer` (404/410, no usable link) · `timeout` · `error` (other status, unreadable JRD, refused redirect, bad `Location`) · `webid-without-issuer` |
| Neither | `{ok: false, reason: 'invalid-input'}` |

The issuer link wins when the JRD has both links. `loginHint` is `trim(lowercase(email))`, the
same normalisation as A0's WebID derivation.

### Options (no environment reads; the caller decides where values come from)

`defaultIssuer` (`https://webid.email`, checked against the guard at setup, so it throws early) ·
`skipDomains` (`DEFAULT_SKIP_DOMAINS`: gmail.com, outlook.com, icloud.com, proton.me, …: 22 entries) ·
`timeoutMs` 3000, per request including its redirects (an email whose WebFinger names a WebID makes
two requests) · `maxResponseBytes` 256 KB · `cacheTtlMs` 10 min · `negativeCacheTtlMs` 5 min ·
`cacheMaxEntries` 1000 · `allowLocalhost` `false` · `fetch` · `now` (the clock for the cache).

## How it works

- **URL guard (`isFetchableUrl`).**
  - Only `https:`. `http:` is allowed for loopback hosts, and only with `allowLocalhost`.
  - A URL that carries credentials is refused.
  - The trailing dots of a fully qualified name are stripped before checking.
  - Loopback means `localhost`, `*.localhost`, `127/8` and `::1`.
  - IP literals in these ranges are always refused, using `net.BlockList`, which also matches IPv4-mapped IPv6:
    - IPv4: `0/8`, `10/8`, `100.64/10`, `169.254/16`, `172.16/12`, `192.0.0/24`, `192.168/16`, `198.18/15`, `224/4`, `240/4`;
    - IPv6: `::/96`, NAT64 `64:ff9b::/96` and `64:ff9b:1::/48`, 6to4 `2002::/16`, `fc00::/7`, `fe80::/10`, `fec0::/10`, `ff00::/8`.
- **Fetch.**
  - `redirect: 'manual'`, at most 3 hops, each target checked against the guard again.
  - One `AbortSignal.timeout` per request chain.
  - The body is streamed into a buffer up to the cap; a `content-length` over the cap stops it early.
  - A timeout during the body read counts as a timeout.
- **Turtle.**
  - Parsed with `n3`, its format pinned to `Turtle` (or `N-Triples` for `application/n-triples`), and the final document URL as base.
  - Only default-graph triples count: TriG and N3 syntax is a parse error, and a statement inside a named graph is quoted, not asserted.
  - The subject is compared with the WebID after normalising both through `URL`.
  - The object must be an IRI.
- **JSON-LD** (by content type `application/json` or `*+json`).
  - A reader without a JSON-LD processor. It handles terms and prefixes from inline contexts, `@vocab`, `@base` (`null` included), `@graph`, nested nodes and arrays.
  - It may miss an issuer but never reads one the document does not assert:
    - a remote `@context` is never fetched (a second SSRF route, and heavy), so terms only it defines are not understood;
    - values under a term with a scoped context, and nodes whose `@type` has one, are skipped;
    - a plain string counts as an IRI only under an `@type: @id` term;
    - `_:` ids are not IRIs.
  - A work budget of 100 000 units (term-map entries copied, terms defined, nodes visited) caps the cost. The term map is copied once per `@context` value, not once per array item. A document over the budget has no issuers.
- **Cache.**
  - One bounded TTL map, oldest entry evicted first, with three kinds of key:
    - `email …`: positive answers for `cacheTtlMs`, fallbacks for `negativeCacheTtlMs`;
    - `webid …`: profile reads, positive when there are issuers;
    - `domain …`: a WebFinger that timed out or was unreachable, kept for `negativeCacheTtlMs`, so the next user on that domain gets the fallback without waiting.
  - Skipped domains are not cached, because they cost no request.
  - Concurrent lookups of the same email or WebID share one promise.
  - `clearCache()` clears both the cache and the lookups under way.

## Decisions

1. **`n3` for Turtle (new runtime dependency).** `@_linked/core` has no triple layer and no RDF
   parser was installed. A2's issuer check needs subject-exact reading (prefixes, `@base`, blank
   nodes, collections, graphs), which a hand-written reader would get wrong over time. `n3` is MIT,
   brings two small dependencies, and is what the Solid ecosystem uses. Plan 001 had said no new
   dependency was needed; this is listed as a deviation.
2. **JSON-LD without a processor.** See above; `Accept` prefers Turtle, which every Solid server
   serves.
3. **An options object, not environment variables**, the same rule as A0: auth has no config object
   and the caller (A2) owns configuration. The module reads nothing at import time.
4. **A WebID never falls back. A WebFinger WebID link without an issuer does fall back**
   (`webid-without-issuer`): the domain gave no usable answer, which is the flow's "no answer"
   branch.
5. **Absolute IRIs are kept as written** (no `URL` normalisation of issuers), since `iss` is
   compared exactly. Testing found the JSON-LD reader turning `https://i.test` into
   `https://i.test/`; that is fixed.

## Review

An independent review found one high gap: a crafted 227 KB JSON-LD profile blocked the event loop
for about 26 s. It found two medium gaps: IPv6 forms that carry IPv4 (NAT64, 6to4,
IPv4-compatible, site-local), and TriG named graphs read as assertions. It also found eight low
gaps: JSON-LD string literals accepted, `@base: null`, scoped contexts, a trailing dot on
`localhost`, missing IPv4 ranges, blank-node ids, no in-flight sharing, and a bad `Location`
negative-caching the domain. All were fixed with tests. A re-review found no medium-or-higher
issues and three new low ones (`@vocab` coercion, multiple trailing dots, `clearCache` racing an
in-flight lookup), and those were fixed too.

## Tests

`test/issuer-discovery.test.mjs`, 42 tests:

- `isFetchableUrl` (5): schemes, credentials, every blocked range, loopback, trailing dots.
- `readOidcIssuers` (13): Turtle with prefixes, a relative base and other subjects; default format;
  N-Triples; TriG refused; JSON-LD compact, expanded, remote-context, literal, `@base: null`, scoped,
  blank-node and cost cases; unreadable documents.
- `fetchOidcIssuers` (7): a redirect followed; an http WebID refused without a request; a redirect
  to a private address; the size cap with and without `content-length`; unfetchable issuers dropped;
  invalid input.
- `createIssuerDiscovery` (17): typed WebID with and without an issuer; WebFinger issuer link;
  WebFinger WebID link, with and without issuers; no answer; an unfetchable link; skipped domain
  with no request; timeout and the domain cache; bad `Location`; concurrent sharing; cache hit and
  `clearCache`; TTL expiry for answers and no-answers; bounded cache; invalid input; frozen results;
  default-issuer check.

`npm test`: 363/363. No integration test: the module touches no store.

## Known limitations and follow-ups

- **DNS is not checked.** A public host name that resolves to a private address passes the guard,
  and so does DNS rebinding. Closing that needs resolve-then-pin (a custom `undici` dispatcher
  with a `lookup` that checks addresses). The readme says so. Recorded as a Pitfall under A2 in
  [plan 001](../plans/001-webid-signin-track.md#a2--the-redirect-and-callback).
- WebFinger requests to different emails on one slow domain are not shared before the first
  timeout lands in the domain cache.
- A JSON-LD profile whose terms come only from a remote context yields no issuer. Solid servers
  serve Turtle on request, so this should not matter in practice.
- Issuer strings are not normalised (a trailing-slash mismatch with `iss` is A2's to handle as
  the contract says: exact comparison).
