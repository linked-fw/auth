// The cookie-name prefix (AUTH_COOKIE_PREFIX / Auth.cookiePrefix): every cookie this package sets
// and reads carries it, so two Linked apps on one host keep separate sessions. With no prefix the
// names are the ones every other test in this directory checks.
//
// Runs over real HTTP against an Express app with the provider's middleware. Uses the BUILT
// package in lib/.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';

const PREFIX = 'cn_';
process.env.NODE_ENV = 'test';
process.env.SITE_ROOT = 'https://app.test';
process.env.JWT_SECRET = 'prefix-test-secret-prefix-test-secret';
process.env.SESSION_SECRET = 'prefix-test-session-secret';
process.env.AUTH_SESSION_CLEANUP = 'false';
process.env.AUTH_COOKIE_PREFIX = PREFIX;

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-auth-prefix-test-'));
fs.mkdirSync(path.join(workDir, 'data'));
process.chdir(workDir);
process.on('exit', () => fs.rmSync(workDir, { recursive: true, force: true }));

const libDir = new URL('../lib/esm/', import.meta.url);
const { default: express } = await import('express');
const jwtUtils = await import(new URL('utils/jwt.js', libDir));
const { Auth } = await import(new URL('utils/auth.js', libDir));
const backend = await import(new URL('backend.js', libDir));
const AuthBackendProvider = backend.default;
const sessions = await import(new URL('utils/sessions.js', libDir));
const cookieNames = await import(new URL('utils/cookieNames.js', libDir));
const cookies = await import(new URL('utils/cookies.js', libDir));
const authClient = await import(new URL('utils/authClient.js', libDir));

const PERSON = { id: 'https://id.test/person/ada' };
const ACCOUNT = { id: 'https://app.test/account/ada', email: 'ada@example.test', accountOf: PERSON };
const fakeLincdServer = { callGenericBackendProvidersMethod: async () => {} };

class TestProvider extends AuthBackendProvider {
  async loadAccountForSession(accountId) {
    return accountId === ACCOUNT.id ? { ...ACCOUNT } : null;
  }
  async loadUserForSession() {
    return { ...PERSON };
  }
  async signinFixture() {
    return Auth.onSigninSuccessful(this, { ...PERSON }, { ...ACCOUNT });
  }
}

let server;
let url;
before(async () => {
  const app = express();
  app.lazyrouter();
  const provider = new TestProvider(app, fakeLincdServer);
  await provider.setupBeforeControllers();
  app.get('/page', (req, res) => res.json({ account: req.linkedAuth?.userAccount?.id ?? null }));
  app.get('/remember', (req, res) => {
    req.session.remembered = true;
    res.json({ ok: true });
  });
  app.post('/call/@_linked/auth/:method', express.json(), async (req, res) => {
    provider.initRequest(req, res);
    const result = await provider[req.params.method](...(req.body?.args ?? []));
    if (!res.headersSent) res.json(result ?? null);
  });
  server = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  url = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());
beforeEach(() => {
  sessions.setRefreshSessionStore(new sessions.MemoryRefreshSessionStore());
  jwtUtils.clearAccessTokenCache();
});

/** Set-Cookie headers as {name: value} (the last one of each name). */
function setCookies(res) {
  const out = {};
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(';');
    const eq = pair.indexOf('=');
    out[pair.slice(0, eq)] = decodeURIComponent(pair.slice(eq + 1));
  }
  return out;
}

async function rpc(method, args = [], cookie) {
  const res = await fetch(`${url}/call/@_linked/auth/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ args }),
  });
  assert.equal(res.status, 200);
  return { body: await res.json(), jar: setCookies(res) };
}

test('the prefix comes from AUTH_COOKIE_PREFIX, and every cookie name carries it', () => {
  assert.equal(Auth.cookiePrefix, PREFIX);
  assert.equal(cookies.accessCookieName(), 'cn_accessToken');
  assert.equal(cookies.refreshCookieName(), 'cn_refreshToken');
  assert.equal(cookies.sessionHintCookieName(), 'cn_linkedAuthSession');
  assert.equal(backend.sessionCookieName(), 'cn_linked.auth');
  // the exported base names are unchanged
  assert.equal(cookies.ACCESS_COOKIE, 'accessToken');
  assert.equal(backend.SESSION_COOKIE_NAME, 'linked.auth');
});

test('sign-in sets only prefixed cookies', async () => {
  const { jar } = await rpc('signinFixture');
  assert.deepEqual(Object.keys(jar).sort(), [
    'cn_accessToken',
    'cn_linkedAuthSession',
    'cn_refreshToken',
  ]);
});

test('the session cookie (express-session) carries the prefix', async () => {
  const res = await fetch(`${url}/remember`);
  assert.deepEqual(Object.keys(setCookies(res)), ['cn_linked.auth']);
});

test('a page load is authenticated by the prefixed access cookie, not by an unprefixed one', async () => {
  const { jar } = await rpc('signinFixture');
  const prefixed = await fetch(`${url}/page`, {
    headers: { cookie: `cn_accessToken=${jar.cn_accessToken}` },
  });
  assert.deepEqual(await prefixed.json(), { account: ACCOUNT.id });
  const other = await fetch(`${url}/page`, {
    headers: { cookie: `accessToken=${jar.cn_accessToken}` },
  });
  assert.deepEqual(await other.json(), { account: null });
});

test('a refresh reads the prefixed refresh cookie and ignores an unprefixed one', async () => {
  const { jar } = await rpc('signinFixture');
  const refreshed = await rpc(
    'validateToken',
    [null, { forceRefresh: true }],
    // as a browser sends it: with the hint, so the refresh cookie is not taken for a legacy one
    `cn_refreshToken=${jar.cn_refreshToken}; cn_linkedAuthSession=1`
  );
  assert.equal(refreshed.body.error, undefined);
  assert.ok(refreshed.jar.cn_refreshToken && refreshed.jar.cn_refreshToken !== jar.cn_refreshToken);

  const second = await rpc('signinFixture');
  const other = await rpc(
    'validateToken',
    [null, { forceRefresh: true }],
    `refreshToken=${second.jar.cn_refreshToken}`
  );
  assert.equal(other.body.error, 'No token found');
});

test('sign-out clears the prefixed cookies and leaves unprefixed names alone', async () => {
  const { jar } = await rpc('signinFixture');
  const out = await rpc(
    'signout',
    [],
    `cn_refreshToken=${jar.cn_refreshToken}; refreshToken=other-app; linkedAuthSession=1`
  );
  assert.equal(out.body, true);
  for (const name of Object.keys(out.jar)) assert.ok(name.startsWith(PREFIX), name);
  assert.deepEqual(
    Object.keys(out.jar).sort(),
    ['cn_accessToken', 'cn_linkedAuthSession', 'cn_refreshToken']
  );
  for (const value of Object.values(out.jar)) assert.equal(value, '');
});

test('the client session hint honours the prefix', (t) => {
  t.after(() => delete globalThis.document);
  globalThis.document = { cookie: 'linkedAuthSession=1; refreshToken=x; accessToken=y' };
  assert.equal(authClient.hasSessionHint(), false, "another app's cookies are not ours");
  globalThis.document = { cookie: 'theme=dark; cn_linkedAuthSession=1' };
  assert.equal(authClient.hasSessionHint(), true);
});

test('Auth.cookiePrefix wins over the environment; undefined returns to it; invalid throws', (t) => {
  t.after(() => cookieNames.setCookiePrefix(undefined));
  Auth.cookiePrefix = 'wie_';
  assert.equal(cookies.accessCookieName(), 'wie_accessToken');
  Auth.cookiePrefix = '';
  assert.equal(cookies.accessCookieName(), 'accessToken');
  cookieNames.setCookiePrefix(undefined);
  assert.equal(Auth.cookiePrefix, PREFIX);
  assert.throws(() => (Auth.cookiePrefix = 'a b'), /cookie prefix/);
  assert.throws(() => (Auth.cookiePrefix = 'x;y'), /cookie prefix/);
});

/** Cookie names in a fresh process with `env` as its environment. */
function namesIn(env) {
  const out = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const c = await import(${JSON.stringify(new URL('utils/cookies.js', libDir).href)});` +
        'console.log(JSON.stringify([c.accessCookieName(), c.refreshCookieName(), c.sessionHintCookieName()]))',
    ],
    { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' }
  );
  return out;
}

test("no prefix (unset or empty) gives today's names", () => {
  for (const env of [{}, { AUTH_COOKIE_PREFIX: '' }]) {
    const out = namesIn(env);
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(JSON.parse(out.stdout.trim().split('\n').pop()), [
      'accessToken',
      'refreshToken',
      'linkedAuthSession',
    ]);
  }
});

test('an invalid AUTH_COOKIE_PREFIX fails loudly', () => {
  const out = namesIn({ AUTH_COOKIE_PREFIX: 'cn prefix' });
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /AUTH_COOKIE_PREFIX may only contain/);
});
