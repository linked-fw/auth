// Solid-OIDC sign-in against a REAL graph store: through a mock issuer (../mockIssuer.mjs), a new
// WebID gets its person, account and verified email, and the session it starts authenticates the
// next request; the same WebID signing in again reaches the same account; a native app's sign-in
// (sealed pending record, app-claimed link, tokens in the body) reaches the same account too; and a
// WebID that signed in with dev sign-in first (an account, no person) keeps that one account.
//
// Needs a Fuseki server (see fuseki.mjs). Runs against the BUILT package in lib/ (build first).
import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { serving } from '../serving.mjs';
import { startMockIssuer } from '../mockIssuer.mjs';
import { useThrowawayDataset, countSubjectsWith, sparql, AUTH } from './fuseki.mjs';

process.env.NODE_ENV = 'test';
process.env.SITE_ROOT = 'https://app.test';
process.env.JWT_SECRET = 'integration-test-secret-integration';
process.env.SESSION_SECRET = 'integration-test-session-secret';
process.env.AUTH_SESSION_CLEANUP = 'false';
process.env.DATA_ROOT = 'https://data.app.test';
delete process.env.DEV_AUTH;

// connect-sqlite3 (express-session store) writes into <cwd>/data
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-auth-oidc-it-'));
fs.mkdirSync(path.join(workDir, 'data'));
process.chdir(workDir);
process.on('exit', () => fs.rmSync(workDir, { recursive: true, force: true }));

const libDir = new URL('../../lib/esm/', import.meta.url);
await import(new URL('shapes/index.js', libDir));
const { default: AuthBackendProvider } = await import(new URL('backend.js', libDir));
const { Auth } = await import(new URL('utils/auth.js', libDir));
const jwtUtils = await import(new URL('utils/jwt.js', libDir));

const SIOC_ACCOUNT_OF = 'http://rdfs.org/sioc/ns#account_of';
const NATIVE_LINK = 'test.app.native:/oidc/callback';
const fakeLincdServer = { callGenericBackendProvidersMethod: async () => {} };

useThrowawayDataset();

let issuer;
let base;
let server;
let outcomes = [];

before(async () => {
  mock.method(console, 'log', () => {});
  mock.method(console, 'warn', () => {});
  issuer = await startMockIssuer();
  Auth.webIdFor = (email) => issuer.webIdFor(email.trim().toLowerCase());
  Auth.signinClient = { clientName: 'Test App', redirectUris: [NATIVE_LINK] };
  Auth.oidcSignin = {
    allowLocalhost: true,
    defaultIssuer: issuer.issuer,
    discovery: { skipDomains: ['example.test'] },
    onResult: (outcome) => {
      outcomes.push(outcome);
      return undefined;
    },
  };
  const app = express();
  app.lazyrouter();
  const provider = new AuthBackendProvider(app, fakeLincdServer);
  await provider.setupBeforeControllers();
  app.post('/start', express.json(), async (req, res) => {
    res.json(await serving(provider, req).startOidcSignin(req.body));
  });
  for (const method of ['startNativeOidcSignin', 'completeNativeOidcSignin', 'signinDev']) {
    app.post(`/${method}`, express.json(), async (req, res) => {
      res.json(await serving(provider, req)[method](req.body));
    });
  }
  // who the access token cookie authenticates
  app.get('/me', (req, res) => res.json({ user: req.linkedAuth?.user?.id ?? null }));
  server = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  issuer?.close();
});

/** A browser with a cookie jar, signing in with `email` through the mock issuer. */
async function signIn(email) {
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
  issuer.email = email;
  const started = await (
    await send('/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: email }),
    })
  ).json();
  assert.ok(started.url, JSON.stringify(started));
  const callback = await send(`/auth/oidc/callback${await issuer.authorize(started.url)}`);
  const me = await (await send('/me')).json();
  return { callback, me, jar };
}

const newEmail = () => `ada-${crypto.randomBytes(4).toString('hex')}@example.test`;

test('a new WebID gets a person, an account with its email, a verified email and a session', async () => {
  const email = newEmail();
  const webId = issuer.webIdFor(email);
  const { callback, me, jar } = await signIn(email);
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get('location'), '/');
  assert.ok(jar.get('accessToken'), 'no access token cookie');
  assert.equal(me.user, webId, 'the session authenticates the next request');

  assert.equal(await countSubjectsWith(SIOC_ACCOUNT_OF, webId), 1);
  const emails = await sparql(`
    SELECT ?email WHERE {
      { ?a <${SIOC_ACCOUNT_OF}> <${webId}> ; <http://rdfs.org/sioc/ns#email> ?email }
      UNION { GRAPH ?g { ?a <${SIOC_ACCOUNT_OF}> <${webId}> ; <http://rdfs.org/sioc/ns#email> ?email } }
    }`);
  assert.deepEqual(emails.map((row) => row.email.value), [email]);
  const verified = await sparql(`
    SELECT ?at WHERE {
      { ?c <${AUTH}credentialOf> <${webId}> ; <${AUTH}emailVerifiedAt> ?at }
      UNION { GRAPH ?g { ?c <${AUTH}credentialOf> <${webId}> ; <${AUTH}emailVerifiedAt> ?at } }
    }`);
  assert.equal(verified.length, 1);
});

test('signing in again with the same WebID reaches the same account', async () => {
  const email = newEmail();
  const webId = issuer.webIdFor(email);
  await signIn(email);
  const second = await signIn(email);
  assert.equal(second.me.user, webId);
  assert.equal(await countSubjectsWith(SIOC_ACCOUNT_OF, webId), 1, 'one account');
});

test('a native sign-in reaches the same account, and its bearer token authenticates', async () => {
  const email = newEmail();
  const webId = issuer.webIdFor(email);
  await signIn(email);
  issuer.email = email;
  const call = async (method, body) =>
    (
      await fetch(`${base}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-linked-auth-transport': 'body' },
        body: JSON.stringify(body),
      })
    ).json();
  const started = await call('startNativeOidcSignin', { input: email, redirectUri: NATIVE_LINK });
  assert.ok(started.pending, JSON.stringify(started));
  const callbackUrl = (await fetch(started.url, { redirect: 'manual' })).headers.get('location');
  const answer = await call('completeNativeOidcSignin', { callbackUrl, pending: started.pending });
  assert.ok(answer.refreshToken, JSON.stringify(answer));
  assert.equal(answer.outcome.isNewAccount, false);
  const me = await (
    await fetch(`${base}/me`, { headers: { authorization: `Bearer ${answer.accessToken}` } })
  ).json();
  assert.equal(me.user, webId);
  assert.equal(await countSubjectsWith(SIOC_ACCOUNT_OF, webId), 1, 'one account');
});

test('a dev sign-in, then an issuer sign-in of the same WebID: one account', async () => {
  const email = newEmail();
  const webId = issuer.webIdFor(email);
  process.env.DEV_AUTH = 'true';
  try {
    const accessToken = await jwtUtils.createAccessToken({
      user: { id: webId },
      userAccount: { id: 'https://app.test/account/unused' },
    });
    const dev = await (
      await fetch(`${base}/signinDev`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-linked-auth-transport': 'body' },
        body: JSON.stringify({ webId, accessToken, refreshToken: '' }),
      })
    ).json();
    assert.ok(!dev?.error, JSON.stringify(dev));
  } finally {
    delete process.env.DEV_AUTH;
  }
  assert.equal(await countSubjectsWith(SIOC_ACCOUNT_OF, webId), 1, 'dev sign-in made the account');

  outcomes = [];
  const { me } = await signIn(email);
  assert.equal(me.user, webId);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].ok, true, JSON.stringify(outcomes[0]));
  assert.equal(outcomes[0].isNewAccount, false);
  assert.equal(await countSubjectsWith(SIOC_ACCOUNT_OF, webId), 1, 'one account');
  // the proven email is stored on the reused account
  const emails = await sparql(`
    SELECT ?email WHERE {
      { ?a <${SIOC_ACCOUNT_OF}> <${webId}> ; <http://rdfs.org/sioc/ns#email> ?email }
      UNION { GRAPH ?g { ?a <${SIOC_ACCOUNT_OF}> <${webId}> ; <http://rdfs.org/sioc/ns#email> ?email } }
    }`);
  assert.deepEqual(emails.map((row) => row.email.value), [email]);
});

const SCHEMA = 'http://schema.org/';

/** The person's given and family names, from any graph. */
async function namesOf(webId) {
  const rows = await sparql(`
    SELECT ?given ?family WHERE {
      { <${webId}> <${SCHEMA}givenName> ?given ; <${SCHEMA}familyName> ?family }
      UNION { GRAPH ?g { <${webId}> <${SCHEMA}givenName> ?given ; <${SCHEMA}familyName> ?family } }
    }`);
  return rows.map((row) => [row.given.value, row.family.value]);
}

test('the issuer names a new person; every later sign-in writes its name claims, none clears one', async () => {
  try {
    const email = newEmail();
    const webId = issuer.webIdFor(email);
    issuer.claims = (c) => ({ ...c, given_name: 'Ada', family_name: 'Lovelace' });
    await signIn(email);
    assert.deepEqual(await namesOf(webId), [['Ada', 'Lovelace']]);

    issuer.claims = (c) => ({ ...c, given_name: 'Augusta', family_name: 'King' });
    await signIn(email);
    assert.deepEqual(await namesOf(webId), [['Augusta', 'King']], 'a changed name is written');

    issuer.claims = (c) => c;
    await signIn(email);
    assert.deepEqual(await namesOf(webId), [['Augusta', 'King']], 'a sign-in without claims keeps them');

    const unnamed = newEmail();
    const unnamedId = issuer.webIdFor(unnamed);
    await signIn(unnamed);
    assert.deepEqual(await namesOf(unnamedId), [], 'no empty literal for a person without names');
    issuer.claims = (c) => ({ ...c, given_name: 'Grace', family_name: 'Hopper' });
    await signIn(unnamed);
    assert.deepEqual(await namesOf(unnamedId), [['Grace', 'Hopper']], 'names are added later');
  } finally {
    issuer.claims = (c) => c;
  }
});
