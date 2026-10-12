// Stored refresh tokens against a REAL graph store: the RefreshToken shape queries, end to end
// through the provider's RPC methods (createAccount, signinWithPassword, validateToken, signout,
// resetPassword, removeAccount).
//
// Needs a Fuseki server. Creates a throwaway dataset and drops it afterwards; no other dataset is
// read or written.
//
//   AUTH_TEST_FUSEKI_URL=http://localhost:3030 AUTH_TEST_FUSEKI_USER=admin \
//   AUTH_TEST_FUSEKI_PASSWORD=... npm run test:integration
//
// Runs against the BUILT package in lib/ (build first).
import { test, before, after, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { serving } from '../serving.mjs';

const FUSEKI = process.env.AUTH_TEST_FUSEKI_URL?.replace(/\/+$/, '');
const USER = process.env.AUTH_TEST_FUSEKI_USER;
const PASSWORD = process.env.AUTH_TEST_FUSEKI_PASSWORD;
if (!FUSEKI || !USER || !PASSWORD) {
  // Fail loudly: a suite that silently skips proves nothing.
  throw new Error(
    'Set AUTH_TEST_FUSEKI_URL, AUTH_TEST_FUSEKI_USER and AUTH_TEST_FUSEKI_PASSWORD to run the integration tests'
  );
}

const SITE_ROOT = 'https://app.test';
const SECRET = 'integration-test-secret-integration';
process.env.NODE_ENV = 'test';
process.env.SITE_ROOT = SITE_ROOT;
process.env.JWT_SECRET = SECRET;
process.env.SESSION_SECRET = 'integration-test-session-secret';
process.env.AUTH_SESSION_CLEANUP = 'false';

const DATASET = `linked-auth-test-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const authHeader = 'Basic ' + Buffer.from(`${USER}:${PASSWORD}`).toString('base64');

const libDir = new URL('../../lib/esm/', import.meta.url);
const { default: jwt } = await import('jsonwebtoken');
const { FusekiStore } = await import('@_linked/fuseki/shapes/FusekiStore');
const { LinkedStorage } = await import('@_linked/core/utils/LinkedStorage');
await import(new URL('shapes/index.js', libDir));
const sessions = await import(new URL('utils/sessions.js', libDir));
const { default: AuthBackendProvider } = await import(new URL('backend.js', libDir));
const { AuthCredential } = await import(new URL('shapes/AuthCredential.js', libDir));
const { resetRateLimits } = await import(new URL('utils/rateLimit.js', libDir));
const { default: bcrypt } = await import('bcrypt');

const fakeLincdServer = { callGenericBackendProvidersMethod: async () => {} };

async function sparql(query) {
  const res = await fetch(`${FUSEKI}/${DATASET}/sparql`, {
    method: 'POST',
    headers: {
      authorization: authHeader,
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/sparql-results+json',
    },
    body: new URLSearchParams({ query }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  return (await res.json()).results.bindings;
}

// every test signs in to the same account; each starts with a fresh limit budget
beforeEach(() => resetRateLimits());

before(async () => {
  const res = await fetch(`${FUSEKI}/$/datasets`, {
    method: 'POST',
    headers: { authorization: authHeader, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ dbName: DATASET, dbType: 'mem' }),
  });
  assert.equal(res.status, 200, `could not create test dataset: ${await res.text()}`);
  LinkedStorage.setDefaultDataset(
    new FusekiStore({
      endpoint: `${FUSEKI}/${DATASET}`,
      credentials: { username: USER, password: PASSWORD },
    })
  );
});

after(async () => {
  const res = await fetch(`${FUSEKI}/$/datasets/${DATASET}`, {
    method: 'DELETE',
    headers: { authorization: authHeader },
  });
  assert.equal(res.status, 200, `could not drop test dataset ${DATASET}`);
});

afterEach(() => mock.timers.reset());

/**
 * A provider handling one request. By default the request asks for the NATIVE token contract
 * (refresh token in the body), which these flows were written against; `web: true` leaves the
 * header off, so the refresh token only travels as an httpOnly cookie.
 */
function provider(request = { headers: {}, cookies: {} }) {
  if (!request.web) {
    request.headers = { 'x-linked-auth-transport': 'body', ...request.headers };
  }
  return serving(new AuthBackendProvider(null, fakeLincdServer), request);
}

/** An access token for the same claims that has already expired. */
function expiredCopyOf(accessToken) {
  const { exp, iat, nbf, aud, iss, sub, jti, ...claims } = jwt.decode(accessToken);
  return jwt.sign({ ...claims, exp: Math.floor(Date.now() / 1000) - 60 }, SECRET, {
    audience: SITE_ROOT,
  });
}

/**
 * What the client does when its access token has expired: validateToken with the refresh token,
 * the expired access token still in the Authorization header.
 */
async function refresh(tokens, refreshToken = tokens.refreshToken) {
  const request = {
    headers: { authorization: `Bearer ${expiredCopyOf(tokens.accessToken)}` },
    cookies: {},
  };
  return provider(request).validateToken(refreshToken);
}

/** A request authenticated by the middleware with this access token. */
async function signedInProvider(accessToken) {
  const request = { headers: { authorization: `Bearer ${accessToken}` }, cookies: {} };
  const p = provider(request);
  assert.ok(await p.validateRequestToken(request), 'access token accepted');
  return p;
}

const PASSWORD_1 = 'first-Passw0rd!';
const PASSWORD_2 = 'second-Passw0rd!';
let email;
let created;

test('createAccount stores a refresh token that refreshes and rotates', async () => {
  email = `ada-${crypto.randomBytes(4).toString('hex')}@example.test`;
  created = await provider().createAccount({
    firstName: 'Ada',
    lastName: 'Lovelace',
    email,
    password: PASSWORD_1,
  });
  assert.equal(created.error, undefined, created.error);

  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const refreshed = await refresh(created);
  assert.equal(refreshed.error, undefined, `refresh failed: ${refreshed.error}`);
  assert.ok(refreshed.accessToken);
  assert.ok(refreshed.refreshToken);
  assert.notEqual(refreshed.refreshToken, created.refreshToken);
  assert.equal(refreshed.auth.userAccount.email, email, 'account reloaded from the store');
  assert.equal(refreshed.auth.user.givenName, 'Ada', 'person reloaded from the store');

  mock.timers.tick(31_000);
  const reuse = await refresh(created, created.refreshToken);
  assert.ok(reuse.error, 'the replaced token is refused');
  const afterReuse = await refresh(refreshed, refreshed.refreshToken);
  assert.ok(afterReuse.error, 'reuse revoked the whole session');
});

test('the store holds a hash with dated metadata, never the raw token', async () => {
  const signin = await provider().signinWithPassword(email, PASSWORD_1);
  assert.equal(signin.error, undefined, signin.error);
  const hash = crypto.createHash('sha256').update(signin.refreshToken).digest('base64url');
  const rows = await sparql(`
    PREFIX auth: <https://linked.cm/ont/auth/>
    SELECT ?p ?o WHERE {
      { GRAPH ?g { ?s auth:tokenHash "${hash}" ; ?p ?o } }
      UNION { ?s auth:tokenHash "${hash}" ; ?p ?o }
    }`);
  const byPredicate = Object.fromEntries(rows.map((r) => [r.p.value.split('/').pop(), r.o]));
  assert.ok(byPredicate.sessionId, 'sessionId stored');
  assert.ok(byPredicate.account, 'account stored');
  for (const p of ['createdAt', 'expiresAt', 'lastUsedAt']) {
    assert.equal(
      byPredicate[p]?.datatype,
      'http://www.w3.org/2001/XMLSchema#dateTime',
      `${p} stored as xsd:dateTime`
    );
  }
  const raw = await sparql(`SELECT ?s WHERE { { ?s ?p "${signin.refreshToken}" } UNION { GRAPH ?g { ?s ?p "${signin.refreshToken}" } } }`);
  assert.equal(raw.length, 0, 'the raw refresh token is not stored');
});

test('sign-in and validateToken report the stored refresh token expiry', async () => {
  const signin = await provider().signinWithPassword(email, PASSWORD_1);
  assert.equal(signin.error, undefined, signin.error);
  const hash = crypto.createHash('sha256').update(signin.refreshToken).digest('base64url');
  const rows = await sparql(`
    PREFIX auth: <https://linked.cm/ont/auth/>
    SELECT ?o WHERE {
      { GRAPH ?g { ?s auth:tokenHash "${hash}" ; auth:expiresAt ?o } }
      UNION { ?s auth:tokenHash "${hash}" ; auth:expiresAt ?o }
    }`);
  assert.equal(rows.length, 1, 'one stored expiry');
  const storedMs = Date.parse(rows[0].o.value);
  assert.ok(Math.abs(Date.parse(signin.refreshTokenExpiresAt) - storedMs) < 1000, 'sign-in');
  assert.ok(signin.refreshTokenExpiresIn > 0);

  // the client echoes its refresh token while the access token is still valid
  const request = {
    headers: { authorization: `Bearer ${signin.accessToken}` },
    cookies: {},
  };
  const validated = await provider(request).validateToken(signin.refreshToken);
  assert.equal(validated.error, undefined, validated.error);
  assert.equal(validated.refreshToken, signin.refreshToken);
  assert.ok(
    Math.abs(Date.parse(validated.refreshTokenExpiresAt) - storedMs) < 1000,
    'looked up from the store'
  );
});

test('signout revokes that session only', async () => {
  const deviceA = await provider().signinWithPassword(email, PASSWORD_1);
  const deviceB = await provider().signinWithPassword(email, PASSWORD_1);
  assert.equal(deviceA.error, undefined);

  const p = await signedInProvider(deviceA.accessToken);
  assert.equal(await p.signout(), true);

  assert.ok((await refresh(deviceA)).error, 'device A cannot refresh after signout');
  const b = await refresh(deviceB);
  assert.equal(b.error, undefined, `device B still signed in: ${b.error}`);
});

test('resetPassword revokes every session of the account', async () => {
  const deviceA = await provider().signinWithPassword(email, PASSWORD_1);
  const deviceB = await provider().signinWithPassword(email, PASSWORD_1);

  const p = await signedInProvider(deviceA.accessToken);
  const withoutCurrent = await p.resetPassword(PASSWORD_2, PASSWORD_2, undefined);
  assert.ok(withoutCurrent.error, 'a change without the current password was accepted');
  const reset = await p.resetPassword(PASSWORD_2, PASSWORD_2, undefined, PASSWORD_1);
  assert.equal(reset.error, undefined, reset.error);

  assert.ok((await refresh(deviceA)).error, 'device A revoked');
  assert.ok((await refresh(deviceB)).error, 'device B revoked');
  const current = await refresh(reset);
  assert.equal(current.error, undefined, 'the session started by the reset works');
  const withNewPassword = await provider().signinWithPassword(email, PASSWORD_2);
  assert.equal(withNewPassword.error, undefined);
});

test('sign-in upgrades a cost-4 password hash to cost 10, writing only the hash', async () => {
  const stored = async () =>
    sparql(`
      PREFIX auth: <https://linked.cm/ont/auth/>
      SELECT ?s ?hash ?of WHERE {
        { GRAPH ?g { ?s auth:passwordHash ?hash . OPTIONAL { ?s auth:credentialOf ?of } } }
        UNION { ?s auth:passwordHash ?hash . OPTIONAL { ?s auth:credentialOf ?of } }
      }`);
  const [before] = await stored();
  assert.equal(bcrypt.getRounds(before.hash.value), 10, 'createAccount / resetPassword hash at 10');
  // what releases before 3.0.4 stored
  await AuthCredential.update({ passwordHash: await bcrypt.hash(PASSWORD_2, 4) }).for({
    id: before.s.value,
  });
  assert.equal(bcrypt.getRounds((await stored())[0].hash.value), 4);

  const failed = await provider().signinWithPassword(email, PASSWORD_1);
  assert.ok(failed.error);
  assert.equal(bcrypt.getRounds((await stored())[0].hash.value), 4, 'a failed sign-in re-hashed');

  const signin = await provider().signinWithPassword(email, PASSWORD_2);
  assert.equal(signin.error, undefined, signin.error);
  const after = await stored();
  assert.equal(after.length, 1, 'one password hash');
  assert.equal(after[0].s.value, before.s.value);
  assert.equal(after[0].of?.value, before.of?.value, 'credentialOf kept');
  assert.equal(bcrypt.getRounds(after[0].hash.value), 10);
  assert.equal((await provider().signinWithPassword(email, PASSWORD_2)).error, undefined);
});

test('a reset link stores only a hash with an expiry, and works once', async () => {
  const { LinkedEmail } = await import('@_linked/server-utils/utils/LinkedEmail');
  const sent = [];
  const send = mock.method(LinkedEmail, 'send', async (options) => {
    sent.push(options);
  });
  try {
    assert.equal(await provider().sendResetPasswordLink(email), true);
  } finally {
    send.mock.restore();
  }
  const token = sent[0].htmlbody.match(/reset-password\?token=([^'"&\s]+)/)[1];
  const hash = crypto.createHash('sha256').update(token).digest('base64url');
  const stored = async () =>
    sparql(`
      PREFIX auth: <https://linked.cm/ont/auth/>
      SELECT ?token ?expires WHERE {
        { GRAPH ?g { ?s auth:forgotPasswordToken ?token . OPTIONAL { ?s auth:forgotPasswordTokenExpiresAt ?expires } } }
        UNION { ?s auth:forgotPasswordToken ?token . OPTIONAL { ?s auth:forgotPasswordTokenExpiresAt ?expires } }
      }`);
  const rows = await stored();
  assert.equal(rows.length, 1, 'one outstanding reset token');
  assert.equal(rows[0].token.value, hash, 'the hash is stored, not the raw token');
  assert.equal(rows[0].expires?.datatype, 'http://www.w3.org/2001/XMLSchema#dateTime');
  const expiresInMs = Date.parse(rows[0].expires.value) - Date.now();
  assert.ok(expiresInMs > 59 * 60 * 1000 && expiresInMs <= 60 * 60 * 1000, `expires in ${expiresInMs}ms`);

  const reset = await provider().resetPassword(PASSWORD_2, PASSWORD_2, token);
  assert.equal(reset.error, undefined, reset.error);
  assert.equal((await stored()).length, 0, 'the token is removed once used');
  const again = await provider().resetPassword(PASSWORD_1, PASSWORD_1, token);
  assert.ok(again.error, 'the token does not work twice');
  const signin = await provider().signinWithPassword(email, PASSWORD_2);
  assert.equal(signin.error, undefined, 'the password from the first use stands');
});

test('two concurrent resets with one link: exactly one succeeds, and no consume marker is left', async () => {
  const { LinkedEmail } = await import('@_linked/server-utils/utils/LinkedEmail');
  const sent = [];
  const send = mock.method(LinkedEmail, 'send', async (options) => {
    sent.push(options);
  });
  try {
    assert.equal(await provider().sendResetPasswordLink(email), true);
  } finally {
    send.mock.restore();
  }
  const token = sent[0].htmlbody.match(/reset-password\?token=([^'"&\s]+)/)[1];

  // both set the same password, so the account ends up the same whichever one wins
  const results = await Promise.all(
    [1, 2, 3].map(() => provider().resetPassword(PASSWORD_2, PASSWORD_2, token))
  );
  const succeeded = results.filter((result) => !result?.error);
  assert.equal(succeeded.length, 1, `expected one success: ${JSON.stringify(results.map((r) => r?.error ?? 'ok'))}`);

  const left = await sparql(`
    PREFIX auth: <https://linked.cm/ont/auth/>
    SELECT ?s WHERE {
      { ?s auth:consumeMarker ?m } UNION { GRAPH ?g { ?s auth:consumeMarker ?m } }
      UNION { ?s auth:forgotPasswordToken ?t } UNION { GRAPH ?g { ?s auth:forgotPasswordToken ?t } }
    }`);
  assert.equal(left.length, 0, 'no consume marker and no token left');
  assert.equal((await provider().signinWithPassword(email, PASSWORD_2)).error, undefined);
});

test('removeAccount deletes the account\'s refresh token records', async () => {
  const signin = await provider().signinWithPassword(email, PASSWORD_2);
  const accountId = signin.auth.userAccount.id;
  const countFor = async () =>
    (
      await sparql(`
        PREFIX auth: <https://linked.cm/ont/auth/>
        SELECT ?s WHERE { { ?s auth:account <${accountId}> } UNION { GRAPH ?g { ?s auth:account <${accountId}> } } }`)
    ).length;
  assert.ok((await countFor()) > 0, 'records exist before removal');

  const p = await signedInProvider(signin.accessToken);
  assert.equal(await p.removeAccount(), true);
  assert.equal(await countFor(), 0, 'no records left for the removed account');
  assert.ok((await refresh(signin)).error, 'refresh fails for a removed account');
});

test('the RefreshToken shape refuses a record without its required fields', async () => {
  const { RefreshToken } = await import(new URL('shapes/RefreshToken.js', libDir));
  await assert.rejects(
    async () => RefreshToken.create({ sessionId: 'incomplete', createdAt: new Date() }),
    /tokenHash/
  );
  const rows = await sparql(`
    PREFIX auth: <https://linked.cm/ont/auth/>
    SELECT ?s WHERE { { ?s auth:sessionId "incomplete" } UNION { GRAPH ?g { ?s auth:sessionId "incomplete" } } }`);
  assert.equal(rows.length, 0, 'nothing was stored');
});

// ---------------------------------------------------------------------------------------------
// Server-set cookies, session lifetime and cleanup against the real store
// ---------------------------------------------------------------------------------------------

/** A response that records the cookies the provider sets (what Express would send). */
function recordingResponse() {
  const set = {};
  const cleared = [];
  return {
    set,
    cleared,
    headersSent: false,
    cookie(name, value, options) {
      set[name] = { value, options };
    },
    clearCookie(name, options) {
      cleared.push({ name, path: options?.path });
    },
  };
}

/** A browser request: no body-transport header, tokens only in cookies. */
function browserProvider(cookies = {}) {
  const request = { web: true, headers: {}, cookies };
  const response = recordingResponse();
  request.res = response;
  const p = provider(request);
  p.response = response;
  return { p, request, response };
}

async function recordFor(refreshToken) {
  const hash = crypto.createHash('sha256').update(refreshToken).digest('base64url');
  const rows = await sparql(`
    PREFIX auth: <https://linked.cm/ont/auth/>
    SELECT ?p ?o WHERE {
      { GRAPH ?g { ?s auth:tokenHash "${hash}" ; ?p ?o } }
      UNION { ?s auth:tokenHash "${hash}" ; ?p ?o }
    }`);
  return Object.fromEntries(rows.map((r) => [r.p.value.split('/').pop(), r.o.value]));
}

let webEmail;
test('browser sign-in and refresh: httpOnly cookies, no refresh token in the body, rotation in the store', async () => {
  webEmail = `grace-${crypto.randomBytes(4).toString('hex')}@example.test`;
  const signup = browserProvider();
  const created = await signup.p.createAccount({
    firstName: 'Grace',
    lastName: 'Hopper',
    email: webEmail,
    password: PASSWORD_1,
  });
  assert.equal(created.error, undefined, created.error);
  assert.equal(created.refreshToken, undefined, 'no refresh token in the body');
  const refreshCookie = signup.response.set.refreshToken;
  assert.ok(refreshCookie, 'refresh cookie set by the server');
  assert.equal(refreshCookie.options.httpOnly, true);
  assert.equal(refreshCookie.options.sameSite, 'strict');
  assert.equal(refreshCookie.options.path, '/call/@_linked/auth');
  assert.equal(refreshCookie.options.secure, true, 'SITE_ROOT is https');
  const stored = await recordFor(refreshCookie.value);
  assert.ok(
    Math.abs(Date.parse(stored.expiresAt) - (Date.now() + refreshCookie.options.maxAge)) < 2000,
    'cookie maxAge = the stored expiry'
  );
  assert.ok(stored.sessionStartedAt, 'session start stored');
  assert.equal(signup.response.set.accessToken.value, created.accessToken);
  assert.equal(signup.response.set.accessToken.options.httpOnly, true);

  const later = browserProvider({ refreshToken: refreshCookie.value });
  const refreshed = await later.p.validateToken(undefined, { forceRefresh: true });
  assert.equal(refreshed.error, undefined, refreshed.error);
  assert.equal(refreshed.refreshToken, undefined);
  const rotated = later.response.set.refreshToken.value;
  assert.notEqual(rotated, refreshCookie.value, 'rotated');
  assert.ok((await recordFor(refreshCookie.value)).revokedAt, 'old record revoked in the store');
  assert.equal(
    (await recordFor(rotated)).sessionStartedAt,
    stored.sessionStartedAt,
    'the session start is carried to the new record'
  );

  // sign-out with the cookie only: revoked in the store, cookies cleared
  const out = browserProvider({ refreshToken: rotated });
  assert.equal(await out.p.signout(), true);
  assert.ok(out.response.cleared.some((c) => c.name === 'refreshToken'));
  assert.ok(out.response.cleared.some((c) => c.name === 'accessToken'));
  assert.ok((await recordFor(rotated)).revokedAt, 'revoked by sign-out');
});

test('idle timeout: a session idle past AUTH_SESSION_IDLE_TTL cannot refresh and is revoked', async () => {
  const limits = sessions.getSessionLimits();
  const signin = await provider().signinWithPassword(webEmail, PASSWORD_1);
  assert.equal(signin.error, undefined, signin.error);
  mock.timers.enable({ apis: ['Date'], now: Date.now() + 2 * 3600 * 1000 });
  sessions.setSessionLimits({ idleTtl: 3600 });
  try {
    const result = await refresh(signin);
    assert.ok(result.error, 'refused after 2 h idle with a 1 h idle limit');
    assert.ok((await recordFor(signin.refreshToken)).revokedAt, 'session revoked in the store');
  } finally {
    sessions.setSessionLimits(limits);
  }
});

test('absolute lifetime: a session older than AUTH_SESSION_MAX_TTL cannot refresh, even when active', async () => {
  const limits = sessions.getSessionLimits();
  const signin = await provider().signinWithPassword(webEmail, PASSWORD_1);
  mock.timers.enable({ apis: ['Date'], now: Date.now() + 30 * 60 * 1000 });
  const step1 = await refresh(signin);
  assert.equal(step1.error, undefined, 'refreshing after 30 min is fine');
  sessions.setSessionLimits({ maxTtl: 45 * 60, idleTtl: 0 });
  mock.timers.tick(20 * 60 * 1000);
  try {
    const step2 = await refresh(step1);
    assert.ok(step2.error, '50 min after sign-in with a 45 min maximum');
  } finally {
    sessions.setSessionLimits(limits);
  }
});

test('absolute lifetime for records without sessionStartedAt: the first createdAt of the family (graph query)', async () => {
  const store = new sessions.GraphRefreshSessionStore();
  const accountId = (await provider().signinWithPassword(webEmail, PASSWORD_1)).auth.userAccount.id;
  const now = Date.now();
  const raw = sessions.generateRefreshToken();
  const sessionId = `legacy-${crypto.randomBytes(4).toString('hex')}`;
  await store.create({
    tokenHash: 'legacy-first-' + sessionId,
    sessionId,
    accountId,
    createdAt: new Date(now - 61 * 86400_000),
    expiresAt: new Date(now - 1 * 86400_000),
    revokedAt: new Date(now - 1 * 86400_000),
  });
  await store.create({
    tokenHash: sessions.hashRefreshToken(raw),
    sessionId,
    accountId,
    createdAt: new Date(now - 1 * 86400_000),
    lastUsedAt: new Date(now - 1 * 86400_000),
    expiresAt: new Date(now + 59 * 86400_000),
  });
  const result = await sessions.rotateRefreshToken(raw);
  assert.deepEqual(result, { ok: false, reason: 'session-expired' });
});

test('cleanupExpiredSessions deletes only long-revoked/expired records from the graph', async () => {
  const store = new sessions.GraphRefreshSessionStore();
  const accountId = (await provider().signinWithPassword(webEmail, PASSWORD_1)).auth.userAccount.id;
  const now = new Date();
  const day = 86400_000;
  const tag = crypto.randomBytes(4).toString('hex');
  const make = (name, fields) =>
    store.create({
      tokenHash: `${name}-${tag}`,
      sessionId: `cleanup-${tag}`,
      accountId,
      createdAt: new Date(now - 90 * day),
      expiresAt: new Date(now.getTime() + day),
      ...fields,
    });
  await make('active', {});
  await make('recentlyRevoked', { revokedAt: new Date(now - day) });
  await make('recentlyExpired', { expiresAt: new Date(now - day) });
  await make('oldRevoked', { revokedAt: new Date(now - 40 * day) });
  await make('oldExpired', { expiresAt: new Date(now - 40 * day) });

  const remaining = async () =>
    (
      await sparql(`
        PREFIX auth: <https://linked.cm/ont/auth/>
        SELECT ?h WHERE { { ?s auth:sessionId "cleanup-${tag}" ; auth:tokenHash ?h } UNION { GRAPH ?g { ?s auth:sessionId "cleanup-${tag}" ; auth:tokenHash ?h } } }`)
    )
      .map((r) => r.h.value.replace(`-${tag}`, ''))
      .sort();

  assert.equal((await remaining()).length, 5);
  const deleted = await sessions.cleanupExpiredSessions(store, { olderThan: 30 * 86400, now });
  assert.ok(deleted >= 2, `deleted ${deleted}`);
  assert.deepEqual(await remaining(), ['active', 'recentlyExpired', 'recentlyRevoked']);
});
