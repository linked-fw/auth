// The native app's side of a Solid-OIDC sign-in (utils/nativeOidcSignin): the pending sign-in held
// in the app's registered token storage, the system browser seam in both styles (one that resolves
// to the callback URL, one whose link arrives later through the app's URL listener), and the
// tokens stored on success. `Server.call` is routed to a real provider over HTTP, with the mock
// issuer behind it; the "system browser" follows the issuer's redirect to a synthetic callback URL.
//
// Runs against the BUILT package in lib/ (build first: `npx linked build`).
import { test, before, after, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { serving } from './serving.mjs';
import { fakeCredentialTable, fakeShapeTable } from './fakeStore.mjs';
import { startMockIssuer } from './mockIssuer.mjs';

process.env.NODE_ENV = 'test';
process.env.SITE_ROOT = 'https://app.test';
process.env.APP_NAME = 'Test App';
process.env.JWT_SECRET = 'oidc-native-client-secret-oidc-native-client';
process.env.SESSION_SECRET = 'oidc-native-client-session-secret';
process.env.AUTH_SESSION_CLEANUP = 'false';

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-auth-oidc-native-client-'));
fs.mkdirSync(path.join(workDir, 'data'));
process.chdir(workDir);
process.on('exit', () => fs.rmSync(workDir, { recursive: true, force: true }));

const libDir = new URL('../lib/esm/', import.meta.url);
const { Auth } = await import(new URL('utils/auth.js', libDir));
const { AuthCredential } = await import(new URL('shapes/AuthCredential.js', libDir));
const { default: AuthBackendProvider } = await import(new URL('backend.js', libDir));
const { resetRateLimits } = await import(new URL('utils/rateLimit.js', libDir));
const token = await import(new URL('utils/token.js', libDir));
const native = await import(new URL('utils/nativeOidcSignin.js', libDir));
const sessions = await import(new URL('utils/sessions.js', libDir));
const { UserAccount } = await import('@_linked/sioc/shapes/UserAccount');
const { Server } = await import('@_linked/server-utils/utils/Server');

const ADA = 'ada@example.test';
const LINK = 'test.app.native:/oidc/callback';
const fakeLincdServer = { callGenericBackendProvidersMethod: async () => {} };
const defaultWebIdFor = Auth.webIdFor;

let issuer;
let base;
let server;
let people;
let accounts;
let storage;
let calls;

let servers = [];

before(async () => {
  issuer = await startMockIssuer();
});
after(() => {
  issuer.close();
  for (const s of servers) s.close();
});

/** A fresh app with the provider over this test's tables, answering `/call/<method>`. */
async function startApp() {
  const app = express();
  app.lazyrouter();
  class TestProvider extends AuthBackendProvider {
    userShape = people;
    accountShape = accounts;
  }
  const provider = new TestProvider(app, fakeLincdServer);
  await provider.setupBeforeControllers();
  app.post('/call/:method', express.json(), async (req, res) => {
    res.json(await serving(provider, req)[req.params.method](req.body.args[0]));
  });
  server = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  servers.push(server);
  base = `http://127.0.0.1:${server.address().port}`;
}

beforeEach(async () => {
  issuer.reset();
  resetRateLimits();
  Auth.webIdFor = (email) => issuer.webIdFor(email.trim().toLowerCase());
  Auth.signinClient = { clientName: 'Test App', redirectUris: [LINK] };
  Auth.oidcSignin = {
    allowLocalhost: true,
    defaultIssuer: issuer.issuer,
    discovery: { skipDomains: ['example.test'] },
  };
  people = fakeShapeTable('person', []);
  accounts = fakeShapeTable('account', []);
  fakeCredentialTable().install(AuthCredential);
  mock.method(UserAccount, 'select', () => accounts.select());
  sessions.setRefreshSessionStore(new sessions.MemoryRefreshSessionStore());
  mock.method(console, 'log', () => {});
  mock.method(console, 'warn', () => {});

  // the app's storage (Capacitor Preferences or a secure store), with the expiries asked for
  storage = new Map();
  token.setAuthTokenStorageMethods(
    async (key) => storage.get(key)?.value,
    async (key, value, expires) => void storage.set(key, { value, expires }),
    async (key) => void storage.delete(key)
  );
  // Server.call, as a native client sends it: no cookies, tokens in the body
  calls = [];
  mock.method(Server, 'call', async (pkg, method, ...args) => {
    calls.push(method);
    assert.equal(pkg, '@_linked/auth');
    const response = await fetch(`${base}/call/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-linked-auth-transport': 'body' },
      body: JSON.stringify({ args }),
    });
    return response.json();
  });
  await startApp();
});

afterEach(() => {
  mock.restoreAll();
  Auth.webIdFor = defaultWebIdFor;
  native.setOidcSigninBrowser(undefined);
});

/** The system browser: follows the authorization URL to the app-claimed link it ends on. */
async function followToApp(url) {
  const response = await fetch(url, { redirect: 'manual' });
  return response.headers.get('location');
}

test('an authentication session that hands back the URL: signed in, tokens stored, record gone', async () => {
  const opened = [];
  native.setOidcSigninBrowser(async (url, options) => {
    opened.push(options.redirectUri);
    // while the user is at the issuer, the record is on the device and nowhere else
    const held = JSON.parse(storage.get(native.OIDC_PENDING_STORAGE_KEY).value);
    assert.equal(held.state, new URL(url).searchParams.get('state'));
    assert.equal(storage.get(native.OIDC_PENDING_STORAGE_KEY).expires, 600);
    return followToApp(url);
  });
  const answer = await native.startNativeOidcSignin({ input: ADA, redirectUri: LINK });

  assert.ok(answer.accessToken, JSON.stringify(answer));
  assert.equal(answer.outcome.ok, true);
  assert.equal(answer.outcome.webId, issuer.webIdFor(ADA));
  assert.deepEqual(opened, [LINK]);
  assert.deepEqual(calls, ['startNativeOidcSignin', 'completeNativeOidcSignin']);
  assert.equal(storage.get('accessToken').value, answer.accessToken);
  assert.equal(storage.get('refreshToken').value, answer.refreshToken);
  assert.ok(storage.get('refreshToken').expires > 0);
  assert.equal(storage.has(native.OIDC_PENDING_STORAGE_KEY), false, 'used once');
});

test('Custom Tabs: the link arrives later through the URL listener and completes the sign-in', async () => {
  let arrived;
  native.setOidcSigninBrowser(async (url) => {
    arrived = followToApp(url); // the OS delivers it to appUrlOpen, not to the plugin
  });
  const waiting = await native.startNativeOidcSignin({ input: ADA, redirectUri: LINK });
  assert.equal(waiting.waiting, true);
  assert.ok(storage.has(native.OIDC_PENDING_STORAGE_KEY));

  const answer = await native.completeOidcSignin(await arrived);
  assert.ok(answer.accessToken, JSON.stringify(answer));
  assert.equal(waiting.state, new URL(await arrived).searchParams.get('state'));
  assert.equal(storage.get('accessToken').value, answer.accessToken);
});

test('a link for another sign-in is refused on the device and leaves the pending one alone', async () => {
  let arrived;
  native.setOidcSigninBrowser(async (url) => {
    arrived = followToApp(url);
  });
  await native.startNativeOidcSignin({ input: ADA, redirectUri: LINK });
  const forged = new URL(await arrived);
  forged.searchParams.set('state', 'attacker-state');
  forged.searchParams.set('code', 'attacker-code');
  const refused = await native.completeOidcSignin(forged.href);
  assert.equal(refused.action, 'invalid_state');
  assert.deepEqual(calls, ['startNativeOidcSignin'], 'the server was not asked');
  assert.ok(storage.has(native.OIDC_PENDING_STORAGE_KEY));
  for (const url of ['not a url', `${LINK}?code=x`]) {
    assert.equal((await native.completeOidcSignin(url)).action, 'invalid_state');
  }
  // the genuine link still completes
  assert.ok((await native.completeOidcSignin(await arrived)).accessToken);
  // and only once
  assert.equal((await native.completeOidcSignin(await arrived)).action, 'invalid_state');
});

test('a new start replaces the pending sign-in: the older link no longer completes', async () => {
  const links = [];
  native.setOidcSigninBrowser(async (url) => {
    links.push(await followToApp(url));
  });
  await native.startNativeOidcSignin({ input: ADA, redirectUri: LINK });
  await native.startNativeOidcSignin({ input: ADA, redirectUri: LINK });
  assert.equal((await native.completeOidcSignin(links[0])).action, 'invalid_state');
  assert.ok((await native.completeOidcSignin(links[1])).accessToken);
});

test('a cancelled browser removes the pending sign-in', async () => {
  native.setOidcSigninBrowser(async () => {
    throw new Error('The user cancelled');
  });
  const answer = await native.startNativeOidcSignin({ input: ADA, redirectUri: LINK });
  assert.deepEqual(answer, { error: 'The user cancelled', action: 'browser_failed' });
  assert.equal(storage.has(native.OIDC_PENDING_STORAGE_KEY), false);
});

test('an issuer error comes back as an answer and stores no token', async () => {
  issuer.authorizeError = 'login_required';
  native.setOidcSigninBrowser(followToApp);
  const answer = await native.startNativeOidcSignin({ input: ADA, redirectUri: LINK, prompt: 'none' });
  assert.equal(answer.action, 'login_required');
  assert.deepEqual(answer.outcome, { ok: false, error: 'login_required' });
  assert.equal(storage.has('accessToken'), false);
});

test('start errors: no browser, no native storage, a link the server does not list', async () => {
  assert.equal((await native.startNativeOidcSignin({ input: ADA, redirectUri: LINK })).action, 'no_browser');
  native.setOidcSigninBrowser(followToApp);
  const refused = await native.startNativeOidcSignin({ input: ADA, redirectUri: 'other.app:/cb' });
  assert.equal(refused.action, 'invalid_redirect_uri');
  assert.equal(storage.has(native.OIDC_PENDING_STORAGE_KEY), false);
  token.setAuthTokenStorageMethods(undefined, undefined, undefined);
  assert.equal((await native.startNativeOidcSignin({ input: ADA, redirectUri: LINK })).action, 'not_native');
});
