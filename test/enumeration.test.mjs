// signinWithPassword gives one answer for an unknown email, an account without a password and a
// wrong password, so it never tells whether an account exists; the paths that find no password
// still run one bcrypt comparison, so they take about as long as a wrong password.
//
// Runs against the BUILT package in lib/ (build first: `npx linked build`). No store: the
// account and credential queries are answered from in-memory tables.
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
const { default: PasswordHelper, INVALID_CREDENTIALS_MESSAGE } = await import(
  new URL('helpers/password.js', libDir)
);
const { default: AuthBackendProvider } = await import(new URL('backend.js', libDir));
const { resetRateLimits } = await import(new URL('utils/rateLimit.js', libDir));
const { UserAccount } = await import('@_linked/sioc/shapes/UserAccount');
const { default: bcrypt } = await import('bcrypt');

const EMAIL = 'ada@example.test';
const WEBID = emailToWebID(EMAIL);
const ACCOUNT = { id: 'https://app.test/account/ada', email: EMAIL, accountOf: { id: WEBID } };
const SIGNED_IN = { signedIn: true };
const fakeLincdServer = { callGenericBackendProvidersMethod: async () => {} };

let accounts;
let credentials;
let compare;
let provider;

class TestProvider extends AuthBackendProvider {
  async getOrCreateAccount() {
    return { ...ACCOUNT };
  }
}

beforeEach(async () => {
  resetRateLimits();
  // computed before the spy, so a first-use hash of the dummy password is not counted
  await PasswordHelper.compareWithDummyHash('warm-up');
  accounts = fakeShapeTable('account');
  credentials = fakeShapeTable('credential');
  mock.method(UserAccount, 'select', () => accounts.select());
  mock.method(AuthCredential, 'select', () => credentials.select());
  mock.method(Auth, 'onSigninSuccessful', async () => SIGNED_IN);
  compare = mock.method(bcrypt, 'compare');
  mock.method(console, 'log', () => {});
  mock.method(console, 'warn', () => {});
  mock.method(console, 'error', () => {});
  const request = { headers: {}, cookies: {}, res: { cookie() {}, clearCookie() {} } };
  provider = serving(new TestProvider(null, fakeLincdServer), request);
});

afterEach(() => mock.restoreAll());

const INVALID = { error: INVALID_CREDENTIALS_MESSAGE };

test('an unknown email gets the invalid-credentials answer, after one bcrypt comparison', async () => {
  assert.deepEqual(await provider.signinWithPassword(EMAIL, 'whatever-1'), INVALID);
  assert.equal(compare.mock.callCount(), 1);
});

test('an account without a password gets the same answer, after one bcrypt comparison', async () => {
  accounts.rows.push({ ...ACCOUNT });
  // an OAuth credential: no password hash
  credentials.rows.push({ id: 'https://app.test/credential/1', credentialOf: { id: WEBID } });
  assert.deepEqual(await provider.signinWithPassword(EMAIL, 'whatever-1'), INVALID);
  assert.equal(compare.mock.callCount(), 1);
});

test('a wrong password gets the same answer', async () => {
  credentials.rows.push({
    id: 'https://app.test/credential/1',
    credentialOf: { id: WEBID },
    passwordHash: await bcrypt.hash('right-password', 4),
  });
  compare.mock.resetCalls();
  assert.deepEqual(await provider.signinWithPassword(EMAIL, 'wrong-password'), INVALID);
  assert.equal(compare.mock.callCount(), 1);
});

test('the right password still signs in', async () => {
  credentials.rows.push({
    id: 'https://app.test/credential/1',
    credentialOf: { id: WEBID },
    passwordHash: await bcrypt.hash('right-password', 10),
  });
  assert.equal(await provider.signinWithPassword(EMAIL, 'right-password'), SIGNED_IN);
});
