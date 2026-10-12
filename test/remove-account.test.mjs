// removeAccount deletes an account only with proof that it is the account holder: the password,
// or a freshly issued ID token of a Google/Apple identity linked to the account. Accounts with
// nothing to check against (temporary and dev accounts) need only a session.
//
// Runs against the BUILT package in lib/ (build first: `npx linked build`). No store: credentials
// are an in-memory table, the identity-link store and the provider token check are stubbed, and
// the deletes are recorded instead of run. The same flow runs against a real store in
// test/integration/accounts.fuseki.test.mjs.
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serving } from './serving.mjs';
import { fakeCredentialTable } from './fakeStore.mjs';

process.env.NODE_ENV = 'test';
process.env.SITE_ROOT = 'https://app.test';
process.env.JWT_SECRET = 'unit-test-secret-unit-test-secret';
process.env.SESSION_SECRET = 'unit-test-session-secret';
process.env.AUTH_SESSION_CLEANUP = 'false';

// connect-sqlite3 (express-session store) writes into <cwd>/data
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-auth-test-'));
fs.mkdirSync(path.join(workDir, 'data'));
process.chdir(workDir);
process.on('exit', () => fs.rmSync(workDir, { recursive: true, force: true }));

const libDir = new URL('../lib/esm/', import.meta.url);
const { AuthCredential } = await import(new URL('shapes/AuthCredential.js', libDir));
const { IdentityToken } = await import(new URL('shapes/IdentityToken.js', libDir));
const { default: PasswordHelper } = await import(new URL('helpers/password.js', libDir));
const { default: GoogleHelper } = await import(new URL('helpers/google.js', libDir));
const { OAuthIdentityStore } = await import(new URL('utils/oauthIdentities.js', libDir));
const sessions = await import(new URL('utils/sessions.js', libDir));
const { default: AuthBackendProvider } = await import(new URL('backend.js', libDir));
const { REAUTH_MAX_TOKEN_AGE } = await import(new URL('helpers/reauthentication.js', libDir));
const { resetRateLimits } = await import(new URL('utils/rateLimit.js', libDir));

const PERSON = 'https://id.test/person/ada';
const ACCOUNT = 'https://app.test/account/ada';
const SESSION = { user: { id: PERSON }, userAccount: { id: ACCOUNT } };
const PASSWORD = 'long-enough';
const MISSING = 'Confirm it is you to delete this account.';
const MISMATCH = 'That confirmation did not match this account.';
const fakeLincdServer = { callGenericBackendProvidersMethod: async () => {} };

let credentials;
// what the stubbed identity-link store holds: [provider, subject, accountId]
let links;
// what the stubbed Google check returns for any token
let googlePayload;
let deleted;

beforeEach(() => {
  resetRateLimits();
  credentials = fakeCredentialTable();
  credentials.install(AuthCredential);
  links = [];
  googlePayload = null;
  deleted = [];
  mock.method(OAuthIdentityStore, 'findLinks', async (provider, subject) =>
    links
      .filter(([p, s]) => p === provider && s === subject)
      .map(([, , accountId], i) => ({ id: `link-${i}`, accountId, legacy: false }))
  );
  mock.method(OAuthIdentityStore, 'findLinkedProviders', async (accountId) => [
    ...new Set(links.filter(([, , a]) => a === accountId).map(([p]) => p)),
  ]);
  mock.method(GoogleHelper, 'validateIdToken', async () => googlePayload);
  mock.method(AuthCredential, 'deleteWhere', async () => deleted.push('credentials'));
  mock.method(IdentityToken, 'deleteWhere', async () => deleted.push('identity tokens'));
  sessions.setRefreshSessionStore(new sessions.MemoryRefreshSessionStore());
  mock.method(console, 'log', () => {});
  mock.method(console, 'warn', () => {});
  mock.method(console, 'error', () => {});
});

afterEach(() => {
  mock.restoreAll();
});

/** The provider serving one call; `linkedAuth` makes it a signed-in call. */
function providerFor(linkedAuth = SESSION) {
  const instance = new AuthBackendProvider(null, fakeLincdServer);
  instance.accountShape = { delete: async (node) => deleted.push(`account ${node.id}`) };
  instance.userShape = { delete: async (node) => deleted.push(`person ${node.id}`) };
  const request = { headers: {}, cookies: {}, res: { cookie() {}, clearCookie() {} } };
  if (linkedAuth) request.linkedAuth = linkedAuth;
  return serving(instance, request);
}

async function withPassword() {
  credentials.insert({
    credentialOf: { id: PERSON },
    passwordHash: await PasswordHelper.generateHashedPassword(PASSWORD),
  });
}

/** A Google ID token payload issued `ageMs` ago for subject `sub`. */
function googleToken(sub, ageMs = 0) {
  const iat = Math.floor((Date.now() - ageMs) / 1000);
  return { sub, email: 'ada@example.test', email_verified: true, iat, exp: iat + 3600 };
}

const googleProof = { provider: 'google', source: { authentication: { idToken: 'google-id-token' } } };

const accountDeleted = () => deleted.includes(`account ${ACCOUNT}`);

test('a password account without proof is asked for its password', async () => {
  await withPassword();
  assert.deepEqual(await providerFor().removeAccount(), {
    error: MISSING,
    action: 'reauthenticate',
    methods: ['password'],
  });
  assert.deepEqual(await providerFor().getReauthenticationMethods(), { methods: ['password'] });
  assert.deepEqual(deleted, []);
});

test('a wrong password is refused and deletes nothing', async () => {
  await withPassword();
  assert.deepEqual(await providerFor().removeAccount({ password: 'not-the-password' }), {
    error: MISMATCH,
    action: 'reauthenticate',
    methods: ['password'],
  });
  assert.deepEqual(await providerFor().removeAccount({ password: 42 }), {
    error: MISMATCH,
    action: 'reauthenticate',
    methods: ['password'],
  });
  assert.deepEqual(deleted, []);
});

test('the right password deletes the account', async () => {
  await withPassword();
  assert.equal(await providerFor().removeAccount({ password: PASSWORD }), true);
  assert.deepEqual(deleted, [
    'credentials',
    'identity tokens',
    `account ${ACCOUNT}`,
    `person ${PERSON}`,
  ]);
});

test('an OAuth-only account without proof is asked for its linked providers', async () => {
  links.push(['google', 'g-ada', ACCOUNT]);
  assert.deepEqual(await providerFor().removeAccount(), {
    error: MISSING,
    action: 'reauthenticate',
    methods: ['google'],
  });
  assert.deepEqual(await providerFor().getReauthenticationMethods(), { methods: ['google'] });
  assert.deepEqual(deleted, []);
});

test('a valid Google token of an identity linked to another account is refused', async () => {
  links.push(['google', 'g-ada', ACCOUNT], ['google', 'g-eve', 'https://app.test/account/eve']);
  googlePayload = googleToken('g-eve');
  const result = await providerFor().removeAccount(googleProof);
  assert.deepEqual(result, { error: MISMATCH, action: 'reauthenticate', methods: ['google'] });
  assert.equal(accountDeleted(), false);
});

test('a fresh Google token of the linked identity deletes the account', async () => {
  links.push(['google', 'g-ada', ACCOUNT]);
  googlePayload = googleToken('g-ada', 60 * 1000);
  assert.equal(await providerFor().removeAccount(googleProof), true);
  assert.equal(GoogleHelper.validateIdToken.mock.calls[0].arguments[0], 'google-id-token');
  assert.equal(accountDeleted(), true);
});

test('a linked Google token also confirms a password account', async () => {
  await withPassword();
  links.push(['google', 'g-ada', ACCOUNT]);
  googlePayload = googleToken('g-ada');
  assert.equal(await providerFor().removeAccount(googleProof), true);
});

test('a Google token issued more than 10 minutes ago is refused', async () => {
  links.push(['google', 'g-ada', ACCOUNT]);
  googlePayload = googleToken('g-ada', REAUTH_MAX_TOKEN_AGE + 60 * 1000);
  const result = await providerFor().removeAccount(googleProof);
  assert.deepEqual(result, { error: MISMATCH, action: 'reauthenticate', methods: ['google'] });
  // without an issue time a token is not known to be fresh either
  googlePayload = { ...googleToken('g-ada'), iat: undefined };
  assert.equal((await providerFor().removeAccount(googleProof)).action, 'reauthenticate');
  assert.equal(accountDeleted(), false);
});

test('an invalid token or an unsupported provider is refused', async () => {
  links.push(['google', 'g-ada', ACCOUNT]);
  googlePayload = null;
  assert.equal((await providerFor().removeAccount(googleProof)).action, 'reauthenticate');
  googlePayload = googleToken('g-ada');
  const facebook = { provider: 'facebook', source: { authentication: { idToken: 'x' } } };
  assert.equal((await providerFor().removeAccount(facebook)).action, 'reauthenticate');
  assert.equal(accountDeleted(), false);
});

test('an account with no credential and no links is deleted with only a session', async () => {
  assert.deepEqual(await providerFor().getReauthenticationMethods(), { methods: [] });
  assert.equal(await providerFor().removeAccount(), true);
  assert.equal(accountDeleted(), true);
});

test('checking a proof is rate-limited; asking for the methods is not', async () => {
  await withPassword();
  for (let i = 0; i < 8; i++) {
    assert.equal((await providerFor().removeAccount()).action, 'reauthenticate');
  }
  for (let i = 0; i < 5; i++) {
    assert.equal((await providerFor().removeAccount({ password: 'wrong' })).action, 'reauthenticate');
  }
  const limited = await providerFor().removeAccount({ password: PASSWORD });
  assert.equal(limited.action, 'rate_limited');
  assert.equal(accountDeleted(), false);
});

test('without a session both are refused with 401', async () => {
  for (const call of [
    () => providerFor(null).removeAccount({ password: PASSWORD }),
    () => providerFor(null).getReauthenticationMethods(),
  ]) {
    await assert.rejects(call(), (err) => {
      assert.equal(err.status, 401);
      return true;
    });
  }
  assert.deepEqual(deleted, []);
});
