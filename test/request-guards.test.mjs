// Calls outside an HTTP request: Auth.setAuthentication and checkSignin must not read or write
// `request.linkedAuth` when there is no request.
//
// Runs against the BUILT package in lib/ (build first: `npx linked build`).
import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
const { verifyAccessToken } = await import(new URL('utils/jwt.js', libDir));
const sessions = await import(new URL('utils/sessions.js', libDir));
const { default: AuthBackendProvider } = await import(new URL('backend.js', libDir));

const AUTH = {
  user: { id: 'https://app.test/person/ada', givenName: 'Ada' },
  userAccount: { id: 'https://app.test/account/ada' },
  sid: 'session-1',
};

afterEach(() => mock.restoreAll());

test('setAuthentication without a request returns the session and does not throw', () => {
  const linkedAuth = Auth.setAuthentication(undefined, AUTH);
  assert.equal(linkedAuth.user, AUTH.user);
  assert.equal(linkedAuth.userAccount, AUTH.userAccount);
  assert.equal(linkedAuth.sid, AUTH.sid);
  assert.equal(typeof linkedAuth.updateSessionData, 'function');
});

test('updateSessionData without a request updates the returned session', async () => {
  sessions.setRefreshSessionStore(new sessions.MemoryRefreshSessionStore());
  const linkedAuth = Auth.setAuthentication(undefined, AUTH);
  const result = await linkedAuth.updateSessionData({ user: { givenName: 'Augusta' } });
  assert.equal(result.auth.user.givenName, 'Augusta');
  assert.equal(result.auth.user.id, AUTH.user.id);
  assert.equal(result.auth.userAccount.id, AUTH.userAccount.id);
  const claims = await verifyAccessToken(result.accessToken);
  assert.equal(claims?.sid, AUTH.sid);
});

test('checkSignin outside a request returns undefined', () => {
  const provider = new AuthBackendProvider(null, { callGenericBackendProvidersMethod: async () => {} });
  assert.equal(provider.checkSignin(), undefined);
});
