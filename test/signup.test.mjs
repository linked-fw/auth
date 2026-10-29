// createAccount refuses an email that a person, an account or a credential already holds, and
// a password shorter than MIN_PASSWORD_LENGTH; a new account stores the normalized email.
//
// Runs against the BUILT package in lib/ (build first: `npx linked build`). No store: the person,
// account and credential shapes are in-memory tables, and Auth.login only runs the create step.
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serving } from './serving.mjs';
import { fakeShapeTable } from './fakeStore.mjs';

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
const { Auth } = await import(new URL('utils/auth.js', libDir));
const { AuthCredential } = await import(new URL('shapes/AuthCredential.js', libDir));
const { emailToWebID } = await import(new URL('utils/webID.js', libDir));
const { default: PasswordHelper, MIN_PASSWORD_LENGTH } = await import(
  new URL('helpers/password.js', libDir)
);
const { default: AuthBackendProvider } = await import(new URL('backend.js', libDir));
const { resetRateLimits } = await import(new URL('utils/rateLimit.js', libDir));

const EMAIL = 'ada@example.test';
const WEBID = emailToWebID(EMAIL);
const PASSWORD = 'long-enough';
const IN_USE = {
  error:
    'This email address is already in use. Please choose another email or log in with your existing account.',
  action: 'change_email_or_log_in',
};
const fakeLincdServer = { callGenericBackendProvidersMethod: async () => {} };

let people;
let accounts;
let credentials;
let provider;

beforeEach(() => {
  resetRateLimits();
  people = fakeShapeTable('person');
  accounts = fakeShapeTable('account');
  credentials = fakeShapeTable('credential');
  mock.method(AuthCredential, 'select', () => credentials.select());
  mock.method(AuthCredential, 'create', (data) => credentials.create(data));
  // only the create step: the sign-in that follows it is not what these tests check
  mock.method(Auth, 'login', async (_provider, _find, create) => ({ created: await create() }));
  mock.method(console, 'log', () => {});
  mock.method(console, 'warn', () => {});
  mock.method(console, 'error', () => {});
  const instance = new AuthBackendProvider(null, fakeLincdServer);
  instance.userShape = people;
  instance.accountShape = accounts;
  const request = { headers: {}, cookies: {}, res: { cookie() {}, clearCookie() {} } };
  provider = serving(instance, request);
});

afterEach(() => mock.restoreAll());

// `password` is passed as given, so a test can send none
const signup = (email = EMAIL, ...password) =>
  provider.createAccount({
    firstName: 'Ada',
    lastName: 'Lovelace',
    email,
    password: password.length ? password[0] : PASSWORD,
  });

function nothingCreated() {
  assert.deepEqual(people.created, [], 'a person was created');
  assert.deepEqual(accounts.created, [], 'an account was created');
  assert.deepEqual(credentials.created, [], 'a credential was created');
}

test('refuses an email whose person already exists', async () => {
  people.rows.push({ id: WEBID, givenName: 'Ada' });
  assert.deepEqual(await signup(), IN_USE);
  nothingCreated();
});

test('refuses an email that only an account holds', async () => {
  accounts.rows.push({ id: 'https://app.test/account/old', email: EMAIL });
  assert.deepEqual(await signup(), IN_USE);
  nothingCreated();
});

test('refuses an email an account holds, typed in another case', async () => {
  accounts.rows.push({ id: 'https://app.test/account/old', email: EMAIL });
  assert.deepEqual(await signup('ADA@Example.Test'), IN_USE);
  nothingCreated();
});

test('refuses an email an older account stored as typed', async () => {
  accounts.rows.push({ id: 'https://app.test/account/old', email: 'Ada@Example.test' });
  assert.deepEqual(await signup('Ada@Example.test'), IN_USE);
  nothingCreated();
});

test('refuses an email that only a credential holds', async () => {
  credentials.rows.push({ id: 'https://app.test/credential/old', email: EMAIL });
  assert.deepEqual(await signup(), IN_USE);
  nothingCreated();
});

test('refuses an email whose WebID already has a credential', async () => {
  credentials.rows.push({ id: 'https://app.test/credential/old', credentialOf: { id: WEBID } });
  assert.deepEqual(await signup(), IN_USE);
  nothingCreated();
});

for (const [label, password] of [
  ['a missing', undefined],
  ['an empty', ''],
  ['a short', 'x'.repeat(MIN_PASSWORD_LENGTH - 1)],
  ['a non-string', 12345678],
]) {
  test(`refuses ${label} password before looking anything up`, async () => {
    const result = await signup(EMAIL, password);
    assert.deepEqual(result, {
      error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
      action: 'invalid_password',
    });
    nothingCreated();
    assert.equal(people.selects.length + accounts.selects.length + credentials.selects.length, 0);
  });
}

test('creates the account when nothing exists, with the normalized email', async () => {
  const result = await signup(' Ada@Example.TEST ');
  assert.ok(result.created, `not created: ${JSON.stringify(result)}`);

  assert.equal(people.created.length, 1);
  assert.deepEqual(people.created[0], { id: WEBID, givenName: 'Ada', familyName: 'Lovelace' }, 'no telephone ""');

  assert.equal(accounts.created.length, 1);
  assert.equal(accounts.created[0].email, EMAIL);

  assert.equal(credentials.created.length, 1);
  const credential = credentials.created[0];
  assert.equal(credential.email, EMAIL);
  assert.deepEqual(credential.credentialOf, { id: WEBID });
  assert.equal(await PasswordHelper.checkPassword(PASSWORD, credential.passwordHash), true);
});

test('reuses the account another method made for the WebID (dev sign-in keeps no person)', async () => {
  accounts.rows.push({ id: 'https://app.test/account/dev', accountOf: { id: WEBID } });
  const result = await signup();
  assert.ok(result.created, `not created: ${JSON.stringify(result)}`);
  assert.equal(result.created.isNewAccount, false);
  assert.equal(result.created.account.id, 'https://app.test/account/dev');
  assert.equal(people.created.length, 1);
  assert.equal(accounts.created.length, 0, 'no second account');
  assert.equal(accounts.rows[0].email, EMAIL);
});

test('signup does not replace an email already on the reused account (nothing proved its own)', async () => {
  accounts.rows.push({ id: 'https://app.test/account/dev', email: 'dev-token@example.test', accountOf: { id: WEBID } });
  const result = await signup();
  assert.ok(result.created, `not created: ${JSON.stringify(result)}`);
  assert.equal(result.created.isNewAccount, false);
  assert.equal(accounts.rows[0].email, 'dev-token@example.test');
});

test('a password of exactly the minimum length is accepted', async () => {
  const result = await signup(EMAIL, 'x'.repeat(MIN_PASSWORD_LENGTH));
  assert.ok(result.created, `not created: ${JSON.stringify(result)}`);
});
