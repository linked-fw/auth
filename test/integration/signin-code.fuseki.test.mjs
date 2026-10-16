// Sign-in by emailed code against a REAL graph store: the code is stored, consumed once (also
// under concurrency), and a code for a new email creates the person, account and session.
//
// Needs a Fuseki server (see fuseki.mjs). Runs against the BUILT package in lib/ (build first).
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { serving } from '../serving.mjs';
import { useThrowawayDataset, countSubjectsWith, sparql, AUTH } from './fuseki.mjs';

process.env.NODE_ENV = 'test';
process.env.SITE_ROOT = 'https://app.test';
process.env.JWT_SECRET = 'integration-test-secret-integration';
process.env.SESSION_SECRET = 'integration-test-session-secret';
process.env.AUTH_SESSION_CLEANUP = 'false';
process.env.DATA_ROOT = 'https://data.app.test';
delete process.env.DEV_AUTH;

const libDir = new URL('../../lib/esm/', import.meta.url);
await import(new URL('shapes/index.js', libDir));
const { default: AuthBackendProvider } = await import(new URL('backend.js', libDir));
const { INVALID_SIGNIN_CODE_MESSAGE } = await import(new URL('utils/signinCode.js', libDir));
const { Auth } = await import(new URL('utils/auth.js', libDir));
const { LinkedEmail } = await import('@_linked/server-utils/utils/LinkedEmail');

const fakeLincdServer = { callGenericBackendProvidersMethod: async () => {} };

useThrowawayDataset();

let sentEmails;
beforeEach(() => {
  sentEmails = [];
  mock.method(LinkedEmail, 'send', async (options) => {
    sentEmails.push(options);
  });
  mock.method(console, 'log', () => {});
  mock.method(console, 'warn', () => {});
});

function provider(request = { headers: {}, cookies: {} }) {
  request.headers = { 'x-linked-auth-transport': 'body', ...request.headers };
  return serving(new AuthBackendProvider(null, fakeLincdServer), request);
}

const newEmail = () => `ada-${crypto.randomBytes(4).toString('hex')}@example.test`;

/** Request a code for `email` and return it, read from the link in the email sent. */
async function requestCode(email) {
  assert.equal(await provider().sendSigninCode(email), true);
  const link = sentEmails.at(-1).htmlbody.match(/href='([^']*signin-code[^']*)'/)[1];
  return new URL(link.replace(/&amp;/g, '&')).searchParams.get('code');
}

/** The literal values of `predicate` on the credentials of `personId`. */
async function credentialValues(personId, predicate) {
  const rows = await sparql(`
    SELECT ?v WHERE {
      { ?c <${AUTH}credentialOf> <${personId}> ; <${AUTH}${predicate}> ?v }
      UNION { GRAPH ?g { ?c <${AUTH}credentialOf> <${personId}> ; <${AUTH}${predicate}> ?v } }
    }`);
  return rows.map((row) => row.v.value);
}

test('a code for a new email creates the person, account and session, and works once', async () => {
  const email = newEmail();
  const code = await requestCode(email);

  const signin = await provider().signinWithCode(email, code);
  assert.equal(signin.error, undefined, signin.error);
  const personId = Auth.webIdFor(email);
  assert.equal(signin.auth.user.id, personId);
  assert.ok(signin.accessToken, 'no access token');
  assert.equal(signin.auth.emailVerified, true);
  assert.equal(await countSubjectsWith(`${AUTH}credentialOf`, personId), 1);
  assert.equal((await credentialValues(personId, 'emailVerifiedAt')).length, 1);
  assert.deepEqual(await credentialValues(personId, 'email'), [email]);
  assert.deepEqual(await credentialValues(personId, 'signinCodeEmailHash'), []);
  assert.deepEqual(await credentialValues(personId, 'signinCode'), []);

  assert.deepEqual(await provider().signinWithCode(email, code), {
    error: INVALID_SIGNIN_CODE_MESSAGE,
    action: 'invalid_code',
  });
  // a second sign-in with a new code reaches the same person and account
  const again = await provider().signinWithCode(email, await requestCode(email));
  assert.equal(again.auth.user.id, personId);
  assert.equal(again.auth.userAccount.id, signin.auth.userAccount.id);
});

test('a code verifies a password account and ends access its email never proved', async () => {
  const email = newEmail();
  const created = await provider().createAccount({
    firstName: 'Ada',
    email,
    password: 'first-Passw0rd!',
  });
  assert.equal(created.error, undefined, created.error);
  const personId = created.auth.user.id;
  assert.deepEqual(await credentialValues(personId, 'emailVerifiedAt'), []);

  const signin = await provider().signinWithCode(email, await requestCode(email));
  assert.equal(signin.error, undefined, signin.error);
  assert.equal(signin.auth.user.id, personId);
  assert.equal(signin.auth.userAccount.id, created.auth.userAccount.id);
  assert.equal((await credentialValues(personId, 'emailVerifiedAt')).length, 1);
  // the password was set before the email was proven: it is gone, and so is the signup's session
  assert.deepEqual(await credentialValues(personId, 'passwordHash'), []);
  const password = await provider().signinWithPassword(email, 'first-Passw0rd!');
  assert.ok(password.error, 'the unproven password still signs in');
  const refreshed = await provider().validateToken(created.refreshToken);
  assert.ok(!refreshed?.auth, 'the signup session still refreshes');
  // a verified account keeps its sessions: the code session refreshes
  const again = await provider().validateToken(signin.refreshToken);
  assert.ok(again?.auth, 'the code session does not refresh');
});

test('of concurrent sign-ins with one code, exactly one succeeds', async () => {
  const email = newEmail();
  await provider().createAccount({ firstName: 'Ada', email, password: 'first-Passw0rd!' });
  const code = await requestCode(email);
  const results = await Promise.all(
    Array.from({ length: 5 }, () => provider().signinWithCode(email, code))
  );
  assert.equal(results.filter((result) => result.auth).length, 1, JSON.stringify(results));
});

test('a pending code does not block a password signup for the email', async () => {
  const email = newEmail();
  await requestCode(email);
  const created = await provider().createAccount({
    firstName: 'Ada',
    email,
    password: 'first-Passw0rd!',
  });
  assert.equal(created.error, undefined, created.error);
});
