/**
 * Issuer discovery: which Solid-OIDC issuer signs a user in, given the email or WebID they typed.
 *
 * - A **WebID** is dereferenced and its profile's `solid:oidcIssuer` values are read.
 * - For an **email**, the email's domain is asked through WebFinger (RFC 7033,
 *   `/.well-known/webfinger?resource=acct:<email>`). An issuer link
 *   (`http://openid.net/specs/connect/1.0/issuer`) names the issuer; a WebID link
 *   (`http://www.w3.org/ns/solid/terms#webid`) names the user's WebID, whose profile is read as above.
 * - When the domain gives no answer, the email goes to the default issuer (webid.email) with the
 *   email as `login_hint`. Consumer domains that never answer are skipped without a request.
 *
 * See arch-08 §Sign-in → Flow in the Create Now repo. Server-only: every lookup fetches URLs that
 * come from user input, so only `https://` is fetched (`http://` and loopback only with
 * `allowLocalhost`), IP literals in private ranges are refused, redirects are checked hop by hop,
 * each request has a deadline (redirects included) and response bodies are capped.
 *
 * Results are returned, never thrown. The module reads no environment variables: the caller passes
 * its options to `createIssuerDiscovery`.
 */
import net from 'node:net';
import { Parser } from 'n3';

/** The fallback issuer: any email can sign in through webid.email. */
export const WEBID_EMAIL_ISSUER = 'https://webid.email';

export const SOLID_OIDC_ISSUER = 'http://www.w3.org/ns/solid/terms#oidcIssuer';
export const WEBFINGER_ISSUER_REL = 'http://openid.net/specs/connect/1.0/issuer';
export const WEBFINGER_WEBID_REL = 'http://www.w3.org/ns/solid/terms#webid';

/**
 * Email domains that never answer WebFinger: their users go straight to the default issuer. A
 * short-circuit to save a request, not a security boundary.
 */
export const DEFAULT_SKIP_DOMAINS: readonly string[] = [
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'yahoo.com',
  'ymail.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'gmx.com',
  'gmx.de',
  'gmx.net',
  'web.de',
  'mail.com',
  'yandex.ru',
  'qq.com',
  '163.com',
];

export interface IssuerFetchOptions {
  /**
   * Deadline for one request, redirects included. Default 3000 ms. An email whose WebFinger names a
   * WebID makes two requests: WebFinger, then the profile.
   */
  timeoutMs?: number;
  /** Largest response body read; a larger one counts as no answer. Default 256 KB. */
  maxResponseBytes?: number;
  /** Allow `http://` and loopback hosts (`localhost`, `127.0.0.0/8`, `::1`), for development. Default `false`. */
  allowLocalhost?: boolean;
  /** Replaces the global `fetch` (tests, a custom agent). */
  fetch?: typeof fetch;
}

export interface IssuerDiscoveryOptions extends IssuerFetchOptions {
  /** Issuer for emails whose domain gives no answer. Default `WEBID_EMAIL_ISSUER`. */
  defaultIssuer?: string;
  /** Domains skipped without a request. Default `DEFAULT_SKIP_DOMAINS`. */
  skipDomains?: Iterable<string>;
  /** How long an answer (an issuer found) is cached. Default 10 minutes. */
  cacheTtlMs?: number;
  /** How long "no answer" is cached, so a domain that adds WebFinger is found again. Default 5 minutes. */
  negativeCacheTtlMs?: number;
  /** Most cached entries; the oldest goes first. Default 1000. */
  cacheMaxEntries?: number;
  /** Clock for the cache, in ms. Default `Date.now`. */
  now?: () => number;
}

export type FallbackReason =
  /** The domain is on the skip list; nothing was requested. */
  | 'skipped'
  /** WebFinger answered 404 or with no usable link. */
  | 'no-answer'
  /** WebFinger did not answer before the deadline. */
  | 'timeout'
  /** WebFinger failed: unreachable, an error status, an unreadable or refused answer. */
  | 'error'
  /** WebFinger named a WebID whose profile names no issuer (or could not be read). */
  | 'webid-without-issuer';

export type IssuerDiscoveryFailure =
  /** Neither an http(s) URL nor an email. */
  | 'invalid-input'
  /** A URL this module does not fetch (scheme, private or loopback address). */
  | 'refused'
  /** The WebID's profile could not be fetched. */
  | 'unreachable'
  /** The WebID's profile names no `solid:oidcIssuer`. */
  | 'no-issuer';

/** `issuer` is the first of `issuers`, in the order the source lists them. */
export type IssuerDiscoveryResult =
  | { ok: true; source: 'webid'; issuer: string; issuers: string[]; webId: string }
  | { ok: true; source: 'webfinger'; issuer: string; issuers: string[]; loginHint: string }
  | {
      ok: true;
      source: 'webfinger-webid';
      issuer: string;
      issuers: string[];
      webId: string;
      loginHint: string;
    }
  | {
      ok: true;
      source: 'fallback';
      issuer: string;
      issuers: string[];
      loginHint: string;
      reason: FallbackReason;
    }
  /** Only for a typed WebID or invalid input: a WebID never falls back to the default issuer. */
  | { ok: false; reason: IssuerDiscoveryFailure; webId?: string };

export type ProfileIssuersResult =
  | { ok: true; webId: string; issuers: string[] }
  | { ok: false; webId?: string; reason: 'invalid-input' | 'refused' | 'unreachable' };

export interface IssuerDiscovery {
  /** A WebID when the input is an http(s) URL, an email when it holds an `@`. */
  discover(input: string): Promise<IssuerDiscoveryResult>;
  discoverFromEmail(email: string): Promise<IssuerDiscoveryResult>;
  discoverFromWebId(webId: string): Promise<IssuerDiscoveryResult>;
  clearCache(): void;
}

const MAX_REDIRECTS = 3;
const MAX_JSON_DEPTH = 32;
const PROFILE_ACCEPT = 'text/turtle, application/ld+json;q=0.9, application/json;q=0.5';
const WEBFINGER_ACCEPT = 'application/jrd+json, application/json;q=0.9';

type ResolvedFetchOptions = Required<IssuerFetchOptions>;

const resolveFetchOptions = (options: IssuerFetchOptions): ResolvedFetchOptions => ({
  timeoutMs: options.timeoutMs ?? 3000,
  maxResponseBytes: options.maxResponseBytes ?? 256 * 1024,
  allowLocalhost: options.allowLocalhost ?? false,
  fetch: options.fetch ?? globalThis.fetch,
});

// ---------------------------------------------------------------------------------------------
// Which URLs are fetched
// ---------------------------------------------------------------------------------------------

const loopbackAddresses = new net.BlockList();
loopbackAddresses.addSubnet('127.0.0.0', 8, 'ipv4');
loopbackAddresses.addAddress('::1', 'ipv6');

// Addresses a request must never reach, whatever the scheme. A BlockList also matches the
// IPv4-mapped IPv6 form of an IPv4 range.
const privateAddresses = new net.BlockList();
privateAddresses.addSubnet('0.0.0.0', 8, 'ipv4');
privateAddresses.addSubnet('10.0.0.0', 8, 'ipv4');
privateAddresses.addSubnet('100.64.0.0', 10, 'ipv4');
privateAddresses.addSubnet('169.254.0.0', 16, 'ipv4');
privateAddresses.addSubnet('172.16.0.0', 12, 'ipv4');
privateAddresses.addSubnet('192.0.0.0', 24, 'ipv4');
privateAddresses.addSubnet('192.168.0.0', 16, 'ipv4');
privateAddresses.addSubnet('198.18.0.0', 15, 'ipv4');
privateAddresses.addSubnet('224.0.0.0', 4, 'ipv4');
privateAddresses.addSubnet('240.0.0.0', 4, 'ipv4');
// IPv6: unspecified and IPv4-compatible, NAT64 and 6to4 (which carry an IPv4 address), unique-local,
// link-local, site-local and multicast.
privateAddresses.addSubnet('::', 96, 'ipv6');
privateAddresses.addSubnet('64:ff9b::', 96, 'ipv6');
privateAddresses.addSubnet('64:ff9b:1::', 48, 'ipv6');
privateAddresses.addSubnet('2002::', 16, 'ipv6');
privateAddresses.addSubnet('fc00::', 7, 'ipv6');
privateAddresses.addSubnet('fe80::', 10, 'ipv6');
privateAddresses.addSubnet('fec0::', 10, 'ipv6');
privateAddresses.addSubnet('ff00::', 8, 'ipv6');
// Teredo (carries an IPv4 address), discard-only and documentation
privateAddresses.addSubnet('2001::', 32, 'ipv6');
privateAddresses.addSubnet('100::', 64, 'ipv6');
privateAddresses.addSubnet('2001:db8::', 32, 'ipv6');

const ipFamily = (host: string): 'ipv4' | 'ipv6' | null => {
  const version = net.isIP(host);
  return version === 4 ? 'ipv4' : version === 6 ? 'ipv6' : null;
};

const isLoopbackHost = (host: string): boolean => {
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return true;
  }
  const family = ipFamily(host);
  return family !== null && loopbackAddresses.check(host, family);
};

/**
 * Whether this module may fetch `href`: `https://` to a public host, or with `allowLocalhost`
 * also `http://` and loopback hosts. Host names are not resolved here, so a public name that
 * resolves to a private address is not caught.
 */
export const isFetchableUrl = (href: string, allowLocalhost = false): boolean => {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return false;
  }
  if (url.username || url.password) {
    return false;
  }
  // `localhost.` is `localhost`: drop the trailing dots of a fully qualified name before checking.
  const hostname = url.hostname.replace(/\.+$/, '');
  const host = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
  if (isLoopbackHost(host)) {
    return allowLocalhost;
  }
  if (url.protocol !== 'https:') {
    return false;
  }
  const family = ipFamily(host);
  return family === null || !privateAddresses.check(host, family);
};

/**
 * Whether a resolved IP address must not be connected to: one in a private range, or a loopback
 * address without `allowLocalhost`. Anything that is not an IP address is refused. This is the
 * check `isFetchableUrl` makes on IP literals, for the addresses a host name resolves to (see
 * `guardedFetch.ts`).
 */
export const isBlockedAddress = (address: string, allowLocalhost = false): boolean => {
  const family = ipFamily(address);
  if (family === null) {
    return true;
  }
  if (loopbackAddresses.check(address, family)) {
    return !allowLocalhost;
  }
  return privateAddresses.check(address, family);
};

// ---------------------------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------------------------

type FetchFailure = 'refused' | 'timeout' | 'unreachable' | 'not-found' | 'status' | 'too-large';

type FetchOutcome =
  | { ok: true; url: string; body: string; contentType: string }
  | { ok: false; failure: FetchFailure };

/** The body as text, or `null` when it is larger than `maxBytes`. */
const readLimitedBody = async (response: Response, maxBytes: number): Promise<string | null> => {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    return null;
  }
  if (!response.body) {
    return '';
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
};

/** GET `url`, following at most `MAX_REDIRECTS` redirects, each one checked like the first URL. */
const fetchDocument = async (
  url: string,
  accept: string,
  options: ResolvedFetchOptions,
): Promise<FetchOutcome> => {
  const signal = AbortSignal.timeout(options.timeoutMs);
  let current = url;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!isFetchableUrl(current, options.allowLocalhost)) {
        return { ok: false, failure: 'refused' };
      }
      const response = await options.fetch(current, {
        headers: { accept },
        redirect: 'manual',
        signal,
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) {
          return { ok: false, failure: 'status' };
        }
        try {
          current = new URL(location, current).href;
        } catch {
          return { ok: false, failure: 'status' };
        }
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        const missing = response.status === 404 || response.status === 410;
        return { ok: false, failure: missing ? 'not-found' : 'status' };
      }
      const body = await readLimitedBody(response, options.maxResponseBytes);
      if (body === null) {
        return { ok: false, failure: 'too-large' };
      }
      return { ok: true, url: current, body, contentType: response.headers.get('content-type') ?? '' };
    }
    return { ok: false, failure: 'status' };
  } catch {
    return { ok: false, failure: signal.aborted ? 'timeout' : 'unreachable' };
  }
};

// ---------------------------------------------------------------------------------------------
// Reading a profile
// ---------------------------------------------------------------------------------------------

const normaliseIri = (iri: string): string | null => {
  try {
    return new URL(iri).href;
  } catch {
    return null;
  }
};

/** What a profile value is read as: an IRI (`solid:oidcIssuer`) or a plain string literal (`foaf:name`). */
type ValueKind = 'iri' | 'literal';

const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';
const RDF_LANG_STRING = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString';

/**
 * Turtle or N-Triples, never TriG or N3: a statement inside a named graph or a formula is quoted,
 * not asserted, so only default-graph triples count. A literal counts only as a plain or
 * language-tagged string.
 */
const readTurtleValues = (
  body: string,
  mediaType: string,
  documentUrl: string,
  webId: string,
  predicate: string,
  kind: ValueKind,
): string[] => {
  const format = mediaType === 'application/n-triples' ? 'N-Triples' : 'Turtle';
  const quads = new Parser({ baseIRI: documentUrl, format }).parse(body);
  return quads
    .filter(
      (quad) =>
        quad.graph.termType === 'DefaultGraph' &&
        quad.subject.termType === 'NamedNode' &&
        normaliseIri(quad.subject.value) === webId &&
        quad.predicate.value === predicate &&
        (kind === 'iri'
          ? quad.object.termType === 'NamedNode'
          : quad.object.termType === 'Literal' &&
            [XSD_STRING, RDF_LANG_STRING].includes(quad.object.datatype.value)),
    )
    .map((quad) => quad.object.value);
};

/** `type` is the term's `@type` coercion; `scoped` marks a term with its own `@context`. */
type JsonLdTerm = { id: string; type: string | null; scoped: boolean };
type JsonLdContext = { base: string | null; vocab: string | null; terms: Map<string, JsonLdTerm> };

/** Work allowed on one JSON-LD document: term-map entries copied, terms defined, nodes visited. */
const JSON_LD_BUDGET = 100_000;

class JsonLdBudgetSpent extends Error {}

type Budget = { remaining: number };

const spend = (budget: Budget, units: number) => {
  budget.remaining -= units;
  if (budget.remaining < 0) {
    throw new JsonLdBudgetSpent();
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasScheme = (value: string) => /^[a-z][a-z0-9+.-]*:/i.test(value);

/** A key or a compact IRI to a full IRI, by the context's terms, prefixes and `@vocab`. */
const expandKey = (key: string, context: JsonLdContext, depth = 0): string | null => {
  const term = context.terms.get(key);
  if (term) {
    return depth < 4 ? (expandKey(term.id, context, depth + 1) ?? term.id) : term.id;
  }
  const colon = key.indexOf(':');
  if (colon > 0) {
    const prefix = context.terms.get(key.slice(0, colon));
    const suffix = key.slice(colon + 1);
    if (prefix && !suffix.startsWith('//')) {
      return prefix.id + suffix;
    }
    return hasScheme(key) ? key : null;
  }
  return context.vocab ? context.vocab + key : null;
};

/**
 * An `@id` value to a full IRI: a compact IRI by the context's prefixes, a relative one against
 * `@base`. An absolute IRI is kept as written, since an issuer must match a token's `iss` exactly.
 * A blank node id (`_:b0`) is no IRI.
 */
const expandId = (value: string, context: JsonLdContext): string | null => {
  if (value.startsWith('_:')) {
    return null;
  }
  const colon = value.indexOf(':');
  if (colon > 0 && !value.slice(colon + 1).startsWith('//')) {
    const prefix = context.terms.get(value.slice(0, colon));
    if (prefix) {
      return prefix.id + value.slice(colon + 1);
    }
  }
  if (hasScheme(value)) {
    return value;
  }
  if (context.base === null) {
    return null;
  }
  try {
    return new URL(value, context.base).href;
  } catch {
    return null;
  }
};

/** Applies an `@context` value to `target` in place. Remote contexts (strings) are not fetched and add nothing. */
const applyContextInto = (target: JsonLdContext, value: unknown, documentUrl: string, budget: Budget) => {
  if (value === null) {
    target.base = documentUrl;
    target.vocab = null;
    target.terms.clear();
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => applyContextInto(target, item, documentUrl, budget));
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  spend(budget, 1);
  if (typeof value['@base'] === 'string') {
    target.base = target.base === null ? null : new URL(value['@base'], target.base).href;
  } else if (value['@base'] === null) {
    target.base = null;
  }
  if (typeof value['@vocab'] === 'string') {
    target.vocab = value['@vocab'];
  } else if (value['@vocab'] === null) {
    target.vocab = null;
  }
  for (const [key, definition] of Object.entries(value)) {
    if (key.startsWith('@')) {
      continue;
    }
    spend(budget, 1);
    if (typeof definition === 'string') {
      target.terms.set(key, { id: definition, type: null, scoped: false });
    } else if (isRecord(definition) && typeof definition['@id'] === 'string') {
      target.terms.set(key, {
        id: definition['@id'],
        type: typeof definition['@type'] === 'string' ? definition['@type'] : null,
        scoped: '@context' in definition,
      });
    } else if (isRecord(definition) && '@context' in definition) {
      // A term that only adds a scoped context (e.g. one for a @type).
      target.terms.set(key, { id: key, type: null, scoped: true });
    } else if (definition === null) {
      target.terms.delete(key);
    }
  }
};

const applyContext = (context: JsonLdContext, value: unknown, documentUrl: string, budget: Budget): JsonLdContext => {
  spend(budget, context.terms.size + 1);
  const next: JsonLdContext = { base: context.base, vocab: context.vocab, terms: new Map(context.terms) };
  applyContextInto(next, value, documentUrl, budget);
  return next;
};

/** Whether a node's `@type` names a term with a scoped context, which this reader does not apply. */
const hasTypeScopedContext = (node: Record<string, unknown>, context: JsonLdContext) => {
  const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
  return types.some((type) => typeof type === 'string' && context.terms.get(type)?.scoped);
};

/** A string node value as a literal: only where its term is not coerced, or coerced to `xsd:string`. */
const literalOf = (item: unknown, term: JsonLdTerm | undefined, context: JsonLdContext): string | null => {
  if (typeof item === 'string') {
    if (!term?.type) {
      return item;
    }
    return expandKey(term.type, context) === XSD_STRING || term.type === XSD_STRING ? item : null;
  }
  if (isRecord(item) && typeof item['@value'] === 'string') {
    const type = item['@type'];
    if (type === undefined) {
      return item['@value'];
    }
    return typeof type === 'string' && (type === XSD_STRING || expandKey(type, context) === XSD_STRING)
      ? item['@value']
      : null;
  }
  return null;
};

/** A node value as an IRI: an `{"@id"}` object, or a string where its term is coerced with `@type: @id`. */
const iriOf = (item: unknown, term: JsonLdTerm | undefined, context: JsonLdContext): string | null => {
  if (typeof item === 'string') {
    return term?.type === '@id' ? expandId(item, context) : null;
  }
  return isRecord(item) && typeof item['@id'] === 'string' ? expandId(item['@id'], context) : null;
};

/**
 * Reads `predicate` of `webId` from a JSON-LD document without a JSON-LD processor: full and
 * compact IRIs, terms from inline contexts, `@vocab`, `@base`, `@graph` and nested nodes. It may
 * miss a value but never reads one the document does not assert: a remote `@context` is never
 * fetched (terms only it defines are not understood), values under a scoped context are skipped, a
 * plain string counts as an IRI only where its term is coerced with `@type: @id` (and as a literal
 * only where it is not coerced to anything but `xsd:string`), and a document that costs more than
 * `JSON_LD_BUDGET` to read has no values.
 */
const readJsonLdValues = (
  body: string,
  documentUrl: string,
  webId: string,
  predicate: string,
  kind: ValueKind,
): string[] => {
  let document: unknown;
  try {
    document = JSON.parse(body);
  } catch {
    return [];
  }
  const values: string[] = [];
  const budget: Budget = { remaining: JSON_LD_BUDGET };
  const visit = (node: unknown, inherited: JsonLdContext, depth: number) => {
    if (depth > MAX_JSON_DEPTH) {
      return;
    }
    spend(budget, 1);
    if (Array.isArray(node)) {
      node.forEach((item) => visit(item, inherited, depth + 1));
      return;
    }
    if (!isRecord(node)) {
      return;
    }
    const context =
      '@context' in node ? applyContext(inherited, node['@context'], documentUrl, budget) : inherited;
    if (hasTypeScopedContext(node, context)) {
      return;
    }
    const id = typeof node['@id'] === 'string' ? expandId(node['@id'], context) : null;
    const subject = id ? normaliseIri(id) : null;
    for (const [key, value] of Object.entries(node)) {
      if (key === '@graph') {
        visit(value, context, depth + 1);
        continue;
      }
      if (key.startsWith('@') || context.terms.get(key)?.scoped) {
        continue;
      }
      if (subject === webId && expandKey(key, context) === predicate) {
        const term = context.terms.get(key);
        for (const item of Array.isArray(value) ? value : [value]) {
          const read = kind === 'iri' ? iriOf(item, term, context) : literalOf(item, term, context);
          if (read !== null) {
            values.push(read);
          }
        }
      }
      visit(value, context, depth + 1);
    }
  };
  try {
    visit(document, { base: documentUrl, vocab: null, terms: new Map() }, 0);
  } catch (error) {
    if (error instanceof JsonLdBudgetSpent) {
      return [];
    }
    throw error;
  }
  return values;
};

/**
 * The `predicate` values of `webId` in a profile document: Turtle or N-Triples (the default,
 * parsed with `n3`) or JSON-LD (by content type). Statements about other subjects, and statements
 * in named graphs, are ignored. An unreadable document has no values.
 */
const readProfileValues = (
  body: string,
  contentType: string,
  documentUrl: string,
  webId: string,
  predicate: string,
  kind: ValueKind,
): string[] => {
  const subject = normaliseIri(webId);
  if (!subject) {
    return [];
  }
  const mediaType = contentType.split(';')[0].trim().toLowerCase();
  const isJson = mediaType === 'application/json' || mediaType.endsWith('+json');
  try {
    const values = isJson
      ? readJsonLdValues(body, documentUrl, subject, predicate, kind)
      : readTurtleValues(body, mediaType, documentUrl, subject, predicate, kind);
    return [...new Set(values)];
  } catch {
    return [];
  }
};

/**
 * The string literals of `predicate` (a full IRI, e.g. `foaf:name`'s) that a profile document
 * states about `webId`, read as `readOidcIssuers` reads issuers: Turtle or N-Triples, or JSON-LD by
 * content type; other subjects, named graphs, typed non-string literals and IRIs are ignored.
 */
export const readProfileLiterals = (
  body: string,
  contentType: string,
  documentUrl: string,
  webId: string,
  predicate: string,
): string[] => readProfileValues(body, contentType, documentUrl, webId, predicate, 'literal');

/**
 * The `solid:oidcIssuer` values of `webId` in a profile document: Turtle or N-Triples (the default,
 * parsed with `n3`) or JSON-LD (by content type). Statements about other subjects, and statements
 * in named graphs, are ignored. An unreadable document has no issuers.
 */
export const readOidcIssuers = (
  body: string,
  contentType: string,
  documentUrl: string,
  webId: string,
): string[] => readProfileValues(body, contentType, documentUrl, webId, SOLID_OIDC_ISSUER, 'iri');

/** A typed WebID as a normalised http(s) IRI, or `null`. */
const parseWebId = (input: string): string | null => {
  const iri = typeof input === 'string' ? normaliseIri(input.trim()) : null;
  return iri && /^https?:/.test(iri) ? iri : null;
};

const profileIssuers = async (webId: string, options: ResolvedFetchOptions): Promise<ProfileIssuersResult> => {
  const documentUrl = new URL(webId);
  documentUrl.hash = '';
  const fetched = await fetchDocument(documentUrl.href, PROFILE_ACCEPT, options);
  if ('failure' in fetched) {
    return { ok: false, webId, reason: fetched.failure === 'refused' ? 'refused' : 'unreachable' };
  }
  const issuers = readOidcIssuers(fetched.body, fetched.contentType, fetched.url, webId).filter(
    (issuer) => isFetchableUrl(issuer, options.allowLocalhost),
  );
  return { ok: true, webId, issuers };
};

/**
 * Fetches `webId`'s profile and returns its `solid:oidcIssuer` values (possibly none). Issuers this
 * module would not fetch are left out. Not cached; `createIssuerDiscovery` caches its own lookups.
 */
export const fetchOidcIssuers = async (
  webId: string,
  options: IssuerFetchOptions = {},
): Promise<ProfileIssuersResult> => {
  const iri = parseWebId(webId);
  if (!iri) {
    return { ok: false, reason: 'invalid-input' };
  }
  return profileIssuers(iri, resolveFetchOptions(options));
};

// ---------------------------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------------------------

class TtlCache<V> {
  private entries = new Map<string, { value: V; expires: number }>();

  constructor(
    private maxEntries: number,
    private now: () => number,
  ) {}

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expires <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V, ttlMs: number) {
    if (ttlMs <= 0 || this.maxEntries <= 0) {
      return;
    }
    this.entries.delete(key);
    while (this.entries.size >= this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value as string);
    }
    this.entries.set(key, { value, expires: this.now() + ttlMs });
  }

  clear() {
    this.entries.clear();
  }
}

/** A normalised email (`trim(lowercase(email))`, as WebID derivation does) and its domain's host. */
const parseEmail = (input: string): { email: string; host: string } | null => {
  if (typeof input !== 'string') {
    return null;
  }
  const email = input.trim().toLowerCase();
  const at = email.indexOf('@');
  if (at <= 0 || at !== email.lastIndexOf('@')) {
    return null;
  }
  const domain = email.slice(at + 1);
  if (!/^[^\s/?#\\:[\]%]+$/.test(domain) || !domain.includes('.')) {
    return null;
  }
  try {
    return { email, host: new URL(`https://${domain}`).hostname };
  } catch {
    return null;
  }
};

type WebFingerLinks = { issuer: string | null; webId: string | null };

const readWebFingerLinks = (body: string, allowLocalhost: boolean): WebFingerLinks | null => {
  let jrd: unknown;
  try {
    jrd = JSON.parse(body);
  } catch {
    return null;
  }
  const links = isRecord(jrd) && Array.isArray(jrd.links) ? jrd.links : [];
  const href = (rel: string) => {
    const link = links.find(
      (item) =>
        isRecord(item) &&
        item.rel === rel &&
        typeof item.href === 'string' &&
        isFetchableUrl(item.href, allowLocalhost),
    );
    return isRecord(link) ? (link.href as string) : null;
  };
  return { issuer: href(WEBFINGER_ISSUER_REL), webId: href(WEBFINGER_WEBID_REL) };
};

const freeze = <T extends IssuerDiscoveryResult>(result: T): T => {
  if (result.ok) {
    Object.freeze(result.issuers);
  }
  return Object.freeze(result);
};

/**
 * An issuer discovery with its own cache. Answers are cached for `cacheTtlMs`, no-answers for
 * `negativeCacheTtlMs`; a domain whose WebFinger timed out or was unreachable is remembered for
 * `negativeCacheTtlMs`, so its next user is not kept waiting. Concurrent lookups of the same email
 * or WebID share one request.
 */
export const createIssuerDiscovery = (options: IssuerDiscoveryOptions = {}): IssuerDiscovery => {
  const fetchOptions = resolveFetchOptions(options);
  const defaultIssuer = options.defaultIssuer ?? WEBID_EMAIL_ISSUER;
  if (!isFetchableUrl(defaultIssuer, fetchOptions.allowLocalhost)) {
    throw new Error(`createIssuerDiscovery: defaultIssuer is not a fetchable URL: ${defaultIssuer}`);
  }
  const skipDomains = new Set(
    [...(options.skipDomains ?? DEFAULT_SKIP_DOMAINS)].map((domain) => domain.trim().toLowerCase()),
  );
  const ttl = options.cacheTtlMs ?? 10 * 60 * 1000;
  const negativeTtl = options.negativeCacheTtlMs ?? 5 * 60 * 1000;
  const cache = new TtlCache<IssuerDiscoveryResult | ProfileIssuersResult | FallbackReason>(
    options.cacheMaxEntries ?? 1000,
    options.now ?? Date.now,
  );
  // Lookups under way, by cache key: concurrent callers share one request.
  const inFlight = new Map<string, Promise<unknown>>();
  const once = <T>(key: string, run: () => Promise<T>): Promise<T> => {
    const pending = inFlight.get(key) as Promise<T> | undefined;
    if (pending) {
      return pending;
    }
    const promise = run().finally(() => inFlight.delete(key));
    inFlight.set(key, promise);
    return promise;
  };

  const cachedProfileIssuers = async (webId: string): Promise<ProfileIssuersResult> => {
    const key = `webid ${webId}`;
    const hit = cache.get(key) as ProfileIssuersResult | undefined;
    if (hit) {
      return hit;
    }
    return once(key, async () => {
      const result = await profileIssuers(webId, fetchOptions);
      cache.set(key, result, result.ok && result.issuers.length ? ttl : negativeTtl);
      return result;
    });
  };

  const fallback = (loginHint: string, reason: FallbackReason) =>
    freeze({ ok: true, source: 'fallback', issuer: defaultIssuer, issuers: [defaultIssuer], loginHint, reason });

  const discoverFromWebId = async (input: string): Promise<IssuerDiscoveryResult> => {
    const webId = parseWebId(input);
    if (!webId) {
      return freeze({ ok: false, reason: 'invalid-input' });
    }
    const profile = await cachedProfileIssuers(webId);
    if ('reason' in profile) {
      return freeze({ ok: false, reason: profile.reason, webId });
    }
    if (!profile.issuers.length) {
      return freeze({ ok: false, reason: 'no-issuer', webId });
    }
    return freeze({ ok: true, source: 'webid', issuer: profile.issuers[0], issuers: profile.issuers, webId });
  };

  const lookUpEmail = async (email: string, host: string): Promise<IssuerDiscoveryResult> => {
    const domainFailure = cache.get(`domain ${host}`) as FallbackReason | undefined;
    if (domainFailure) {
      return fallback(email, domainFailure);
    }
    const url = `https://${host}/.well-known/webfinger?resource=${encodeURIComponent(`acct:${email}`)}`;
    const fetched = await fetchDocument(url, WEBFINGER_ACCEPT, fetchOptions);
    if ('failure' in fetched) {
      if (fetched.failure === 'timeout' || fetched.failure === 'unreachable') {
        const reason = fetched.failure === 'timeout' ? 'timeout' : 'error';
        cache.set(`domain ${host}`, reason, negativeTtl);
        return fallback(email, reason);
      }
      return fallback(email, fetched.failure === 'not-found' ? 'no-answer' : 'error');
    }
    const links = readWebFingerLinks(fetched.body, fetchOptions.allowLocalhost);
    if (!links) {
      return fallback(email, 'error');
    }
    if (links.issuer) {
      return freeze({ ok: true, source: 'webfinger', issuer: links.issuer, issuers: [links.issuer], loginHint: email });
    }
    if (links.webId) {
      const webId = parseWebId(links.webId);
      const profile = webId ? await cachedProfileIssuers(webId) : null;
      if (webId && profile?.ok && profile.issuers.length) {
        return freeze({
          ok: true,
          source: 'webfinger-webid',
          issuer: profile.issuers[0],
          issuers: profile.issuers,
          webId,
          loginHint: email,
        });
      }
      return fallback(email, 'webid-without-issuer');
    }
    return fallback(email, 'no-answer');
  };

  const discoverFromEmail = async (input: string): Promise<IssuerDiscoveryResult> => {
    const parsed = parseEmail(input);
    if (!parsed) {
      return freeze({ ok: false, reason: 'invalid-input' });
    }
    const { email, host } = parsed;
    if (skipDomains.has(host)) {
      return fallback(email, 'skipped');
    }
    const key = `email ${email}`;
    const hit = cache.get(key) as IssuerDiscoveryResult | undefined;
    if (hit) {
      return hit;
    }
    return once(key, async () => {
      const result = await lookUpEmail(email, host);
      cache.set(key, result, result.ok && result.source !== 'fallback' ? ttl : negativeTtl);
      return result;
    });
  };

  const discover = (input: string): Promise<IssuerDiscoveryResult> => {
    const trimmed = typeof input === 'string' ? input.trim() : '';
    if (/^https?:\/\//i.test(trimmed)) {
      return discoverFromWebId(trimmed);
    }
    if (trimmed.includes('@')) {
      return discoverFromEmail(trimmed);
    }
    return Promise.resolve(freeze({ ok: false, reason: 'invalid-input' }));
  };

  const clearCache = () => {
    cache.clear();
    inFlight.clear();
  };

  return { discover, discoverFromEmail, discoverFromWebId, clearCache };
};
