---
summary: >
  Step A1 of the WebID sign-in track: a server-side issuer-discovery module. For a typed WebID it
  reads solid:oidcIssuer from the profile; for an email it asks the domain's WebFinger (issuer link
  or WebID link) and falls back to a configured default issuer (webid.email), with a skip list of
  consumer domains, a timeout, a response size cap and a cache. Nothing calls it yet; A2 will.
status: Implementation
---

# 003 — Issuer discovery (A1)

Seeded from [001 §A1](001-webid-signin-track.md#a1--issuer-discovery). Design:
[arch-08 §Sign-in → Flow](https://github.com/Semantu/create-now/blob/main/docs/architecture/08-identity-and-auth.md#flow),
[063](https://github.com/Semantu/create-now/blob/main/docs/plans/063-webid-signin-contract.md)
decisions 1 and 2. Ideation and plan are done there; this doc only records the choices tasks mode
makes inside the step's scope.

## Scope (from 001)

- **WebID → issuer:** fetch the WebID's profile (Turtle or JSON-LD), read `solid:oidcIssuer`.
- **Email → issuer:** WebFinger on the email's domain (`/.well-known/webfinger?resource=acct:{email}`);
  accept an issuer link (`http://openid.net/specs/connect/1.0/issuer`) or a WebID link
  (`http://www.w3.org/ns/solid/terms#webid`, then as above).
- **Fallback:** a configured default issuer (webid.email) when WebFinger gives no answer.
- A skip list of consumer domains that never answer, a short timeout, and a cache of results.

Not in scope: any caller (A2 is the first), `backend.ts`, `src/index.ts`, the issuer check on a
token (A2 uses this module's profile reader for it).

## Choices made in tasks mode

1. **Turtle is parsed with `n3`.** `@_linked/core` has no triple layer (its `shapes/validation`
   says so) and no RDF parser is installed. A profile can describe other subjects, and A2's issuer
   check must only accept `solid:oidcIssuer` *of the WebID*, so the reader has to track subjects,
   prefixes, `@base`, blank nodes and collections correctly: a hand-written reader for that is
   code to maintain and get wrong. `n3` (MIT, two small deps) is the parser the Solid ecosystem
   uses. This is a new runtime dependency where 001 expected none; named in the Outcome.
2. **JSON-LD is read without a JSON-LD processor.** Full JSON-LD needs remote `@context` fetches,
   which would be a second way to make the server fetch arbitrary URLs. The reader handles
   expanded IRIs, compact IRIs and terms defined in an *inline* `@context` (including `@vocab`
   and `@base`), `@graph`, and `@id` values or plain strings. A remote context is not fetched;
   such a profile answers no issuer unless it also uses full IRIs. The `Accept` header prefers
   Turtle, which every Solid server serves.
3. **The module is configured by an options object, not the environment.** `createIssuerDiscovery(options)`
   returns `{discover, discoverFromEmail, discoverFromWebId, clearCache}`; the module reads no
   `process.env`, so A2 decides where the values come from (same rule as A0: auth has no config
   object). Defaults: `defaultIssuer` `https://webid.email`, `timeoutMs` 3000, `cacheTtlMs` 10 min,
   `negativeCacheTtlMs` 5 min, `maxResponseBytes` 256 KB, `cacheMaxEntries` 1000, skip list
   `DEFAULT_SKIP_DOMAINS`.
4. **Results are returned, never thrown** (as contract 4 asks for A2's errors):
   - `{ok: true, issuer, issuers, source: 'webid', webId}` for a typed WebID;
   - `{ok: true, issuer, issuers, source: 'webfinger', loginHint}` for an issuer link;
   - `{ok: true, issuer, issuers, source: 'webfinger-webid', webId, loginHint}` for a WebID link;
   - `{ok: true, issuer, issuers, source: 'fallback', loginHint, reason}` with `reason`
     `skipped` · `no-answer` · `timeout` · `error` · `webid-without-issuer`;
   - `{ok: false, reason, webId?}` only for a typed WebID or invalid input (`invalid-input` ·
     `refused` · `unreachable` · `no-issuer`): webid.email cannot sign in somebody else's WebID, so a WebID
     never falls back.
   A WebFinger WebID link whose profile names no issuer falls back (`webid-without-issuer`): the
   domain gave no usable answer, which is the diagram's "no answer" branch.
5. **Fetch safety** (001 pitfalls): `https://` only; `http://` and loopback addresses only with
   `allowLocalhost` (default `false`; dev and tests turn it on); IP literals in private,
   link-local and unique-local ranges are always refused; redirects are followed by hand (at most
   3), each target checked again; one deadline (`AbortSignal.timeout`) covers the whole chain; the
   body is read up to `maxResponseBytes` and dropped beyond. Host names that *resolve* to private
   addresses are not checked (that needs DNS pinning); recorded as a follow-up.
6. **Caching:** results keyed by normalised email (WebFinger) and by WebID (profile), positive and
   negative entries both expire (negative sooner); a domain whose WebFinger timed out or was
   unreachable is cached per domain, so the next user of that domain does not wait again. The
   cache is bounded (oldest entry evicted first). A `fetch` option replaces the global one (tests,
   custom agents).
7. **Email normalisation** is A0's: `trim(lowercase(email))`. `loginHint` is that normalised email.

## Files

- `src/utils/issuerDiscovery.ts` (new): options and result types, `DEFAULT_SKIP_DOMAINS`,
  `WEBID_EMAIL_ISSUER`, the safe fetch, `readOidcIssuers(body, contentType, documentUrl, webId)`,
  `fetchOidcIssuers(webId, options)`, `createIssuerDiscovery(options)`. Server-only, imported by
  subpath `@_linked/auth/utils/issuerDiscovery`; not imported from `src/index.ts` or `backend.ts`.
- `package.json`, `package-lock.json`: `n3` (runtime) and `@types/n3` if needed.
- `test/issuer-discovery.test.mjs` (new): a `node:http` fixture server.
- `readme.md`: a section "Issuer discovery" under "How to use on Backend".
- `.changeset/*.md`: minor.
- `docs/reports/006-issuer-discovery.md` at wrap-up.

## Phases

### Phase 1 — Safe fetch and the profile reader

Tasks
- Add `n3` to `dependencies` (and `@types/n3` to `devDependencies` if `n3` ships no types).
- `issuerDiscovery.ts`: URL guard (`checkFetchUrl`), `safeFetch` (manual redirects, deadline,
  size cap), `readOidcIssuers` (Turtle via `n3` with the document URL as base; JSON-LD reader per
  choice 2), `fetchOidcIssuers(webId, options)` returning `{ok, issuers}` or `{ok: false, reason}`.
- Tests: Turtle profile with an issuer (prefixed, relative base, a second subject's issuer is
  ignored); JSON-LD profile (compact with inline context, expanded); redirect to the profile
  followed; `http://` non-localhost refused without a request; private IP literal refused;
  oversize body refused.

Validation: `npx linked build && node --test test/issuer-discovery.test.mjs` green.

### Phase 2 — WebFinger, fallback, skip list, timeout, cache

Tasks
- `createIssuerDiscovery(options)` with `discover(input)` (WebID if it parses as an http(s) URL,
  email if it has one `@`), `discoverFromEmail`, `discoverFromWebId`, `clearCache`.
- WebFinger request and JRD parsing (issuer link preferred over WebID link; both hrefs pass the URL
  guard), fallback reasons, skip list, domain-level negative cache, bounded TTL cache.
- Tests (the step's Verify list): WebFinger issuer link; WebFinger WebID link; no answer →
  fallback; skipped domain → fallback without a request; timeout → fallback; cache hit (one
  request for two calls) and expiry of a negative entry; typed WebID → profile issuer; typed
  WebID without issuer → `no-issuer`.

Validation: `npx linked build && node --test test/issuer-discovery.test.mjs` green; full gate
`npx linked build && npm test` green.

### Phase 3 — Docs and changeset

Tasks
- Readme section: what the module does, options and defaults, results, the safety rules, that
  nothing calls it until the Solid-OIDC sign-in (A2).
- Changeset (minor).

Validation: `npx linked build && npm test` green; readme examples match the exported names.

## Dependencies and parallel work

Phase 2 builds on phase 1's fetch and reader; phase 3 documents both. Strictly sequential. Other
agents work on A3 and A5 in this repo at the same time: they touch `backend.ts`, `index.ts` and
other `utils/` files, not this module; `package.json` and the readme may conflict, so rebase on
`main` before the PR.

## Progress

- [x] Phase 1 and Phase 2 — landed in one commit: the module was written in one piece, so the
  phase-1 commit would have carried phase 2's code anyway. Validation: `npx linked build && node
  --test test/issuer-discovery.test.mjs` → `# pass 31`, `# fail 0`; `npm test` → `# tests 352`,
  `# pass 352`, `# fail 0`. Found while testing: the JSON-LD reader URL-normalised absolute
  issuers (`https://i.test` → `https://i.test/`); fixed, absolute IRIs are kept as written since an
  issuer must match a token's `iss` exactly (Turtle already did).
- [x] Phase 3 — readme "Issuer discovery" (under How to use on Backend; every exported name and
  option in it checked against `lib/esm/utils/issuerDiscovery.d.ts`), changeset `issuer-discovery.md`
  (minor). Code unchanged since the phase-2 run, so `npm test` stands at 352/352.

## Review

An independent review of the branch (all 31 tests passing, claims checked with scratch probes):

| # | Severity | Finding |
|---|---|---|
| 1 | high | A crafted JSON-LD profile (a ~227 KB body, many contexts) blocks the event loop for ~26 s: `applyContext` copies the term map once per context, and once per array item |
| 2 | medium | IPv6 forms that carry IPv4 get through the guard: NAT64 `64:ff9b::/96`, 6to4 `2002::/16`, IPv4-compatible `::/96`, site-local `fec0::/10` |
| 3 | medium | `n3`'s default parser accepts TriG, so `<g> { <#me> solid:oidcIssuer <evil> }` is read as an assertion about the WebID |
| 4 | low | JSON-LD accepts a plain string (a literal) as an issuer; Turtle needs an IRI. The two readers disagree |
| 5 | low | `@base: null` is ignored |
| 6 | low | Scoped contexts are ignored, so a nested node is read with the wrong prefixes |
| 7 | low | A trailing dot (`https://localhost./`) gets past the loopback check |
| 8 | low | IPv4 special ranges are missing: `198.18/15`, `192.0.0/24`, `224/4`, `240/4` |
| 9 | low | A blank-node `@id` (`_:b0`) is resolved as a relative URL |
| 10 | low | Concurrent lookups of one email, domain or WebID are not de-duplicated |
| 11 | low | A bad `Location` header is reported as unreachable, so the domain is negative-cached |
| — | tests | The streaming size-cap path (no `content-length`) is untested |

## Iteration 1 — Ideation

All twelve items are taken: each is a fix inside the module, with no design choice. Items 3–6 and 9
matter beyond tidiness, because A2's issuer check relies on this reader never accepting an issuer
that the profile does not assert for the WebID.

- **Gap 1 of 12 (cost):** copy the term map once per `@context` value and apply array items in
  place. A work budget per document (map entries copied plus term definitions plus nodes visited,
  100 000) stops reading once spent; the document then counts as having no issuers. Rejected:
  only fixing the array copy, because nested nodes each carrying `@context` still copy the map per
  node.
- **Gap 2 of 12:** add `::/96`, `64:ff9b::/96`, `64:ff9b:1::/48`, `2002::/16`, `fec0::/10` and
  `ff00::/8` to the blocked list.
- **Gap 3 of 12:** pick the parser format from the content type (`N-Triples` for
  `application/n-triples`, otherwise `Turtle`, so TriG and N3 syntax is a parse error), and keep
  only default-graph quads as well.
- **Gap 4 of 12:** accept a string only when its term is coerced (`@type: @id` or `@vocab`);
  otherwise require `{"@id": …}`.
- **Gap 5 of 12:** `@base: null` means no base, so relative IRIs are dropped.
- **Gap 6 of 12:** skip the value of a term that has a scoped `@context`, and skip a node whose
  `@type` term has one. This can miss an issuer, but it never reads a wrong one.
- **Gap 7 of 12:** strip one trailing dot from the host before checking it.
- **Gap 8 of 12:** add the IPv4 ranges.
- **Gap 9 of 12:** a `_:` id is no IRI (`null`).
- **Gap 10 of 12:** keep a map of in-flight lookups by cache key, so callers share one promise.
- **Gap 11 of 12:** a bad `Location` header is a `status` failure (not cached by domain).
- **Gap 12 of 12:** a chunked response over the cap is refused (a test).

## Iteration 1 — Plan

Only `src/utils/issuerDiscovery.ts` and `test/issuer-discovery.test.mjs` change. The exports and
the result types do not change. The JSON-LD reader gains a term `type` and a `scoped` flag, a
nullable `base`, and a budget passed through `visit`/`applyContext`.

## Iteration 1 — Phases

### Phase 4: Review fixes

Tasks: gaps 1–12 as above, with a test each (the cost case asserts `readOidcIssuers` returns within
1 s on the reviewer's shapes).
Validation: `npx linked build && node --test test/issuer-discovery.test.mjs`, then `npm test`.

Phase 4 done: gaps 1–12 fixed, one test each (11 new tests). Validation:
`node --test test/issuer-discovery.test.mjs` → `# pass 42`, `# fail 0` (both of the reviewer's cost
shapes now return `[]` in under 1 s); `npm test` → `# tests 363`, `# pass 363`, `# fail 0`. Also
fixed: the readme and the `timeoutMs` comment said "one deadline per lookup", but the deadline is
per request, and an email whose WebFinger names a WebID makes two requests.
