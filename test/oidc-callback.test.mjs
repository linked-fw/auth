// Solid-OIDC sign-in through the provider, over HTTP: `startOidcSignin` keeps the pending sign-in
// in the browser's session and returns the issuer's URL, the mock issuer (mockIssuer.mjs) sends the
// browser back to `/auth/oidc/callback`, and the callback checks everything, reports a mismatch to
// the app's hook, creates the person and account and starts a session (cookies), then redirects.
//
// Runs against the BUILT package in lib/ (build first: `npx linked build`). A real express app
// with the provider's middleware (express-session on SQLite in a temp dir); the person, account
// and credential queries are answered from in-memory tables, refresh sessions are kept in memory.
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
process.env.JWT_SECRET = 'oidc-callback-test-secret-oidc-callback';
process.env.SESSION_SECRET = 'oidc-callback-test-session-secret';
process.env.AUTH_SESSION_CLEANUP = 'false';

// connect-sqlite3 (express-session store) writes into <cwd>/data
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-auth-oidc-'));
fs.mkdirSync(path.join(workDir, 'data'));
process.chdir(workDir);
process.on('exit', () => fs.rmSync(workDir, { recursive: true, force: true }));

const libDir = new URL('../lib/esm/', import.meta.url);
const { Auth } = await import(new URL('utils/auth.js', libDir));
const { AuthCredential } = await import(new URL('shapes/AuthCredential.js', libDir));
const { default: AuthBackendProvider } = await import(new URL('backend.js', libDir));
const { resetRateLimits } = await import(new URL('utils/rateLimit.js', libDir));
const { FatalConfigError } = await import(new URL('utils/secrets.js', libDir));
const sessions = await import(new URL('utils/sessions.js', libDir));
const { UserAccount } = await import('@_linked/sioc/shapes/UserAccount');

const ADA = 'ada@example.test';
const GRACE = 'grace@example.test';
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
  // the issuer mints WebIDs from emails; the app derives the same ones, as CN does with HMAC
  Auth.webIdFor = (email) => issuer.webIdFor(email.trim().toLowerCase());
  Auth.signinClient = { clientName: 'Test App' };
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

/** An app on a real port with the provider's middleware, its callback and a `/start` route. */
async function startApp() {
  const app = express();
  app.lazyrouter();
  class TestProvider extends AuthBackendProvider {
    userShape = people;
    accountShape = accounts;
  }
  const provider = new TestProvider(app, fakeLincdServer);
  await provider.setupBeforeControllers();
  // stands in for the RPC route: the method runs in the request's call, after the session layer
  app.post('/start', express.json(), async (req, res) => {
    res.json(await serving(provider, req).startOidcSignin(req.body));
  });
  const server = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  servers.push(server);
  return { base: `http://127.0.0.1:${server.address().port}`, provider };
}

/** A browser: a cookie jar over fetch, never following redirects. */
function browser(base) {
  const jar = new Map();
  const send = async (pathAndQuery, init = {}) => {
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const response = await fetch(`${base}${pathAndQuery}`, {
      redirect: 'manual',
      ...init,
      headers: { ...(init.headers || {}), ...(cookie ? { cookie } : {}) },
    });
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const index = pair.indexOf('=');
      jar.set(pair.slice(0, index), pair.slice(index + 1));
    }
    return response;
  };
  return {
    jar,
    async start(body) {
      const response = await send('/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return response.json();
    },
    callback: (query) => send(`/auth/oidc/callback${query}`),
  };
}

/** Start, let the issuer answer, and return to the callback. */
async function signIn(client, body = { input: ADA }) {
  const started = await client.start(body);
  assert.ok(started.url, JSON.stringify(started));
  const query = await issuer.authorize(started.url);
  return { started, query, response: await client.callback(query) };
}

test('an email signs in through the default issuer: person, account, session, redirect', async () => {
  const { base } = await startApp();
  const client = browser(base);
  const { started, response } = await signIn(client, { input: ' Ada@Example.test ', returnTo: '/projects?tab=1' });

  const url = new URL(started.url);
  assert.equal(url.origin, issuer.issuer);
  assert.equal(url.searchParams.get('login_hint'), ADA);
  assert.equal(url.searchParams.get('client_id'), 'https://app.test/.well-known/linked-client.jsonld');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://app.test/auth/oidc/callback');

  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/projects?tab=1');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.ok(client.jar.get('accessToken'), 'the session cookie is set');

  const webId = issuer.webIdFor(ADA);
  assert.deepEqual(people.created.map((p) => p.id), [webId]);
  assert.equal(accounts.created.length, 1);
  assert.equal(accounts.created[0].email, ADA);
  assert.equal(accounts.created[0].accountOf.id, webId);
  assert.equal(sessionStore.records.size, 1, 'a refresh session was started');
  assert.equal([...sessionStore.records.values()][0].accountId, accounts.created[0].id);
  // the issuer verified the email and it derives this WebID
  const [credential] = [...credentials.rows.values()];
  assert.equal(credential.credentialOf.id, webId);
  assert.ok(credential.emailVerifiedAt);

  assert.equal(outcomes.length, 1);
  assert.deepEqual(outcomes[0], {
    ok: true,
    webId,
    issuer: issuer.issuer,
    email: ADA,
    emailProven: true,
    isNewAccount: true,
    returnTo: '/projects?tab=1',
  });
});

test('an existing person signs in to its account; no second person or account', async () => {
  const webId = issuer.webIdFor(ADA);
  people.rows.push({ id: webId, givenName: 'Ada' });
  accounts.rows.push({ id: 'https://app.test/account/ada', email: ADA, accountOf: { id: webId } });
  const { base } = await startApp();
  const client = browser(base);
  const { response } = await signIn(client);
  assert.equal(response.headers.get('location'), '/');
  assert.equal(people.created.length, 0);
  assert.equal(accounts.created.length, 0);
  assert.equal([...sessionStore.records.values()][0].accountId, 'https://app.test/account/ada');
  assert.equal(outcomes[0].isNewAccount, false);
});

test('a first proven sign-in ends the unproven password of a pre-registered person', async () => {
  const webId = issuer.webIdFor(ADA);
  people.rows.push({ id: webId, givenName: 'Mallory' });
  accounts.rows.push({ id: 'https://app.test/account/ada', email: ADA, accountOf: { id: webId } });
  credentials.insert({ credentialOf: { id: webId }, email: ADA, passwordHash: 'attacker' });
  const { base } = await startApp();
  await signIn(browser(base));
  const [credential] = [...credentials.rows.values()];
  assert.equal(credential.passwordHash, undefined, 'the unverified password is removed');
  assert.ok(credential.emailVerifiedAt);
});

test('an email the issuer does not verify is neither stored nor marked verified', async () => {
  issuer.emailVerified = false;
  const { base } = await startApp();
  await signIn(browser(base));
  assert.equal(accounts.created.length, 1);
  assert.equal(accounts.created[0].email, undefined);
  assert.equal(credentials.rows.size, 0);
  assert.equal(outcomes[0].email, ADA);
  assert.equal(outcomes[0].emailProven, false);
});

test("another issuer's verified email for its own WebID is not stored: it proves nothing here", async () => {
  // a WebID whose profile names this issuer, with someone else's email claimed as verified
  const webId = issuer.addProfile('mallory', [issuer.issuer]);
  issuer.claims = (c) => ({ ...c, webid: webId, email: 'victim@example.test', email_verified: true });
  const { base } = await startApp();
  await signIn(browser(base), { input: webId });
  assert.equal(accounts.created[0].email, undefined);
  assert.equal(credentials.rows.size, 0);
  assert.equal(outcomes[0].emailProven, false);
});

test('a sign-in without an email proof still ends an unproven password, once', async () => {
  const webId = issuer.webIdFor(ADA);
  people.rows.push({ id: webId, givenName: 'Mallory' });
  accounts.rows.push({ id: 'https://app.test/account/ada', email: ADA, accountOf: { id: webId } });
  credentials.insert({ credentialOf: { id: webId }, email: ADA, passwordHash: 'attacker' });
  issuer.claims = (c) => ({ ...c, email: undefined, email_verified: undefined });
  const { base } = await startApp();
  await signIn(browser(base));
  const [credential] = [...credentials.rows.values()];
  assert.equal(credential.passwordHash, undefined, 'the unverified password is removed');
  assert.equal(credential.emailVerifiedAt, undefined);
  const live = () => [...sessionStore.records.values()].filter((r) => !r.revokedAt).length;
  assert.equal(live(), 1);
  // a second sign-in (another device) does not end the first one's session
  await signIn(browser(base));
  assert.equal(live(), 2);
});

test('a typed WebID: the issuer from its profile, no login_hint, the issuer check against it', async () => {
  const webId = issuer.addProfile('alice', [issuer.issuer]);
  issuer.claims = (c) => ({ ...c, webid: webId, email: undefined, email_verified: undefined });
  const { base } = await startApp();
  const { started, response } = await signIn(browser(base), { input: webId });
  assert.equal(new URL(started.url).searchParams.has('login_hint'), false);
  assert.equal(response.headers.get('location'), '/');
  assert.deepEqual(people.created.map((p) => p.id), [webId]);
  assert.equal(accounts.created[0].email, undefined);
  // once to find the issuer, once for the check (the WebID is on another origin)
  assert.equal(issuer.profileRequests, 2);
});

test('mismatch: hint A, token B is reported, and by default B signs in', async () => {
  issuer.email = GRACE;
  const { base } = await startApp();
  const { response } = await signIn(browser(base), { input: ADA });
  assert.equal(response.headers.get('location'), '/');
  assert.equal(outcomes[0].ok, true);
  assert.equal(outcomes[0].webId, issuer.webIdFor(GRACE));
  assert.deepEqual(outcomes[0].mismatch, { hinted: ADA, returned: GRACE });
  // no email in the URL
  assert.doesNotMatch(response.headers.get('location'), /@/);
});

test('mismatch: the hook gets both emails and an account lookup, and can refuse', async () => {
  people.rows.push({ id: issuer.webIdFor(ADA), givenName: 'Ada' });
  accounts.rows.push({ id: 'https://app.test/account/ada', email: ADA, accountOf: { id: issuer.webIdFor(ADA) } });
  issuer.email = GRACE;
  const seen = [];
  Auth.oidcSignin.onEmailMismatch = async (mismatch) => {
    seen.push({
      hinted: mismatch.hinted,
      returned: mismatch.returned,
      webId: mismatch.webId,
      issuer: mismatch.issuer,
      hintedHasAccount: await mismatch.hasAccount(mismatch.hinted),
      returnedHasAccount: await mismatch.hasAccount(mismatch.returned),
    });
    return 'refuse';
  };
  const { base } = await startApp();
  const client = browser(base);
  const { response } = await signIn(client, { input: ADA });
  assert.deepEqual(seen, [
    {
      hinted: ADA,
      returned: GRACE,
      webId: issuer.webIdFor(GRACE),
      issuer: issuer.issuer,
      hintedHasAccount: true,
      returnedHasAccount: false,
    },
  ]);
  assert.equal(response.headers.get('location'), '/signin?oidc_error=email_mismatch');
  assert.equal(client.jar.has('accessToken'), false, 'no session');
  assert.equal(people.created.length, 0);
  assert.deepEqual(outcomes[0], { ok: false, error: 'email_mismatch', mismatch: { hinted: ADA, returned: GRACE } });
});

test('the callback only works in the browser that started it, and only once', async () => {
  const { base } = await startApp();
  const victim = browser(base);
  const attacker = browser(base);
  const started = await attacker.start({ input: ADA });
  const query = await issuer.authorize(started.url);
  // the attacker's callback URL opened in the victim's browser
  const forged = await victim.callback(query);
  assert.equal(forged.headers.get('location'), '/signin?oidc_error=invalid_state');
  assert.equal(victim.jar.has('accessToken'), false);
  assert.equal(issuer.tokenRequests.length, 0);

  const own = await attacker.callback(query);
  assert.equal(own.headers.get('location'), '/');
  const replay = await attacker.callback(query);
  assert.equal(replay.headers.get('location'), '/signin?oidc_error=invalid_state');
});

test('login_required from a silent sign-in is returned to the app', async () => {
  issuer.authorizeError = 'login_required';
  const { base } = await startApp();
  const client = browser(base);
  const { started, response } = await signIn(client, { input: ADA, prompt: 'none', returnTo: '/x' });
  assert.equal(new URL(started.url).searchParams.get('prompt'), 'none');
  assert.equal(response.headers.get('location'), '/signin?oidc_error=login_required');
  assert.deepEqual(outcomes[0], { ok: false, error: 'login_required', returnTo: '/x' });
  assert.equal(client.jar.has('accessToken'), false);
});

test('an issuer the WebID profile does not name is refused, with no session', async () => {
  const webId = issuer.addProfile('mallory', ['https://her-issuer.test']);
  issuer.claims = (c) => ({ ...c, webid: webId });
  const { base } = await startApp();
  const client = browser(base);
  const { response } = await signIn(client);
  assert.equal(response.headers.get('location'), '/signin?oidc_error=issuer_refused');
  assert.equal(client.jar.has('accessToken'), false);
  assert.equal(people.created.length, 0);
});

test('onResult can choose where the browser goes; a failing hook keeps the default', async () => {
  Auth.oidcSignin.onResult = (outcome) => (outcome.ok ? '/welcome' : '/oops');
  const { base } = await startApp();
  const { response } = await signIn(browser(base));
  assert.equal(response.headers.get('location'), '/welcome');

  Auth.oidcSignin.onResult = () => {
    throw new Error('hook failed');
  };
  mock.method(console, 'error', () => {});
  const second = await signIn(browser(base));
  assert.equal(second.response.headers.get('location'), '/');
});

test('returnTo must be a path on this site', async () => {
  const { base } = await startApp();
  for (const returnTo of ['//evil.test/x', 'https://evil.test', '/\\evil.test', 'relative', '/a\nb']) {
    const { response } = await signIn(browser(base), { input: ADA, returnTo });
    assert.equal(response.headers.get('location'), '/', returnTo);
  }
});

test('start: invalid input, a WebID without an issuer, and an issuer that cannot be reached', async () => {
  const { base } = await startApp();
  const client = browser(base);
  assert.equal((await client.start({ input: '' })).action, 'invalid_input');
  assert.equal((await client.start({ input: 'not an email' })).action, 'invalid_input');
  assert.equal((await client.start({ input: 'x'.repeat(3000) + '@a.test' })).action, 'invalid_input');
  const webId = issuer.addProfile('nobody', []);
  assert.equal((await client.start({ input: webId })).action, 'issuer_not_found');
  const unreachable = issuer.addProfile('broken', [`${issuer.profileOrigin}/no-issuer-here`]);
  assert.equal((await client.start({ input: unreachable })).action, 'issuer_unreachable');
});

test('start: a provider hint is passed on only when it is a plain name', async () => {
  const { base } = await startApp();
  const client = browser(base);
  const hinted = await client.start({ input: ADA, providerHint: 'google' });
  assert.equal(new URL(hinted.url).searchParams.get('provider_hint'), 'google');
  const odd = await client.start({ input: ADA, providerHint: 'goo gle&x=1' });
  assert.equal(new URL(odd.url).searchParams.has('provider_hint'), false);
});

test('an app that did not opt in has no callback and refuses to start', async () => {
  delete Auth.oidcSignin;
  const { base } = await startApp();
  const client = browser(base);
  assert.deepEqual(await client.start({ input: ADA }), {
    error: 'WebID sign-in is not available',
    action: 'not_configured',
  });
  const response = await client.callback('?state=x&code=y');
  assert.equal(response.status, 404);
});

test('startup fails without a client_id, or with a SITE_ROOT an issuer would refuse', async () => {
  delete Auth.signinClient;
  await assert.rejects(startApp(), FatalConfigError);
  Auth.signinClient = { clientName: 'Test App' };
  process.env.SITE_ROOT = 'http://app.test';
  try {
    await assert.rejects(startApp(), FatalConfigError);
  } finally {
    process.env.SITE_ROOT = 'https://app.test';
  }
  // an explicit clientId is enough without a served document
  Auth.oidcSignin.clientId = 'https://app.test/client.jsonld';
  delete Auth.signinClient;
  const { base } = await startApp();
  const started = await browser(base).start({ input: ADA });
  assert.equal(new URL(started.url).searchParams.get('client_id'), 'https://app.test/client.jsonld');
});

test('the callback is rate limited per IP', async () => {
  process.env.AUTH_RATE_LIMIT_OIDC_CALLBACK_IP = '2/60';
  try {
    resetRateLimits();
    const { base } = await startApp();
    const client = browser(base);
    await client.callback('?state=a');
    await client.callback('?state=b');
    const limited = await client.callback('?state=c');
    assert.equal(limited.headers.get('location'), '/signin?oidc_error=rate_limited');
  } finally {
    delete process.env.AUTH_RATE_LIMIT_OIDC_CALLBACK_IP;
    resetRateLimits();
  }
});
