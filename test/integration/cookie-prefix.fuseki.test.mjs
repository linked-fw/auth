// Two Linked apps on one host (an app and a local issuer, e.g. CN on :4040 and webid.email on
// :4050) share cookies, because browsers do not separate cookies by port. Each app's cookies carry
// a prefix of their own, by default from its APP_PREFIX (neither app sets AUTH_COOKIE_PREFIX), so
// signing out of one leaves the other signed in.
//
// Each app runs in its own process (the prefix is per process, as in real apps) on one throwaway
// Fuseki dataset. One cookie jar stands in for the browser: keyed by name and path, ports ignored.
//
//   AUTH_TEST_FUSEKI_URL=http://localhost:3030 AUTH_TEST_FUSEKI_USER=admin \
//   AUTH_TEST_FUSEKI_PASSWORD=... npm run test:integration
//
// Runs against the BUILT package in lib/ (build first).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { useThrowawayDataset, testDataset } from './fuseki.mjs';

useThrowawayDataset();

/** Start one app with `appPrefix` as its APP_PREFIX; resolves with its URL and process. */
function startApp(appPrefix) {
  const child = spawn(process.execPath, [new URL('prefixedApp.mjs', import.meta.url).pathname], {
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'test',
      SITE_ROOT: 'https://app.test',
      JWT_SECRET: `prefix-integration-${appPrefix}-secret-0123456789`,
      SESSION_SECRET: `prefix-integration-${appPrefix}-session`,
      AUTH_SESSION_CLEANUP: 'false',
      APP_PREFIX: appPrefix,
      TEST_DATASET_ENDPOINT: testDataset.endpoint,
      TEST_DATASET_USER: testDataset.username,
      TEST_DATASET_PASSWORD: testDataset.password,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));
  return new Promise((resolve, reject) => {
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const match = stdout.match(/LISTENING (\S+)/);
      if (match) resolve({ url: match[1], child });
    });
    child.on('exit', (code) => reject(new Error(`app ${appPrefix} exited (${code}): ${stderr}`)));
  });
}

/** A browser's cookie jar for one host: cookies by name and path, whatever the port. */
function createBrowser() {
  const jar = new Map(); // `${name}\t${path}` -> {name, value, path}
  const cookieHeader = (pathname) =>
    [...jar.values()]
      .filter((c) => pathname === c.path || pathname.startsWith(c.path.replace(/\/?$/, '/')))
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
  const store = (res) => {
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(';').map((p) => p.trim());
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      const pathAttr = attrs.find((a) => a.toLowerCase().startsWith('path='));
      const cookiePath = pathAttr ? pathAttr.slice(5) : '/';
      const expired = attrs.some(
        (a) =>
          (a.toLowerCase().startsWith('expires=') && Date.parse(a.slice(8)) <= Date.now()) ||
          a.toLowerCase() === 'max-age=0'
      );
      if (expired || value === '') jar.delete(`${name}\t${cookiePath}`);
      else jar.set(`${name}\t${cookiePath}`, { name, value, path: cookiePath });
    }
  };
  return {
    names: () => [...jar.values()].map((c) => c.name).sort(),
    async page(appUrl) {
      const res = await fetch(`${appUrl}/page`, { headers: { cookie: cookieHeader('/page') } });
      store(res);
      return (await res.json()).account;
    },
    async rpc(appUrl, method, args = []) {
      const pathname = `/call/@_linked/auth/${method}`;
      const res = await fetch(`${appUrl}${pathname}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: cookieHeader(pathname) },
        body: JSON.stringify({ args }),
      });
      assert.equal(res.status, 200);
      store(res);
      return res.json();
    },
  };
}

let cn;
let wie;
before(async () => {
  [cn, wie] = await Promise.all([startApp('cn'), startApp('webid-email')]);
});
after(() => {
  cn?.child.kill();
  wie?.child.kill();
});

const newAccount = () => ({
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: `ada-${crypto.randomBytes(4).toString('hex')}@example.test`,
  password: 'correct horse battery staple 42',
});

test('two apps in one cookie jar: signing out of one leaves the other signed in', async () => {
  const browser = createBrowser();
  const inCn = await browser.rpc(cn.url, 'createAccount', [newAccount()]);
  const inWie = await browser.rpc(wie.url, 'createAccount', [newAccount()]);
  assert.ok(inCn.accessToken && inWie.accessToken, JSON.stringify({ inCn, inWie }));

  assert.deepEqual(browser.names(), [
    'cn_accessToken',
    'cn_linkedAuthSession',
    'cn_refreshToken',
    'webid-email_accessToken',
    'webid-email_linkedAuthSession',
    'webid-email_refreshToken',
  ]);
  const cnAccount = await browser.page(cn.url);
  const wieAccount = await browser.page(wie.url);
  assert.ok(cnAccount && wieAccount && cnAccount !== wieAccount);

  assert.equal(await browser.rpc(cn.url, 'signout'), true);
  assert.deepEqual(browser.names(), [
    'webid-email_accessToken',
    'webid-email_linkedAuthSession',
    'webid-email_refreshToken',
  ]);

  // the signed-out app: no page session, nothing to refresh
  assert.equal(await browser.page(cn.url), null);
  assert.equal((await browser.rpc(cn.url, 'validateToken', [null, { forceRefresh: true }])).error, 'No token found');

  // the other app: still signed in, and its session still refreshes
  assert.equal(await browser.page(wie.url), wieAccount);
  const refreshed = await browser.rpc(wie.url, 'validateToken', [null, { forceRefresh: true }]);
  assert.equal(refreshed.error, undefined, JSON.stringify(refreshed));
  assert.ok(refreshed.accessToken);
  assert.equal(await browser.page(wie.url), wieAccount);
});
