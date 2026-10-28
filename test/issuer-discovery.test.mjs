// Issuer discovery: a WebID's profile → solid:oidcIssuer, an email → WebFinger (issuer link or
// WebID link) → the default issuer when the domain gives no answer; the URL guard, the timeout,
// the size cap and the cache.
//
// Runs against the BUILT package in lib/ (build first: `npx linked build`). The fixture is a local
// HTTP server; `fetch` is replaced so `https://<host>/<path>` reaches it as `/<host>/<path>`.
import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const {
  createIssuerDiscovery,
  fetchOidcIssuers,
  readOidcIssuers,
  readProfileLiterals,
  isFetchableUrl,
  WEBID_EMAIL_ISSUER,
  DEFAULT_SKIP_DOMAINS,
} = await import('../lib/esm/utils/issuerDiscovery.js');

const SOLID = 'http://www.w3.org/ns/solid/terms#';
const ISSUER_REL = 'http://openid.net/specs/connect/1.0/issuer';
const WEBID_REL = `${SOLID}webid`;

// path → handler(request, response); paths are '/<host>/<rest>' for rewritten https requests.
const routes = new Map();
const requests = [];
let server;
let origin;

before(async () => {
  server = http.createServer((request, response) => {
    requests.push(request.url);
    const path = request.url.split('?')[0];
    const handler = routes.get(path);
    if (!handler) {
      response.writeHead(404).end();
      return;
    }
    handler(request, response);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

beforeEach(() => {
  routes.clear();
  requests.length = 0;
});

/** Sends `https://host/path?q` to the fixture as `/host/path?q`; other URLs pass through. */
const fixtureFetch = (url, init) => {
  const parsed = new URL(url);
  if (parsed.protocol === 'https:') {
    return fetch(`${origin}/${parsed.host}${parsed.pathname}${parsed.search}`, init);
  }
  return fetch(url, init);
};

const serve = (path, contentType, body, status = 200) =>
  routes.set(path, (request, response) => {
    response.writeHead(status, { 'content-type': contentType }).end(body);
  });

const serveJrd = (host, links) =>
  serve(`/${host}/.well-known/webfinger`, 'application/jrd+json', JSON.stringify({ subject: 'x', links }));

const turtleProfile = (issuers) => `
@prefix solid: <${SOLID}> .
@prefix foaf: <http://xmlns.com/foaf/0.1/> .
<#me> a foaf:Person ;
  ${issuers.map((issuer) => `solid:oidcIssuer <${issuer}>`).join(' ;\n  ')} .
<#other> solid:oidcIssuer <https://not-mine.test> .
`;

const discovery = (options = {}) =>
  createIssuerDiscovery({ fetch: fixtureFetch, allowLocalhost: true, ...options });

describe('isFetchableUrl', () => {
  test('https to a public host is fetched', () => {
    assert.equal(isFetchableUrl('https://pod.example/profile/card#me'), true);
    assert.equal(isFetchableUrl('https://8.8.8.8/'), true);
  });

  test('http, other schemes and credentials are refused', () => {
    assert.equal(isFetchableUrl('http://pod.example/'), false);
    assert.equal(isFetchableUrl('ftp://pod.example/'), false);
    assert.equal(isFetchableUrl('file:///etc/passwd'), false);
    assert.equal(isFetchableUrl('https://user:pw@pod.example/'), false);
    assert.equal(isFetchableUrl('not a url'), false);
  });

  test('private, link-local and unique-local addresses are refused, mapped forms included', () => {
    for (const url of [
      'https://10.1.2.3/',
      'https://172.16.0.1/',
      'https://192.168.1.1/',
      'https://169.254.169.254/latest/meta-data',
      'https://100.64.0.1/',
      'https://0.0.0.0/',
      'https://[fd00::1]/',
      'https://[fe80::1]/',
      'https://[::ffff:10.0.0.1]/',
      'https://0x0a.0.0.1/',
      'https://192.0.0.1/',
      'https://198.18.0.1/',
      'https://224.0.0.1/',
      'https://255.255.255.255/',
      'https://[::7f00:1]/',
      'https://[64:ff9b::a9fe:a9fe]/',
      'https://[64:ff9b:1::1]/',
      'https://[2002:7f00:1::]/',
      'https://[fec0::1]/',
      'https://[ff02::1]/',
    ]) {
      assert.equal(isFetchableUrl(url, true), false, url);
    }
  });

  test('loopback only with allowLocalhost, and then over http too', () => {
    for (const url of ['http://localhost:4050/', 'https://127.0.0.1/', 'http://[::1]:3000/', 'http://app.localhost/']) {
      assert.equal(isFetchableUrl(url), false, url);
      assert.equal(isFetchableUrl(url, true), true, url);
    }
  });

  test('a trailing dot does not hide a loopback host', () => {
    assert.equal(isFetchableUrl('https://localhost./'), false);
    assert.equal(isFetchableUrl('https://app.localhost./'), false);
    assert.equal(isFetchableUrl('https://localhost../'), false);
    assert.equal(isFetchableUrl('https://pod.example./'), true);
  });
});

describe('readOidcIssuers', () => {
  const doc = 'https://pod.example/profile/card';
  const webId = `${doc}#me`;

  test('Turtle: the WebID’s issuers, relative to the document, other subjects ignored', () => {
    const issuers = readOidcIssuers(
      turtleProfile(['https://issuer.one', 'https://issuer.two/', 'https://issuer.one']),
      'text/turtle',
      doc,
      webId,
    );
    assert.deepEqual(issuers, ['https://issuer.one', 'https://issuer.two/']);
  });

  test('Turtle is the default when the content type says nothing', () => {
    assert.deepEqual(readOidcIssuers(turtleProfile(['https://i.test']), '', doc, webId), ['https://i.test']);
  });

  test('JSON-LD: compact with an inline context', () => {
    const body = JSON.stringify({
      '@context': { solid: SOLID, oidcIssuer: { '@id': 'solid:oidcIssuer', '@type': '@id' } },
      '@id': '#me',
      oidcIssuer: 'https://i.test',
      knows: { '@id': 'https://friend.example/#me', 'solid:oidcIssuer': { '@id': 'https://not-mine.test' } },
    });
    assert.deepEqual(readOidcIssuers(body, 'application/ld+json; charset=utf-8', doc, webId), ['https://i.test']);
  });

  test('JSON-LD: expanded, in a @graph', () => {
    const body = JSON.stringify({
      '@graph': [{ '@id': webId, [`${SOLID}oidcIssuer`]: [{ '@id': 'https://i.test' }] }],
    });
    assert.deepEqual(readOidcIssuers(body, 'application/ld+json', doc, webId), ['https://i.test']);
  });

  test('JSON-LD: a remote context is not fetched, so its terms are not understood', () => {
    const body = JSON.stringify({ '@context': 'https://contexts.example/solid', '@id': '#me', oidcIssuer: 'https://i.test' });
    assert.deepEqual(readOidcIssuers(body, 'application/ld+json', doc, webId), []);
  });

  test('Turtle: a statement in a named graph is not an assertion, so TriG is not read', () => {
    const trig = `<http://g> { <#me> <${SOLID}oidcIssuer> <https://evil.example> }`;
    assert.deepEqual(readOidcIssuers(trig, 'text/turtle', doc, webId), []);
    assert.deepEqual(readOidcIssuers(trig, 'application/trig', doc, webId), []);
  });

  test('N-Triples', () => {
    const nt = `<${webId}> <${SOLID}oidcIssuer> <https://i.test> .`;
    assert.deepEqual(readOidcIssuers(nt, 'application/n-triples', doc, webId), ['https://i.test']);
  });

  test('JSON-LD: a plain string is an issuer only where its term is coerced to an IRI', () => {
    const body = JSON.stringify({ '@id': webId, [`${SOLID}oidcIssuer`]: 'https://literal.example' });
    assert.deepEqual(readOidcIssuers(body, 'application/ld+json', doc, webId), []);
    const typed = JSON.stringify({
      '@context': { oidcIssuer: { '@id': `${SOLID}oidcIssuer`, '@type': '@id' } },
      '@id': webId,
      oidcIssuer: 'https://i.test',
    });
    assert.deepEqual(readOidcIssuers(typed, 'application/ld+json', doc, webId), ['https://i.test']);
    const vocab = JSON.stringify({
      '@context': { '@vocab': 'https://v.example/', iss: { '@id': `${SOLID}oidcIssuer`, '@type': '@vocab' } },
      '@id': webId,
      iss: 'x',
    });
    assert.deepEqual(readOidcIssuers(vocab, 'application/ld+json', doc, webId), []);
  });

  test('JSON-LD: with @base null a relative id is no IRI', () => {
    const body = JSON.stringify({
      '@context': { '@base': null },
      '@id': '#me',
      [`${SOLID}oidcIssuer`]: { '@id': 'https://i.test' },
    });
    assert.deepEqual(readOidcIssuers(body, 'application/ld+json', doc, webId), []);
  });

  test('JSON-LD: values under a scoped context are skipped', () => {
    const body = JSON.stringify({
      '@context': { s: SOLID, inner: { '@id': 'https://x.example/inner', '@context': { s: 'https://other.example/' } } },
      inner: { '@id': webId, 's:oidcIssuer': { '@id': 'https://evil.example' } },
    });
    assert.deepEqual(readOidcIssuers(body, 'application/ld+json', doc, webId), []);
    const typeScoped = JSON.stringify({
      '@context': { s: SOLID, Card: { '@id': 'https://x.example/Card', '@context': { s: 'https://other.example/' } } },
      '@id': webId,
      '@type': 'Card',
      's:oidcIssuer': { '@id': 'https://evil.example' },
    });
    assert.deepEqual(readOidcIssuers(typeScoped, 'application/ld+json', doc, webId), []);
  });

  test('JSON-LD: a blank node id is not resolved as a relative IRI', () => {
    const body = JSON.stringify({ '@id': '_:me', [`${SOLID}oidcIssuer`]: { '@id': 'https://i.test' } });
    assert.deepEqual(readOidcIssuers(body, 'application/ld+json', `https://pod.example/`, 'https://pod.example/_:me'), []);
  });

  test('JSON-LD: a document too costly to read has no issuers, and is given up quickly', () => {
    const terms = Object.fromEntries(Array.from({ length: 9000 }, (_, i) => [`t${i}`, `https://t.example/${i}`]));
    const shapes = [
      { '@context': [terms, ...Array.from({ length: 40000 }, () => ({}))], '@id': webId },
      { '@context': terms, '@graph': Array.from({ length: 9000 }, () => ({ '@context': {}, '@id': webId })) },
    ];
    for (const shape of shapes) {
      const started = Date.now();
      assert.deepEqual(readOidcIssuers(JSON.stringify(shape), 'application/ld+json', doc, webId), []);
      assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
    }
  });

  test('an unreadable document has no issuers', () => {
    assert.deepEqual(readOidcIssuers('<<<', 'text/turtle', doc, webId), []);
    assert.deepEqual(readOidcIssuers('{', 'application/ld+json', doc, webId), []);
  });
});

describe('fetchOidcIssuers', () => {
  test('reads the profile, following a redirect to the document', async () => {
    routes.set('/id.example/alice', (request, response) => {
      response.writeHead(303, { location: 'https://pod.example/alice/card' }).end();
    });
    routes.set('/pod.example/alice/card', (request, response) => {
      assert.match(request.headers.accept, /^text\/turtle/);
      response
        .writeHead(200, { 'content-type': 'text/turtle' })
        .end(`<https://id.example/alice#me> <${SOLID}oidcIssuer> <https://issuer.example> .`);
    });
    const result = await fetchOidcIssuers('https://id.example/alice#me', { fetch: fixtureFetch, allowLocalhost: true });
    assert.deepEqual(result, { ok: true, webId: 'https://id.example/alice#me', issuers: ['https://issuer.example'] });
  });

  test('an http WebID is refused without a request', async () => {
    const result = await fetchOidcIssuers('http://pod.example/card#me', { fetch: fixtureFetch });
    assert.deepEqual(result, { ok: false, webId: 'http://pod.example/card#me', reason: 'refused' });
    assert.equal(requests.length, 0);
  });

  test('a redirect to a private address is refused', async () => {
    routes.set('/pod.example/card', (request, response) => {
      response.writeHead(302, { location: 'https://169.254.169.254/latest/meta-data' }).end();
    });
    const result = await fetchOidcIssuers('https://pod.example/card#me', { fetch: fixtureFetch });
    assert.equal(result.reason, 'refused');
    assert.deepEqual(requests, ['/pod.example/card']);
  });

  test('a body over the size cap is not read', async () => {
    serve('/pod.example/card', 'text/turtle', `${turtleProfile(['https://i.test'])}#${'x'.repeat(5000)}`);
    const result = await fetchOidcIssuers('https://pod.example/card#me', {
      fetch: fixtureFetch,
      maxResponseBytes: 1000,
    });
    assert.deepEqual(result, { ok: false, webId: 'https://pod.example/card#me', reason: 'unreachable' });
  });

  test('a streamed body over the size cap is not read', async () => {
    routes.set('/pod.example/card', (request, response) => {
      response.writeHead(200, { 'content-type': 'text/turtle' });
      response.write(turtleProfile(['https://i.test']));
      response.end(`#${'x'.repeat(5000)}`);
    });
    const result = await fetchOidcIssuers('https://pod.example/card#me', {
      fetch: async (url, init) => {
        const response = await fixtureFetch(url, init);
        assert.equal(response.headers.get('content-length'), null, 'the fixture streams without a length');
        return response;
      },
      maxResponseBytes: 1000,
    });
    assert.equal(result.reason, 'unreachable');
  });

  test('issuers that would not be fetched are left out', async () => {
    serve('/pod.example/card', 'text/turtle', turtleProfile(['http://insecure.example', 'https://i.test']));
    const result = await fetchOidcIssuers('https://pod.example/card#me', { fetch: fixtureFetch });
    assert.deepEqual(result.issuers, ['https://i.test']);
  });

  test('invalid input', async () => {
    assert.deepEqual(await fetchOidcIssuers('alice@example.com'), { ok: false, reason: 'invalid-input' });
  });
});

describe('createIssuerDiscovery', () => {
  test('a typed WebID: the profile’s issuer', async () => {
    serve('/pod.example/card', 'text/turtle', turtleProfile(['https://issuer.example']));
    const result = await discovery().discover('  https://pod.example/card#me ');
    assert.deepEqual(result, {
      ok: true,
      source: 'webid',
      issuer: 'https://issuer.example',
      issuers: ['https://issuer.example'],
      webId: 'https://pod.example/card#me',
    });
  });

  test('a typed WebID without an issuer never falls back', async () => {
    serve('/pod.example/card', 'text/turtle', turtleProfile([]).replace(/;\s*\./, '.'));
    assert.deepEqual(await discovery().discover('https://pod.example/card#me'), {
      ok: false,
      reason: 'no-issuer',
      webId: 'https://pod.example/card#me',
    });
    routes.clear();
    assert.deepEqual(await discovery().discover('https://gone.example/card#me'), {
      ok: false,
      reason: 'unreachable',
      webId: 'https://gone.example/card#me',
    });
  });

  test('WebFinger issuer link: that issuer, with the normalised email as login hint', async () => {
    serveJrd('semantu.com', [
      { rel: WEBID_REL, href: 'https://semantu.com/people/rene#me' },
      { rel: ISSUER_REL, href: 'https://login.semantu.com' },
    ]);
    const result = await discovery().discover(' Rene@Semantu.com ');
    assert.deepEqual(result, {
      ok: true,
      source: 'webfinger',
      issuer: 'https://login.semantu.com',
      issuers: ['https://login.semantu.com'],
      loginHint: 'rene@semantu.com',
    });
    assert.deepEqual(requests, ['/semantu.com/.well-known/webfinger?resource=acct%3Arene%40semantu.com']);
  });

  test('WebFinger WebID link: the issuer from that WebID’s profile', async () => {
    serveJrd('semantu.com', [{ rel: WEBID_REL, href: 'https://semantu.com/people/rene#me' }]);
    serve('/semantu.com/people/rene', 'text/turtle', turtleProfile([WEBID_EMAIL_ISSUER]));
    const result = await discovery().discoverFromEmail('rene@semantu.com');
    assert.deepEqual(result, {
      ok: true,
      source: 'webfinger-webid',
      issuer: WEBID_EMAIL_ISSUER,
      issuers: [WEBID_EMAIL_ISSUER],
      webId: 'https://semantu.com/people/rene#me',
      loginHint: 'rene@semantu.com',
    });
  });

  test('a WebID link whose profile names no issuer falls back', async () => {
    serveJrd('semantu.com', [{ rel: WEBID_REL, href: 'https://semantu.com/people/rene#me' }]);
    const result = await discovery().discoverFromEmail('rene@semantu.com');
    assert.equal(result.source, 'fallback');
    assert.equal(result.reason, 'webid-without-issuer');
  });

  test('no answer: the default issuer', async () => {
    const result = await discovery({ defaultIssuer: 'http://localhost:4050' }).discover('alice@example.com');
    assert.deepEqual(result, {
      ok: true,
      source: 'fallback',
      issuer: 'http://localhost:4050',
      issuers: ['http://localhost:4050'],
      loginHint: 'alice@example.com',
      reason: 'no-answer',
    });
    serveJrd('example.org', [{ rel: 'http://webfinger.net/rel/profile-page', href: 'https://example.org/alice' }]);
    const noLink = await discovery().discover('alice@example.org');
    assert.equal(noLink.issuer, WEBID_EMAIL_ISSUER);
    assert.equal(noLink.reason, 'no-answer');
  });

  test('a link to a URL that would not be fetched is no answer', async () => {
    serveJrd('example.org', [{ rel: ISSUER_REL, href: 'https://192.168.0.10/' }]);
    assert.equal((await discovery({ allowLocalhost: false }).discover('a@example.org')).reason, 'no-answer');
  });

  test('a skipped domain falls back without a request', async () => {
    assert.ok(DEFAULT_SKIP_DOMAINS.includes('gmail.com'));
    const result = await discovery().discover('someone@GMail.com');
    assert.equal(result.source, 'fallback');
    assert.equal(result.reason, 'skipped');
    assert.equal(result.loginHint, 'someone@gmail.com');
    assert.equal(requests.length, 0);
    const custom = await discovery({ skipDomains: ['example.net'] }).discover('a@example.net');
    assert.equal(custom.reason, 'skipped');
    assert.equal(requests.length, 0);
  });

  test('timeout: the default issuer, and the domain is not asked again for a while', async () => {
    routes.set('/slow.example/.well-known/webfinger', (request, response) => {
      setTimeout(() => response.writeHead(404).end(), 1000).unref();
    });
    const d = discovery({ timeoutMs: 100 });
    const started = Date.now();
    const result = await d.discover('a@slow.example');
    assert.ok(Date.now() - started < 900, 'the lookup waits only for the timeout');
    assert.equal(result.source, 'fallback');
    assert.equal(result.reason, 'timeout');
    const other = await d.discover('b@slow.example');
    assert.equal(other.reason, 'timeout');
    assert.equal(requests.length, 1);
  });

  test('a bad Location header is an error, not an unreachable domain', async () => {
    routes.set('/example.org/.well-known/webfinger', (request, response) => {
      response.writeHead(302, { location: 'https://exa mple.org:99999/' }).end();
    });
    const d = discovery();
    assert.equal((await d.discover('a@example.org')).reason, 'error');
    await d.discover('b@example.org');
    assert.equal(requests.length, 2, 'the domain is asked again for another email');
  });

  test('concurrent lookups share one request', async () => {
    routes.set('/semantu.com/.well-known/webfinger', (request, response) => {
      setTimeout(() => {
        response
          .writeHead(200, { 'content-type': 'application/jrd+json' })
          .end(JSON.stringify({ links: [{ rel: ISSUER_REL, href: 'https://login.semantu.com' }] }));
      }, 50);
    });
    serve('/pod.example/card', 'text/turtle', turtleProfile(['https://i.test']));
    const d = discovery();
    const results = await Promise.all([
      d.discover('rene@semantu.com'),
      d.discover('Rene@Semantu.com'),
      d.discover('https://pod.example/card#me'),
      d.discover('https://pod.example/card#me'),
    ]);
    assert.equal(results[0], results[1]);
    assert.equal(results[2].issuer, 'https://i.test');
    assert.equal(requests.length, 2);
  });

  test('cache hit: a second lookup makes no request', async () => {
    serveJrd('semantu.com', [{ rel: ISSUER_REL, href: 'https://login.semantu.com' }]);
    const d = discovery();
    const first = await d.discover('rene@semantu.com');
    const second = await d.discover('RENE@semantu.com');
    assert.deepEqual(second, first);
    assert.equal(requests.length, 1);
    serve('/pod.example/card', 'text/turtle', turtleProfile(['https://i.test']));
    await d.discover('https://pod.example/card#me');
    await d.discover('https://pod.example/card#me');
    assert.equal(requests.length, 2);
    d.clearCache();
    await d.discover('rene@semantu.com');
    assert.equal(requests.length, 3);
  });

  test('cached answers and no-answers both expire, no-answers sooner', async () => {
    let now = 0;
    const d = discovery({ now: () => now, cacheTtlMs: 1000, negativeCacheTtlMs: 100 });
    await d.discover('a@example.com');
    now = 99;
    await d.discover('a@example.com');
    assert.equal(requests.length, 1);
    now = 100;
    serveJrd('example.com', [{ rel: ISSUER_REL, href: 'https://issuer.example.com' }]);
    assert.equal((await d.discover('a@example.com')).source, 'webfinger', 'a domain that adds WebFinger is found');
    assert.equal(requests.length, 2);
    now = 1099;
    await d.discover('a@example.com');
    assert.equal(requests.length, 2);
    now = 1100;
    await d.discover('a@example.com');
    assert.equal(requests.length, 3);
  });

  test('the cache is bounded', async () => {
    const d = discovery({ cacheMaxEntries: 2 });
    await d.discover('a@example.com');
    await d.discover('b@example.com');
    await d.discover('c@example.com');
    await d.discover('a@example.com');
    assert.equal(requests.length, 4);
  });

  test('invalid input', async () => {
    const d = discovery();
    for (const input of ['', 'alice', 'a@b@c.com', '@example.com', 'a@nodot', 'a@exa mple.com', 'ftp://x.example/#me', null]) {
      assert.deepEqual(await d.discover(input), { ok: false, reason: 'invalid-input' }, String(input));
    }
    assert.equal(requests.length, 0);
  });

  test('results are frozen, so a cached result cannot be changed by a caller', async () => {
    const result = await discovery().discover('a@gmail.com');
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.issuers));
  });

  test('a default issuer that would not be fetched is refused at setup', () => {
    assert.throws(() => createIssuerDiscovery({ defaultIssuer: 'http://webid.example' }), /defaultIssuer/);
    assert.throws(() => createIssuerDiscovery({ defaultIssuer: 'http://localhost:4050' }), /defaultIssuer/);
    assert.doesNotThrow(() => createIssuerDiscovery({ defaultIssuer: 'http://localhost:4050', allowLocalhost: true }));
  });
});

describe('readProfileLiterals', () => {
  const doc = 'https://pod.example/profile/card';
  const webId = `${doc}#me`;
  const FOAF_NAME = 'http://xmlns.com/foaf/0.1/name';

  test('Turtle: plain and language strings of the WebID; other subjects, IRIs and typed literals ignored', () => {
    const body = `@prefix foaf: <http://xmlns.com/foaf/0.1/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
<#me> foaf:name "Ada Lovelace", "Ada"@en, <https://not-a-name.test/>, "42"^^xsd:integer .
<#other> foaf:name "Mallory" .`;
    assert.deepEqual(readProfileLiterals(body, 'text/turtle', doc, webId, FOAF_NAME), ['Ada Lovelace', 'Ada']);
  });

  test('JSON-LD: a plain string, an @value object and an xsd:string coercion; an @id coercion is no literal', () => {
    const body = JSON.stringify({
      '@context': {
        foaf: 'http://xmlns.com/foaf/0.1/',
        xsd: 'http://www.w3.org/2001/XMLSchema#',
        name: 'foaf:name',
        nick: { '@id': 'foaf:name', '@type': 'xsd:string' },
        link: { '@id': 'foaf:name', '@type': '@id' },
      },
      '@id': '#me',
      name: ['Ada Lovelace', { '@value': 'Ada', '@language': 'en' }, { '@value': 7, '@type': 'xsd:integer' }],
      nick: 'Countess',
      link: 'https://not-a-name.test/',
      knows: { '@id': 'https://friend.example/#me', name: 'Mallory' },
    });
    assert.deepEqual(readProfileLiterals(body, 'application/ld+json', doc, webId, FOAF_NAME), [
      'Ada Lovelace',
      'Ada',
      'Countess',
    ]);
  });

  test('an unreadable document has no values', () => {
    assert.deepEqual(readProfileLiterals('<#me> foaf:name', 'text/turtle', doc, webId, FOAF_NAME), []);
    assert.deepEqual(readProfileLiterals('{', 'application/ld+json', doc, webId, FOAF_NAME), []);
  });
});
