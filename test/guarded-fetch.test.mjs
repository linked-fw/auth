// The guarded fetch: every URL is checked like issuer discovery checks it, and every host name is
// resolved, checked and connected to by the addresses checked, so a public name that resolves to a
// private address (or rebinds to one) is refused before a connection is made.
//
// Runs against the BUILT package in lib/ (build first: `npx linked build`).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const libDir = new URL('../lib/esm/', import.meta.url);
const { createGuardedFetch, guardedLookup, BlockedAddressError, RefusedUrlError } = await import(
  new URL('utils/guardedFetch.js', libDir)
);
const { isBlockedAddress } = await import(new URL('utils/issuerDiscovery.js', libDir));

let server;
let port;
let requests = 0;

before(async () => {
  server = http.createServer((req, res) => {
    requests++;
    if (req.url === '/redirect') {
      res.writeHead(302, { location: 'http://127.0.0.1:1/' });
      res.end();
      return;
    }
    res.end('ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(() => server.close());

/** A resolver that answers every name with `addresses` and records what it was asked. */
function fakeResolver(addresses) {
  const asked = [];
  const resolve = async (hostname, options) => {
    asked.push({ hostname, options });
    return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
  return { resolve, asked };
}

/** Run a `guardedLookup` and return what it called back with. */
function lookup(fn, hostname, options = {}) {
  return new Promise((resolve) => {
    fn(hostname, options, (error, address, family) => resolve({ error, address, family }));
  });
}

test('isBlockedAddress: private ranges always, loopback without allowLocalhost, public never', () => {
  for (const address of ['10.1.2.3', '192.168.0.1', '172.16.5.5', '169.254.169.254', '::ffff:10.0.0.1', 'fd00::1', '0.0.0.0', '2001:0:4136:e378::1', '2001:db8::1', '100::1']) {
    assert.equal(isBlockedAddress(address, true), true, address);
  }
  assert.equal(isBlockedAddress('127.0.0.1'), true);
  assert.equal(isBlockedAddress('::1'), true);
  assert.equal(isBlockedAddress('127.0.0.1', true), false);
  assert.equal(isBlockedAddress('::1', true), false);
  assert.equal(isBlockedAddress('93.184.216.34'), false);
  assert.equal(isBlockedAddress('2606:2800:220:1::1'), false);
  assert.equal(isBlockedAddress('not-an-address'), true);
});

test('guardedLookup: a name that resolves to a private address is refused', async () => {
  const { resolve } = fakeResolver(['10.0.0.7']);
  const { error } = await lookup(guardedLookup(false, resolve), 'innocent.example');
  assert.ok(error instanceof BlockedAddressError);
  assert.match(error.message, /innocent\.example/);
});

test('guardedLookup: one private address among public ones refuses the name', async () => {
  const { resolve } = fakeResolver(['93.184.216.34', '192.168.1.1']);
  const { error } = await lookup(guardedLookup(false, resolve), 'mixed.example', { all: true });
  assert.ok(error instanceof BlockedAddressError);
});

test('guardedLookup: public addresses pass, in the form asked for', async () => {
  const { resolve, asked } = fakeResolver(['93.184.216.34', '2606:2800:220:1::1']);
  const one = await lookup(guardedLookup(false, resolve), 'public.example', { family: 0 });
  assert.equal(one.error, null);
  assert.equal(one.address, '93.184.216.34');
  assert.equal(one.family, 4);
  const all = await lookup(guardedLookup(false, resolve), 'public.example', { all: true });
  assert.equal(all.error, null);
  assert.deepEqual(
    all.address.map((a) => a.address),
    ['93.184.216.34', '2606:2800:220:1::1']
  );
  assert.equal(asked[0].options.all, true, 'always resolves every address');
});

test('guardedLookup: loopback is refused unless allowLocalhost', async () => {
  const { resolve } = fakeResolver(['127.0.0.1']);
  assert.ok((await lookup(guardedLookup(false, resolve), 'rebind.example')).error instanceof BlockedAddressError);
  assert.equal((await lookup(guardedLookup(true, resolve), 'rebind.example')).error, null);
});

test('guardedLookup: no address is ENOTFOUND, a resolver failure is passed on', async () => {
  const empty = await lookup(guardedLookup(false, async () => []), 'nothing.example');
  assert.equal(empty.error.code, 'ENOTFOUND');
  const failing = await lookup(
    guardedLookup(false, async () => {
      throw Object.assign(new Error('boom'), { code: 'EAI_AGAIN' });
    }),
    'flaky.example'
  );
  assert.equal(failing.error.code, 'EAI_AGAIN');
});

test('createGuardedFetch: a host name resolving to a private address never gets a request', async () => {
  // localhost.test resolves (through the fake) to 10.0.0.1, the address the server is NOT on; the
  // refusal must come from the lookup, before any connection.
  const { resolve, asked } = fakeResolver(['10.0.0.1']);
  const guarded = createGuardedFetch({ resolve });
  const before = requests;
  await assert.rejects(guarded('https://intranet.example/secret'), (error) => {
    const causes = [];
    for (let e = error; e; e = e.cause) causes.push(e);
    return causes.some((e) => e instanceof BlockedAddressError);
  });
  assert.equal(asked[0].hostname, 'intranet.example');
  assert.equal(requests, before);
});

test('createGuardedFetch: a name rebinding to loopback is refused without allowLocalhost', async () => {
  const { resolve } = fakeResolver(['127.0.0.1']);
  const guarded = createGuardedFetch({ resolve, allowLocalhost: false });
  const before = requests;
  // http: is refused for a public name by the URL check; https: reaches the lookup
  await assert.rejects(guarded(`https://rebind.example:${port}/`));
  assert.equal(requests, before);
});

test('createGuardedFetch: URLs are checked before any lookup', async () => {
  const { resolve, asked } = fakeResolver(['93.184.216.34']);
  const guarded = createGuardedFetch({ resolve });
  for (const href of [
    'http://public.example/',
    'https://10.0.0.1/',
    'https://[::1]/',
    `http://127.0.0.1:${port}/`,
    'https://user:pw@public.example/',
    'file:///etc/passwd',
  ]) {
    await assert.rejects(guarded(href), RefusedUrlError, href);
  }
  assert.equal(asked.length, 0);
});

test('createGuardedFetch: with allowLocalhost a local server answers, through the lookup', async () => {
  const { resolve, asked } = fakeResolver(['127.0.0.1']);
  const guarded = createGuardedFetch({ resolve, allowLocalhost: true });
  const response = await guarded(`http://localhost:${port}/`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'ok');
  assert.equal(asked[0].hostname, 'localhost');
});

test('createGuardedFetch: redirects are never followed', async () => {
  const guarded = createGuardedFetch({ allowLocalhost: true, resolve: fakeResolver(['127.0.0.1']).resolve });
  const response = await guarded(`http://localhost:${port}/redirect`, { redirect: 'follow' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), 'http://127.0.0.1:1/');
});
