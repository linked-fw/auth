// Solid-OIDC sign-in from a native app (RFC 8252), through the provider over HTTP:
// `startNativeOidcSignin` returns the issuer's URL and the pending sign-in sealed for the device,
// the mock issuer (mockIssuer.mjs) redirects to the app-claimed link, and the app hands that
// synthetic callback URL and the sealed record to `completeNativeOidcSignin`, which checks
// everything and answers with the session's tokens in the body. No cookie travels between the two.
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
process.env.JWT_SECRET = 'oidc-native-test-secret-oidc-native-test';
process.env.SESSION_SECRET = 'oidc-native-test-session-secret';
process.env.AUTH_SESSION_CLEANUP = 'false';

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-auth-oidc-native-'));
fs.mkdirSync(path.join(workDir, 'data'));
process.chdir(workDir);
process.on('exit', () => fs.rmSync(workDir, { recursive: true, force: true }));

const libDir = new URL('../lib/esm/', import.meta.url);
const { Auth } = await import(new URL('utils/auth.js', libDir));
const { AuthCredential } = await import(new URL('shapes/AuthCredential.js', libDir));
const { default: AuthBackendProvider } = await import(new URL('backend.js', libDir));
const { resetRateLimits } = await import(new URL('utils/rateLimit.js', libDir));
const { sealPendingOidc, openPendingOidc } = await import(
  new URL('helpers/oidcSealedPending.js', libDir)
);
const sessions = await import(new URL('utils/sessions.js', libDir));
const { UserAccount } = await import('@_linked/sioc/shapes/UserAccount');

const ADA = 'ada@example.test';
const GRACE = 'grace@example.test';
const UNIVERSAL_LINK = 'https://app.test/auth/oidc/native';
const CUSTOM_SCHEME = 'test.app.native:/oidc/callback';
const fakeLincdServer = { callGenericBackendProvidersMethod: async () => {} };
const defaultWebIdFor = Auth.webIdFor;

let issuer;
let people;
let accounts;
let credentials;
let sessionStore;
let outcomes;
let servers = [];

before(async () => {
  issuer = await startMockIssuer();
});
after(() => {
  issuer.close();
  for (const server of servers) server.close();
});

beforeEach(() => {
  issuer.reset();
  resetRateLimits();
  Auth.webIdFor = (email) => issuer.webIdFor(email.trim().toLowerCase());
  Auth.signinClient = { clientName: 'Test App', redirectUris: [UNIVERSAL_LINK, CUSTOM_SCHEME] };
  outcomes = [];
  Auth.oidcSignin = {
    allowLocalhost: true,
    defaultIssuer: issuer.issuer,
    discovery: { skipDomains: ['example.test'] },
    onResult: (outcome) => {
      outcomes.push(outcome);
      return undefined;
    },
  };
  people = fakeShapeTable('person', []);
  accounts = fakeShapeTable('account', []);
  credentials = fakeCredentialTable();
  credentials.install(AuthCredential);
  mock.method(UserAccount, 'select', () => accounts.select());
  sessionStore = new sessions.MemoryRefreshSessionStore();
  sessions.setRefreshSessionStore(sessionStore);
  mock.method(console, 'log', () => {});
  mock.method(console, 'warn', () => {});
});

afterEach(() => {
  mock.restoreAll();
  Auth.webIdFor = defaultWebIdFor;
  delete Auth.signinClient;
  delete Auth.oidcSignin;
});

/** An app on a real port with the provider's middleware and both RPC methods as routes. */
async function startApp() {
  const app = express();
  app.lazyrouter();
  class TestProvider extends AuthBackendProvider {
    userShape = people;
    accountShape = accounts;
  }
  const provider = new TestProvider(app, fakeLincdServer);
  await provider.setupBeforeControllers();
  for (const method of ['startNativeOidcSignin', 'completeNativeOidcSignin', 'startOidcSignin']) {
    app.post(`/${method}`, express.json(), async (req, res) => {
      res.json(await serving(provider, req)[method](req.body));
    });
  }
  const server = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  servers.push(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  // a native client: no cookie jar, and it asks for the tokens in the body
  const call = async (method, body) => {
    const response = await fetch(`${base}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-linked-auth-transport': 'body' },
      body: JSON.stringify(body),
    });
    return { body: await response.json(), cookies: response.headers.getSetCookie() };
  };
  return {
    base,
    start: async (body) => (await call('startNativeOidcSignin', body)).body,
    complete: async (body) => (await call('completeNativeOidcSignin', body)).body,
    call,
  };
}

/** Play the system browser: follow the authorization URL to the app-claimed link it ends on. */
async function browse(url) {
  const response = await fetch(url, { redirect: 'manual' });
  const location = response.headers.get('location');
  assert.ok(location, `the issuer answered ${response.status} without a redirect`);
  return location;
}

/** Start, let the issuer answer, and hand the link it returned to back to the server. */
async function signIn(app, body = { input: ADA, redirectUri: UNIVERSAL_LINK }) {
  const started = await app.start(body);
  assert.ok(started.url, JSON.stringify(started));
  const callbackUrl = await browse(started.url);
  return { started, callbackUrl, answer: await app.complete({ callbackUrl, pending: started.pending }) };
}

test('a native sign-in with a Universal Link: tokens in the body, person, account, outcome', async () => {
  const app = await startApp();
  const { started, callbackUrl, answer } = await signIn(app);

  const url = new URL(started.url);
  assert.equal(url.origin, issuer.issuer);
  assert.equal(url.searchParams.get('redirect_uri'), UNIVERSAL_LINK);
  assert.equal(url.searchParams.get('client_id'), 'https://app.test/.well-known/linked-client.jsonld');
  assert.equal(url.searchParams.get('login_hint'), ADA);
  assert.equal(url.searchParams.get('state'), started.state);
  assert.ok(url.searchParams.get('dpop_jkt'));
  assert.ok(callbackUrl.startsWith(`${UNIVERSAL_LINK}?`));
  assert.match(started.pending, /^v1\./);
  assert.ok(!started.pending.includes(started.state), 'the record is opaque to the device');

  assert.ok(answer.accessToken, JSON.stringify(answer));
  assert.ok(answer.refreshToken, 'the refresh token comes back in the body');
  assert.equal(typeof answer.refreshTokenExpiresIn, 'number');
  const webId = issuer.webIdFor(ADA);
  assert.equal(answer.auth.user.id, webId);
  assert.deepEqual(answer.outcome, {
    ok: true,
    webId,
    issuer: issuer.issuer,
    email: ADA,
    emailProven: true,
    isNewAccount: true,
  });
  assert.deepEqual(people.created.map((p) => p.id), [webId]);
  assert.equal(accounts.created[0].email, ADA);
  assert.equal(sessionStore.records.size, 1);
  assert.equal(outcomes.length, 0, 'onResult is a redirect hook and is not called');

  // the token request repeated the app-claimed link, with the PKCE verifier and a DPoP proof
  const [tokenRequest] = issuer.tokenRequests;
  assert.equal(tokenRequest.form.redirect_uri, UNIVERSAL_LINK);
  assert.equal(tokenRequest.error, null);
});

test('a custom scheme works the same way', async () => {
  const app = await startApp();
  const { callbackUrl, answer } = await signIn(app, { input: ADA, redirectUri: CUSTOM_SCHEME });
  assert.ok(callbackUrl.startsWith(`${CUSTOM_SCHEME}?`), callbackUrl);
  assert.ok(answer.accessToken, JSON.stringify(answer));
  assert.equal(issuer.tokenRequests[0].form.redirect_uri, CUSTOM_SCHEME);
});

test('an existing person signs in to its account', async () => {
  const webId = issuer.webIdFor(ADA);
  people.rows.push({ id: webId, givenName: 'Ada' });
  accounts.rows.push({ id: 'https://app.test/account/ada', email: ADA, accountOf: { id: webId } });
  const app = await startApp();
  const { answer } = await signIn(app);
  assert.equal(answer.outcome.isNewAccount, false);
  assert.equal(answer.auth.userAccount.id, 'https://app.test/account/ada');
  assert.equal(people.created.length, 0);
  assert.equal(accounts.created.length, 0);
});

test('start refuses a redirect URI the Client ID Document does not list, or the web callback', async () => {
  const app = await startApp();
  for (const redirectUri of [
    'https://evil.test/auth/oidc/native',
    'https://app.test/auth/oidc/callback',
    `${UNIVERSAL_LINK}?x=1`,
    undefined,
  ]) {
    const answer = await app.start({ input: ADA, redirectUri });
    assert.equal(answer.action, 'invalid_redirect_uri', String(redirectUri));
  }
  assert.equal(issuer.authorizeRequests.length, 0);
});

test('a listed redirect URI not in its parsed form is refused with a log line', async () => {
  Auth.signinClient = { clientName: 'Test App', redirectUris: ['https://APP.test/auth/oidc/native'] };
  const app = await startApp();
  const answer = await app.start({ input: ADA, redirectUri: 'https://APP.test/auth/oidc/native' });
  assert.equal(answer.action, 'invalid_redirect_uri');
  assert.ok(console.warn.mock.calls.some((c) => /must be written as "https:\/\/app\.test\/auth\/oidc\/native"/.test(c.arguments[0])));
});

test('a changed, foreign or expired sealed record is refused before the issuer is asked', async () => {
  const app = await startApp();
  const started = await app.start({ input: ADA, redirectUri: UNIVERSAL_LINK });
  const callbackUrl = await browse(started.url);
  const flipped = started.pending.slice(0, -2) + (started.pending.endsWith('A') ? 'BB' : 'AA');
  const record = openPendingOidc(started.pending, process.env.JWT_SECRET);
  const otherKey = sealPendingOidc(record, 'another-server-secret-another-server');
  const evilIssuer = sealPendingOidc({ ...record, issuer: 'https://evil.test' }, 'x');
  const old = sealPendingOidc({ ...record, createdAt: Date.now() - 11 * 60 * 1000 }, process.env.JWT_SECRET);
  for (const pending of [flipped, otherKey, evilIssuer, old, '', 'v1.', undefined, 'x'.repeat(9000)]) {
    const answer = await app.complete({ callbackUrl, pending });
    assert.equal(answer.action, 'invalid_state');
    assert.deepEqual(answer.outcome, { ok: false, error: 'invalid_state' });
    assert.equal(answer.accessToken, undefined);
  }
  assert.equal(issuer.tokenRequests.length, 0);
  // the genuine record still works
  assert.ok((await app.complete({ callbackUrl, pending: started.pending })).accessToken);
});

test('the callback URL must be the link the sign-in started with, carrying its state', async () => {
  const app = await startApp();
  const started = await app.start({ input: ADA, redirectUri: UNIVERSAL_LINK });
  const callbackUrl = new URL(await browse(started.url));
  const elsewhere = new URL(callbackUrl);
  elsewhere.pathname = '/auth/oidc/other';
  const scheme = new URL(`${CUSTOM_SCHEME}${callbackUrl.search}`);
  const otherState = new URL(callbackUrl);
  otherState.searchParams.set('state', 'another-state');
  for (const url of [elsewhere.href, scheme.href, otherState.href, 'not a url', '']) {
    const answer = await app.complete({ callbackUrl: url, pending: started.pending });
    assert.equal(answer.action, 'invalid_state', url);
  }
  assert.equal(issuer.tokenRequests.length, 0);
});

test('a redirect URI removed from the configuration stops pending sign-ins that used it', async () => {
  const app = await startApp();
  const started = await app.start({ input: ADA, redirectUri: CUSTOM_SCHEME });
  const callbackUrl = await browse(started.url);
  Auth.signinClient = { clientName: 'Test App', redirectUris: [UNIVERSAL_LINK] };
  const answer = await app.complete({ callbackUrl, pending: started.pending });
  assert.equal(answer.action, 'invalid_state');
});

test('a code from another sign-in is refused: PKCE and the DPoP key belong to the record', async () => {
  const app = await startApp();
  const first = await app.start({ input: ADA, redirectUri: UNIVERSAL_LINK });
  const second = await app.start({ input: ADA, redirectUri: UNIVERSAL_LINK });
  const secondCallback = new URL(await browse(second.url));
  // the second sign-in's code under the first one's state
  secondCallback.searchParams.set('state', first.state);
  const answer = await app.complete({ callbackUrl: secondCallback.href, pending: first.pending });
  assert.equal(answer.accessToken, undefined);
  assert.equal(answer.outcome.ok, false);
  assert.equal(sessionStore.records.size, 0);
});

test('a replayed callback is refused by the issuer: the code is single use', async () => {
  const app = await startApp();
  const { started, callbackUrl, answer } = await signIn(app);
  assert.ok(answer.accessToken);
  const again = await app.complete({ callbackUrl, pending: started.pending });
  assert.equal(again.accessToken, undefined);
  assert.equal(again.outcome.ok, false);
  assert.equal(sessionStore.records.size, 1);
});

test('login_required from a silent sign-in comes back as an answer', async () => {
  issuer.authorizeError = 'login_required';
  const app = await startApp();
  const { started, answer } = await signIn(app, { input: ADA, redirectUri: UNIVERSAL_LINK, prompt: 'none' });
  assert.equal(new URL(started.url).searchParams.get('prompt'), 'none');
  assert.equal(answer.action, 'login_required');
  assert.deepEqual(answer.outcome, { ok: false, error: 'login_required' });
});

test('an issuer the WebID profile does not name is refused', async () => {
  const webId = issuer.addProfile('carol', ['https://other-issuer.test']);
  issuer.claims = (c) => ({ ...c, webid: webId });
  const app = await startApp();
  const { answer } = await signIn(app);
  assert.equal(answer.action, 'issuer_refused');
  assert.equal(people.created.length, 0);
});

test('mismatch: reported with the tokens by default, refused when the hook says so', async () => {
  issuer.claims = (c) => ({ ...c, email: GRACE, webid: issuer.webIdFor(GRACE) });
  const app = await startApp();
  const { answer } = await signIn(app);
  assert.ok(answer.accessToken);
  assert.deepEqual(answer.outcome.mismatch, { hinted: ADA, returned: GRACE });

  let seen;
  Auth.oidcSignin.onEmailMismatch = async (mismatch) => {
    seen = { ...mismatch, hasAccount: await mismatch.hasAccount(GRACE) };
    return 'refuse';
  };
  const refused = (await signIn(app)).answer;
  assert.equal(refused.action, 'email_mismatch');
  assert.deepEqual(refused.outcome, {
    ok: false,
    error: 'email_mismatch',
    mismatch: { hinted: ADA, returned: GRACE },
  });
  assert.equal(seen.hinted, ADA);
  assert.equal(seen.hasAccount, true);
});

test('an app that did not opt in refuses both steps', async () => {
  const app = await startApp();
  const started = await app.start({ input: ADA, redirectUri: UNIVERSAL_LINK });
  delete Auth.oidcSignin;
  const callbackUrl = await browse(started.url);
  assert.equal((await app.complete({ callbackUrl, pending: started.pending })).action, 'not_configured');
  assert.equal((await app.start({ input: ADA, redirectUri: UNIVERSAL_LINK })).action, 'not_configured');
});

test('start: invalid input and an issuer that cannot be reached', async () => {
  const app = await startApp();
  assert.equal((await app.start({ input: '', redirectUri: UNIVERSAL_LINK })).action, 'invalid_input');
  const unreachable = issuer.addProfile('broken', [`${issuer.profileOrigin}/no-issuer-here`]);
  assert.equal((await app.start({ input: unreachable, redirectUri: UNIVERSAL_LINK })).action, 'issuer_unreachable');
});

test('both steps are rate limited per IP', async () => {
  const app = await startApp();
  let last;
  for (let i = 0; i < 21; i++) last = await app.start({ input: '', redirectUri: UNIVERSAL_LINK });
  assert.equal(last.action, 'rate_limited');
  for (let i = 0; i < 21; i++) last = await app.complete({ callbackUrl: 'x', pending: 'y' });
  assert.equal(last.action, 'rate_limited');
  assert.equal(typeof last.retryAfter, 'number');
  assert.deepEqual(last.outcome, { ok: false, error: 'rate_limited' });
});

test('the web start still keeps its record in the session, and needs one', async () => {
  const app = await startApp();
  const { body } = await app.call('startOidcSignin', { input: ADA });
  assert.ok(body.url);
  assert.equal(new URL(body.url).searchParams.get('redirect_uri'), 'https://app.test/auth/oidc/callback');
  assert.equal(body.pending, undefined, 'the web start hands out no record');
});

test('a caller that is not a native client is refused: no login CSRF from a web page', async () => {
  const app = await startApp();
  const started = await app.start({ input: ADA, redirectUri: UNIVERSAL_LINK });
  const callbackUrl = await browse(started.url);
  // what a cross-site page could send: no custom header
  const plain = async (method, body) =>
    (
      await fetch(`${app.base}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    );
  const start = await plain('startNativeOidcSignin', { input: ADA, redirectUri: UNIVERSAL_LINK });
  assert.equal((await start.json()).action, 'not_native');
  const complete = await plain('completeNativeOidcSignin', { callbackUrl, pending: started.pending });
  assert.equal((await complete.json()).action, 'not_native');
  assert.deepEqual(complete.headers.getSetCookie(), [], 'no session cookie');
  assert.equal(issuer.tokenRequests.length, 0);
});
