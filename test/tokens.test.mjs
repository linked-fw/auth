// Token kinds, stored refresh tokens and startup secrets.
//
// Runs against the BUILT package in lib/ (build first: `npx linked build`), with refresh token
// records in memory — no Fuseki needed. The same flows run against a real graph store in
// test/integration/ (`npm run test:integration`).
import { test, before, after, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { serving } from './serving.mjs';

const SITE_ROOT = 'https://app.test';
const SECRET = 'unit-test-secret-unit-test-secret';
process.env.NODE_ENV = 'test';
process.env.SITE_ROOT = SITE_ROOT;
process.env.JWT_SECRET = SECRET;
process.env.SESSION_SECRET = 'unit-test-session-secret';

// connect-sqlite3 (express-session store) writes into <cwd>/data
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-auth-test-'));
fs.mkdirSync(path.join(workDir, 'data'));
process.chdir(workDir);
process.on('exit', () => fs.rmSync(workDir, { recursive: true, force: true }));

const libDir = new URL('../lib/esm/', import.meta.url);
const { default: jwt } = await import('jsonwebtoken');
const { default: express } = await import('express');
const jwtUtils = await import(new URL('utils/jwt.js', libDir));
const { Auth } = await import(new URL('utils/auth.js', libDir));
const { default: AuthBackendProvider } = await import(new URL('backend.js', libDir));
const sessions = await import(new URL('utils/sessions.js', libDir)).catch(() => null);
const { AuthCredential } = await import(new URL('shapes/AuthCredential.js', libDir));

const PERSON = { id: 'https://id.test/person/ada' };
const ACCOUNT = { id: 'https://app.test/account/ada', email: 'ada@example.test', accountOf: PERSON };
const PAYLOAD = { user: PERSON, userAccount: ACCOUNT };

const fakeLincdServer = { callGenericBackendProvidersMethod: async () => {} };

/** The provider with the store lookups for the account/person replaced by fixtures. */
class TestProvider extends AuthBackendProvider {
  async loadAccountForSession(accountId) {
    return accountId === ACCOUNT.id ? { ...ACCOUNT } : null;
  }
  async loadUserForSession() {
    return { ...PERSON, givenName: 'Ada' };
  }
}

/** An express app the way LinkedServer hands it to providers (router already created). */
function newApp() {
  const app = express();
  app.lazyrouter();
  return app;
}

/**
 * These tests use the NATIVE token contract (refresh token in the response body), which is what
 * a client that registered setAuthTokenStorageMethods asks for with this header. The browser
 * contract (httpOnly cookies, no refresh token in the body) is tested in cookies.test.mjs.
 */
const BODY_TRANSPORT = { 'x-linked-auth-transport': 'body' };

function newProvider(request = { headers: { ...BODY_TRANSPORT }, cookies: {} }) {
  return serving(new TestProvider(null, fakeLincdServer), request);
}

function requestWith({ bearer, cookies = {} } = {}) {
  return {
    headers: { ...BODY_TRANSPORT, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    cookies,
  };
}

/** Sign in the way every sign-in method ends: Auth.onSigninSuccessful. */
async function signin() {
  const provider = newProvider();
  const result = await Auth.onSigninSuccessful(provider, { ...PERSON }, { ...ACCOUNT });
  assert.ok(result.accessToken, 'sign-in returns an access token');
  assert.ok(result.refreshToken, 'sign-in returns a refresh token');
  return result;
}

/** What the client does when its access token is gone: validateToken with the refresh token. */
async function refresh(refreshToken) {
  return newProvider(requestWith()).validateToken(refreshToken);
}

/** A token exactly as releases before token kinds signed them. */
function legacyToken(kind, { expiresIn = 3600 } = {}) {
  return jwt.sign({ ...PAYLOAD }, SECRET, {
    expiresIn,
    subject: PERSON.id,
    issuer: SITE_ROOT,
    ...(kind === 'access' ? { audience: SITE_ROOT } : {}),
  });
}

let memoryStore;
beforeEach(() => {
  if (sessions) {
    memoryStore = new sessions.MemoryRefreshSessionStore();
    sessions.setRefreshSessionStore(memoryStore);
  }
  jwtUtils.clearAccessTokenCache?.();
});
afterEach(() => mock.timers.reset());

// ---------------------------------------------------------------------------------------------
// The request middleware: which tokens authenticate a request
// ---------------------------------------------------------------------------------------------
let server;
let baseUrl;
before(async () => {
  const app = newApp();
  const provider = new TestProvider(app, fakeLincdServer);
  await provider.setupBeforeControllers();
  app.get('/whoami', (req, res) => {
    res.json({ account: req.linkedAuth?.userAccount?.id ?? null });
  });
  await new Promise((resolve) => {
    server = http.createServer(app).listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server?.close();
});

async function whoami({ bearer, cookie } = {}) {
  const headers = {};
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (cookie) headers.cookie = cookie;
  const res = await fetch(`${baseUrl}/whoami`, { headers });
  assert.equal(res.status, 200);
  return (await res.json()).account;
}

test('an access token as Bearer authenticates the request', async () => {
  const { accessToken } = await signin();
  assert.equal(await whoami({ bearer: accessToken }), ACCOUNT.id);
});

test('a refresh token as Bearer does NOT authenticate the request', async () => {
  const { refreshToken } = await signin();
  assert.equal(await whoami({ bearer: refreshToken }), null);
});

test('a legacy refresh token (JWT without aud) as Bearer does NOT authenticate the request', async () => {
  assert.equal(await whoami({ bearer: legacyToken('refresh') }), null);
});

test('a legacy refresh token in the accessToken cookie does NOT authenticate the request', async () => {
  assert.equal(
    await whoami({ cookie: `accessToken=${legacyToken('refresh')}` }),
    null
  );
});

test('a legacy access token (no typ, with aud) still authenticates the request', async () => {
  assert.equal(await whoami({ bearer: legacyToken('access') }), ACCOUNT.id);
});

test('an access token for another audience does not authenticate the request', async () => {
  const token = jwt.sign({ ...PAYLOAD, typ: 'access' }, SECRET, {
    expiresIn: 3600,
    audience: 'https://other.test',
  });
  assert.equal(await whoami({ bearer: token }), null);
});

test('verifyAccessToken: accepts access tokens, refuses refresh tokens', async () => {
  assert.equal(typeof jwtUtils.verifyAccessToken, 'function', 'verifyAccessToken is exported');
  const { accessToken, refreshToken } = await signin();
  const claims = jwtUtils.verifyAccessToken(accessToken);
  assert.equal(claims.typ, 'access');
  assert.equal(claims.aud, SITE_ROOT);
  assert.ok(claims.sid, 'access token carries the session id');
  assert.ok(claims.jti, 'access token carries a jti');
  assert.equal(claims.userAccount.id, ACCOUNT.id);
  assert.equal(jwtUtils.verifyAccessToken(refreshToken), false);
  assert.equal(jwtUtils.verifyAccessToken(legacyToken('refresh')), false);
  assert.ok(jwtUtils.verifyAccessToken(legacyToken('access')));
  const otherKind = jwt.sign({ ...PAYLOAD, typ: 'refresh' }, SECRET, {
    expiresIn: 3600,
    audience: SITE_ROOT,
  });
  assert.equal(jwtUtils.verifyAccessToken(otherKind), false);
});

// ---------------------------------------------------------------------------------------------
// Refresh: the validateToken RPC
// ---------------------------------------------------------------------------------------------
test('an access token is not accepted as a refresh token', async () => {
  const { accessToken } = await signin();
  const result = await refresh(accessToken);
  assert.ok(result.error, 'refused');
  assert.equal(result.accessToken, undefined);
});

test('a legacy refresh token (never stored) is refused', async () => {
  const result = await refresh(legacyToken('refresh'));
  assert.ok(result.error, 'refused');
});

test('a stored refresh token returns new tokens and is rotated', async () => {
  const first = await signin();
  const result = await refresh(first.refreshToken);
  assert.equal(result.error, undefined, `refresh failed: ${result.error}`);
  assert.ok(result.accessToken);
  assert.ok(result.refreshToken);
  assert.notEqual(result.refreshToken, first.refreshToken, 'a new refresh token');
  assert.equal(result.auth.userAccount.id, ACCOUNT.id);
  assert.equal(result.auth.user.givenName, 'Ada', 'the person is reloaded');

  const claims = jwtUtils.verifyAccessToken(result.accessToken);
  assert.ok(claims, 'the new access token is valid');
  assert.equal(
    claims.sid,
    jwtUtils.verifyAccessToken(first.accessToken).sid,
    'same session'
  );
  // the request is authenticated with the new token
  assert.equal(await whoami({ bearer: result.accessToken }), ACCOUNT.id);
  // and the new refresh token works in turn
  const again = await refresh(result.refreshToken);
  assert.equal(again.error, undefined);
});

test('an expired access token plus a refresh token refreshes (the client contract)', async () => {
  const first = await signin();
  const expiredAccess = jwt.sign(
    { ...PAYLOAD, typ: 'access', exp: Math.floor(Date.now() / 1000) - 10 },
    SECRET,
    { audience: SITE_ROOT }
  );
  const result = await newProvider(requestWith({ bearer: expiredAccess })).validateToken(
    first.refreshToken
  );
  assert.equal(result.error, undefined, `refresh failed: ${result.error}`);
  assert.ok(jwtUtils.verifyAccessToken(result.accessToken));
});

test('a rotated refresh token is rejected, and reusing it revokes the session', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const first = await signin();
  const second = await refresh(first.refreshToken);
  assert.equal(second.error, undefined, `refresh failed: ${second.error}`);

  mock.timers.tick(31_000); // past the concurrent-tab grace window
  const reuse = await refresh(first.refreshToken);
  assert.ok(reuse.error, 'the replaced token is refused');

  // the reuse ended the session: the token that replaced it is dead too
  const afterReuse = await refresh(second.refreshToken);
  assert.ok(afterReuse.error, 'the whole session is revoked after reuse');
});

test('a lost refresh response does not kill the session: reuse within the grace window gets a fresh token', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const a = await signin();
  const b = await refresh(a.refreshToken); // A -> B
  assert.equal(b.error, undefined);
  const c = await refresh(b.refreshToken); // B -> C, but the response is lost
  assert.equal(c.error, undefined);

  mock.timers.tick(5_000);
  const retry = await refresh(b.refreshToken); // the client still holds B
  assert.equal(retry.error, undefined, 'not signed out');
  assert.ok(jwtUtils.verifyAccessToken(retry.accessToken));
  assert.ok(retry.refreshToken, 'a fresh refresh token replaces the one the client lost');
  assert.notEqual(retry.refreshToken, c.refreshToken);
  assert.ok(retry.refreshTokenExpiresIn > 0);

  // 40 s later the client refreshes with what it holds now: the session is alive
  mock.timers.tick(40_000);
  const d = await refresh(retry.refreshToken);
  assert.equal(d.error, undefined, `the fresh token works after the grace window: ${d.error}`);
  const fromC = await refresh(c.refreshToken);
  assert.equal(fromC.error, undefined, 'the lost token C is not revoked either');

  // presenting B after the grace window is still reuse, and ends the session
  const late = await refresh(b.refreshToken);
  assert.ok(late.error, 'reuse after the grace window is refused');
  assert.ok((await refresh(d.refreshToken)).error, 'and revokes the session');
});

test('an expired refresh token is refused', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const first = await signin();
  mock.timers.tick(61 * 24 * 60 * 60 * 1000); // longer than any default refresh lifetime
  const result = await refresh(first.refreshToken);
  assert.ok(result.error, 'refused');
});

test('signout revokes the session: its refresh token fails afterwards, other sessions survive', async () => {
  const deviceA = await signin();
  const deviceB = await signin();

  // signed in on device A, the way the request middleware sets it up
  const request = requestWith({ bearer: deviceA.accessToken });
  const provider = newProvider(request);
  await provider.validateRequestToken(request);
  assert.equal(await provider.signout(), true);

  const refreshA = await refresh(deviceA.refreshToken);
  assert.ok(refreshA.error, 'device A cannot refresh after signing out');
  const refreshB = await refresh(deviceB.refreshToken);
  assert.equal(refreshB.error, undefined, 'device B is still signed in');
});

test('signout with only the refresh token (expired access token) revokes that session', async () => {
  const device = await signin();
  const provider = newProvider(requestWith());
  assert.equal(await provider.signout(device.refreshToken), true);
  assert.ok((await refresh(device.refreshToken)).error);
});

test('revoking all sessions of an account (password reset) ends every session', async () => {
  assert.ok(sessions, 'utils/sessions is exported');
  const deviceA = await signin();
  const deviceB = await signin();
  const revoked = await sessions.revokeAllSessionsForAccount(ACCOUNT.id);
  assert.equal(revoked, 2);
  assert.ok((await refresh(deviceA.refreshToken)).error);
  assert.ok((await refresh(deviceB.refreshToken)).error);
});

test('only a hash of the refresh token is stored', async () => {
  const { refreshToken } = await signin();
  const records = [...memoryStore.records.values()];
  assert.equal(records.length, 1);
  assert.equal(records[0].tokenHash, sessions.hashRefreshToken(refreshToken));
  assert.ok(!JSON.stringify(records).includes(refreshToken), 'the raw token is not stored');
  assert.match(refreshToken, /^[A-Za-z0-9_-]{43}$/, '32 random bytes, base64url');
});

test('updateSessionData keeps the session and the client refresh token', async () => {
  const first = await signin();
  const request = requestWith({
    bearer: first.accessToken,
    cookies: { refreshToken: first.refreshToken },
  });
  const provider = newProvider(request);
  await provider.validateRequestToken(request);
  const updated = await request.linkedAuth.updateSessionData({
    user: { givenName: 'Ada L.' },
  });
  const claims = jwtUtils.verifyAccessToken(updated.accessToken);
  assert.ok(claims, 'a valid access token');
  assert.equal(claims.user.givenName, 'Ada L.');
  assert.equal(claims.sid, jwtUtils.verifyAccessToken(first.accessToken).sid);
  assert.equal(updated.refreshToken, first.refreshToken);
  assert.equal((await refresh(first.refreshToken)).error, undefined, 'still refreshable');
});

// ---------------------------------------------------------------------------------------------
// emailVerified in the session
// ---------------------------------------------------------------------------------------------
/** Make the person's credentials, as `AuthCredential.select(...).where(...)` returns them. */
function credentialsAre(t, rowsOrError) {
  t.mock.method(AuthCredential, 'select', () => ({
    where: () =>
      rowsOrError instanceof Error ? Promise.reject(rowsOrError) : Promise.resolve(rowsOrError),
  }));
}

test('buildAuthSession reports emailVerified from the credentials', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const provider = newProvider();
  credentialsAre(t, [{ id: 'c1' }, { id: 'c2', emailVerifiedAt: new Date().toISOString() }]);
  assert.equal((await Auth.buildAuthSession(provider, PERSON, ACCOUNT)).emailVerified, true);
  credentialsAre(t, [{ id: 'c1' }]);
  assert.equal((await Auth.buildAuthSession(provider, PERSON, ACCOUNT)).emailVerified, false);
  credentialsAre(t, new Error('store down'));
  assert.equal((await Auth.buildAuthSession(provider, PERSON, ACCOUNT)).emailVerified, false);
});

test('emailVerified reaches the access token, and updateSessionData keeps it', async (t) => {
  credentialsAre(t, [{ id: 'c1', emailVerifiedAt: new Date().toISOString() }]);
  const first = await signin();
  assert.equal(first.auth.emailVerified, true);
  assert.equal(jwtUtils.verifyAccessToken(first.accessToken).emailVerified, true);

  const request = requestWith({ bearer: first.accessToken });
  await newProvider(request).validateRequestToken(request);
  assert.equal(request.linkedAuth.emailVerified, true);
  const updated = await request.linkedAuth.updateSessionData({ user: { givenName: 'Ada L.' } });
  assert.equal(updated.auth.emailVerified, true);
  assert.equal(jwtUtils.verifyAccessToken(updated.accessToken).emailVerified, true);
  assert.equal(request.linkedAuth.emailVerified, true);
});

test('a refresh reads emailVerified again from the store', async (t) => {
  credentialsAre(t, []);
  const first = await signin();
  assert.equal(first.auth.emailVerified, false);
  credentialsAre(t, [{ id: 'c1', emailVerifiedAt: new Date().toISOString() }]);
  const refreshed = await refresh(first.refreshToken);
  assert.equal(refreshed.auth.emailVerified, true);
  assert.equal(jwtUtils.verifyAccessToken(refreshed.accessToken).emailVerified, true);
});

// ---------------------------------------------------------------------------------------------
// Verification cache
// ---------------------------------------------------------------------------------------------
test('the verification cache does not serve an expired token', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const token = jwt.sign({ ...PAYLOAD, typ: 'access' }, SECRET, {
    expiresIn: 2,
    audience: SITE_ROOT,
  });
  const provider = newProvider();
  const args = { request: provider.request, token, provider };
  assert.ok(await jwtUtils.verifyToken(args), 'valid while fresh (and now cached)');
  mock.timers.tick(3_000);
  assert.equal(await jwtUtils.verifyToken(args), false, 'expired, even though it was cached');
});

// ---------------------------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------------------------
async function setupWithEnv(env) {
  const saved = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  try {
    const provider = new TestProvider(newApp(), fakeLincdServer);
    await provider.setupBeforeControllers();
    await provider.dispose();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('startup throws a fatal error in production when JWT_SECRET is missing', async () => {
  await assert.rejects(
    setupWithEnv({ NODE_ENV: 'production', JWT_SECRET: undefined }),
    (err) => {
      assert.match(err.message, /JWT_SECRET/);
      // @_linked/server aborts startup on `fatal: true` instead of serving with broken auth
      assert.equal(err.fatal, true, 'the error is marked fatal');
      return true;
    }
  );
});

test('startup throws a fatal error in production when SESSION_SECRET is missing', async () => {
  await assert.rejects(
    setupWithEnv({ NODE_ENV: 'production', SESSION_SECRET: undefined }),
    (err) => {
      assert.match(err.message, /SESSION_SECRET/);
      assert.equal(err.fatal, true, 'the error is marked fatal');
      return true;
    }
  );
});

test('startup works in production when both secrets are set', async () => {
  await setupWithEnv({ NODE_ENV: 'production' });
});

test('development keeps working without secrets', async () => {
  await setupWithEnv({
    NODE_ENV: 'development',
    JWT_SECRET: undefined,
    SESSION_SECRET: undefined,
  });
});

// ---------------------------------------------------------------------------------------------
// Refresh token expiry: the server tells the client how long its record lives
// ---------------------------------------------------------------------------------------------
const tokenUtils = await import(new URL('utils/token.js', libDir));

function storedExpiry(refreshToken) {
  const record = memoryStore.records.get(sessions.hashRefreshToken(refreshToken));
  assert.ok(record, 'the refresh token is stored');
  return record.expiresAt;
}

function assertExpiryFields(result, refreshToken, label) {
  const expiresAt = storedExpiry(refreshToken);
  assert.equal(result.refreshTokenExpiresAt, expiresAt.toISOString(), `${label}: expiresAt`);
  const expectedIn = Math.floor((expiresAt.getTime() - Date.now()) / 1000);
  assert.ok(
    Math.abs(result.refreshTokenExpiresIn - expectedIn) <= 2,
    `${label}: expiresIn ${result.refreshTokenExpiresIn} ~ ${expectedIn}`
  );
}

test('sign-in returns when the refresh token expires', async () => {
  const result = await signin();
  assertExpiryFields(result, result.refreshToken, 'sign-in');
  // the earliest of the refresh lifetime, the idle timeout and the absolute session lifetime
  const { refreshTtl, idleTtl, maxTtl } = sessions.getSessionLimits();
  const expected = Math.min(refreshTtl, idleTtl || Infinity, maxTtl || Infinity);
  assert.ok(
    Math.abs(result.refreshTokenExpiresIn - expected) <= 2,
    `the refresh lifetime capped by the session limits (${result.refreshTokenExpiresIn} ~ ${expected})`
  );
});

test('a refresh returns the expiry of the new refresh token', async () => {
  const first = await signin();
  const result = await refresh(first.refreshToken);
  assert.equal(result.error, undefined);
  assertExpiryFields(result, result.refreshToken, 'refresh');
});

test('validateToken with a valid access token returns the expiry of the echoed refresh token', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const first = await signin();
  mock.timers.tick(60_000);
  const result = await newProvider(requestWith({ bearer: first.accessToken })).validateToken(
    first.refreshToken
  );
  assert.equal(result.error, undefined);
  assert.equal(result.refreshToken, first.refreshToken);
  assertExpiryFields(result, first.refreshToken, 'validate');
  assert.ok(result.refreshTokenExpiresIn <= first.refreshTokenExpiresIn - 59, 'counts down');
});

test('validateToken does not vouch for an unknown refresh token', async () => {
  const first = await signin();
  const result = await newProvider(requestWith({ bearer: first.accessToken })).validateToken(
    legacyToken('refresh')
  );
  assert.equal(result.error, undefined);
  assert.equal(result.refreshTokenExpiresIn, undefined);
  assert.equal(result.refreshTokenExpiresAt, undefined);
});

/** Token storage that records what the client would write. */
function memoryTokenStorage() {
  const values = new Map();
  const writes = [];
  tokenUtils.setAuthTokenStorageMethods(
    async (key) => values.get(key),
    async (key, value, expires) => {
      values.set(key, value);
      writes.push({ key, value, expires });
    },
    async (key) => values.delete(key)
  );
  return { values, writes };
}

test('client: cookie lifetimes come from the server (access: JWT exp, refresh: returned expiry)', async () => {
  const { writes } = memoryTokenStorage();
  const accessToken = jwt.sign({ typ: 'access' }, SECRET, { expiresIn: 600 });
  await tokenUtils.storeAuthTokens({
    accessToken,
    refreshToken: 'opaque-refresh',
    refreshTokenExpiresIn: 3600,
    refreshTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  const access = writes.find((w) => w.key === tokenUtils.ACCESS_TOKEN);
  const refreshWrite = writes.find((w) => w.key === tokenUtils.REFRESH_TOKEN);
  assert.ok(access.expires >= 598 && access.expires <= 600, `access ${access.expires}`);
  assert.equal(refreshWrite.expires, 3600, 'refresh cookie lives as long as the server record');
});

test('client: refreshTokenExpiresAt alone sizes the refresh cookie', async () => {
  const { writes } = memoryTokenStorage();
  await tokenUtils.storeAuthTokens({
    refreshToken: 'opaque-refresh',
    refreshTokenExpiresAt: new Date(Date.now() + 7200_000).toISOString(),
  });
  const w = writes.find((x) => x.key === tokenUtils.REFRESH_TOKEN);
  assert.ok(w.expires >= 7198 && w.expires <= 7200, `refresh ${w.expires}`);
});

test('client: an older server (no expiry) gets the defaults, and an unchanged refresh token is not extended', async () => {
  const { values, writes } = memoryTokenStorage();
  await tokenUtils.storeAuthTokens({ refreshToken: 'first' });
  assert.deepEqual(writes, [
    { key: tokenUtils.REFRESH_TOKEN, value: 'first', expires: tokenUtils.REFRESH_TOKEN_EXPIRES },
  ]);
  await tokenUtils.storeAuthTokens({ refreshToken: 'first' });
  assert.equal(writes.length, 1, 'the same token echoed back is left alone');
  assert.equal(values.get(tokenUtils.REFRESH_TOKEN), 'first');
});

test('the server-provided expiry reaches the client end to end', async () => {
  const { writes } = memoryTokenStorage();
  const result = await signin();
  await tokenUtils.storeAuthTokens(result);
  const w = writes.find((x) => x.key === tokenUtils.REFRESH_TOKEN);
  assert.ok(Math.abs(w.expires - result.refreshTokenExpiresIn) <= 1);
});

// ---------------------------------------------------------------------------------------------
// Logging of rejected access tokens
// ---------------------------------------------------------------------------------------------
test('an opaque refresh token presented as an access token is not logged', async () => {
  const { refreshToken } = await signin();
  const warn = mock.method(console, 'warn', () => {});
  try {
    assert.equal(jwtUtils.verifyAccessToken(refreshToken), false);
    assert.equal(await whoami({ bearer: refreshToken }), null);
    assert.equal(warn.mock.callCount(), 0, 'no log line for a non-JWT');
  } finally {
    warn.mock.restore();
  }
});

test('a suspicious token (bad signature) is logged once, not on every request', async () => {
  const forged = jwt.sign({ ...PAYLOAD, typ: 'access' }, 'not-the-secret', {
    audience: SITE_ROOT,
    expiresIn: 600,
  });
  const notAccess = jwt.sign({ ...PAYLOAD, typ: 'other' }, SECRET, {
    audience: SITE_ROOT,
    expiresIn: 600,
  });
  const warn = mock.method(console, 'warn', () => {});
  try {
    for (let i = 0; i < 3; i++) {
      assert.equal(jwtUtils.verifyAccessToken(forged), false);
      assert.equal(jwtUtils.verifyAccessToken(notAccess), false);
    }
    const lines = warn.mock.calls.map((c) => String(c.arguments[0]));
    assert.equal(lines.length, 2, lines.join('\n'));
    assert.match(lines[0], /invalid signature/);
    assert.match(lines[1], /not an access token/);
  } finally {
    warn.mock.restore();
  }
});
