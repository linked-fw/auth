// signinDev (DEV_AUTH=true only) writes an email onto an account only when the verified access
// token carries one, never the email the client sent alongside it.
//
// Runs against the BUILT package in lib/ (build first: `npx linked build`). No store: the
// account lookup and update are stubbed, and the final sign-in step is stubbed.
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serving } from './serving.mjs';

process.env.NODE_ENV = 'test';
process.env.SITE_ROOT = 'https://app.test';
process.env.JWT_SECRET = 'unit-test-secret-unit-test-secret';
process.env.SESSION_SECRET = 'unit-test-session-secret';
process.env.DEV_AUTH = 'true';

// connect-sqlite3 (express-session store) writes into <cwd>/data
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-auth-test-'));
fs.mkdirSync(path.join(workDir, 'data'));
process.chdir(workDir);
process.on('exit', () => fs.rmSync(workDir, { recursive: true, force: true }));

const libDir = new URL('../lib/esm/', import.meta.url);
const { Auth } = await import(new URL('utils/auth.js', libDir));
const jwtUtils = await import(new URL('utils/jwt.js', libDir));
const { default: AuthBackendProvider } = await import(new URL('backend.js', libDir));

const WEBID = 'https://id.test/person/dev';
const fakeLincdServer = { callGenericBackendProvidersMethod: async () => {} };

let emailWrites;
let provider;

class TestProvider extends AuthBackendProvider {
  accountShape = {
    update: (data) => ({ for: async () => emailWrites.push(data.email) }),
  };
  async getOrCreateAccount() {
    return { id: 'https://app.test/account/dev', accountOf: { id: WEBID } };
  }
}

beforeEach(() => {
  emailWrites = [];
  mock.method(Auth, 'onSigninSuccessful', async () => ({ ok: true }));
  mock.method(console, 'warn', () => {});
  const request = { headers: {}, cookies: {}, res: { cookie() {}, clearCookie() {} } };
  provider = serving(new TestProvider(null, fakeLincdServer), request);
});

afterEach(() => mock.restoreAll());

async function accessToken(extraClaims = {}) {
  return jwtUtils.createAccessToken({
    user: { id: WEBID },
    userAccount: { id: 'https://app.test/account/dev' },
    ...extraClaims,
  });
}

test('the email claim of the verified token is stored on an account without one', async () => {
  const result = await provider.signinDev({
    webId: WEBID,
    accessToken: await accessToken({ email: 'dev@example.test' }),
    refreshToken: '',
    email: 'someone-else@example.test',
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(emailWrites, ['dev@example.test']);
});

test('a client-supplied email is not stored when the token has no email claim', async () => {
  const result = await provider.signinDev({
    webId: WEBID,
    accessToken: await accessToken(),
    refreshToken: '',
    email: 'victim@example.test',
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(emailWrites, [], `stored ${JSON.stringify(emailWrites)}`);
});

test('a verified token without a subject is refused, and nothing is written', async () => {
  const getOrCreateAccount = mock.method(TestProvider.prototype, 'getOrCreateAccount');
  const token = await jwtUtils.createAccessToken({
    userAccount: { id: 'https://app.test/account/dev' },
    email: 'dev@example.test',
  });
  const result = await provider.signinDev({ webId: WEBID, accessToken: token, refreshToken: '' });
  assert.deepEqual(result, { error: 'Invalid token' });
  assert.deepEqual(emailWrites, []);
  assert.equal(getOrCreateAccount.mock.callCount(), 0);
  assert.equal(Auth.onSigninSuccessful.mock.callCount(), 0);
});
