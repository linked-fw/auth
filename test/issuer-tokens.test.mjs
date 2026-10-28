// The issuer's access token kept per session (utils/issuerTokens): sealed in the store, dropped
// with the session (sign-out, revocation, account removal) and once it expires, and the hook that
// answers `x-linked-user-token` and a fresh DPoP proof for a data server.
//
// Runs against the BUILT package in lib/ (build first: `npx linked build`).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { calculateJwkThumbprint, decodeProtectedHeader, importJWK, jwtVerify } from 'jose';

process.env.NODE_ENV = 'test';
process.env.SITE_ROOT = 'https://app.test';
process.env.JWT_SECRET = 'issuer-tokens-test-secret-issuer-tokens';
process.env.AUTH_SESSION_CLEANUP = 'false';

const libDir = new URL('../lib/esm/', import.meta.url);
const tokens = await import(new URL('utils/issuerTokens.js', libDir));
const sessions = await import(new URL('utils/sessions.js', libDir));

const ACCOUNT = 'https://app.test/account/ada';
const URL_ = 'https://cn.test/gateway/call/@_linked/server/selectQuery';

function newGrant({ expiresIn = 300_000 } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    accessToken: `header.${Buffer.from(JSON.stringify({ n: crypto.randomUUID() })).toString('base64url')}.sig`,
    expiresAt: Date.now() + expiresIn,
    dpopPublicJwk: publicKey.export({ format: 'jwk' }),
    dpopPrivateJwk: privateKey.export({ format: 'jwk' }),
  };
}

const requestFor = (sid) => ({ linkedAuth: { sid, user: { id: 'https://id.test/ada#me' } } });

let store;
beforeEach(() => {
  store = new tokens.MemoryIssuerTokenStore();
  tokens.setIssuerTokenStore(store);
  sessions.setRefreshSessionStore(new sessions.MemoryRefreshSessionStore());
});

test('a kept grant is sealed in the store and opened for its own session only', async () => {
  const grant = newGrant();
  await tokens.keepIssuerGrant('s1', grant);
  const record = store.records.get('s1');
  assert.ok(record.sealed.startsWith('v1.'));
  assert.equal(record.sealed.includes(grant.accessToken), false);
  assert.equal(JSON.stringify(record).includes(grant.dpopPrivateJwk.d), false);
  assert.equal(record.expiresAt, grant.expiresAt);
  assert.deepEqual(await tokens.issuerGrantOf('s1'), grant);
  // the same record under another session does not open
  await store.put('s2', record);
  assert.equal(await tokens.issuerGrantOf('s2'), undefined);
  // nor with another secret
  assert.equal(tokens.openIssuerGrant(record.sealed, 's1', 'another-secret-another-secret'), undefined);
});

test('an expired grant is not answered and is removed', async () => {
  await tokens.keepIssuerGrant('s1', newGrant({ expiresIn: -1 }));
  assert.equal(await tokens.issuerGrantOf('s1'), undefined);
  assert.equal(store.records.has('s1'), false);
});

test('the hook answers the token and a fresh DPoP proof for the method and URL', async () => {
  const grant = newGrant();
  await tokens.keepIssuerGrant('s1', grant);
  tokens.installUserTokenHeaders();
  const hook = globalThis[Symbol.for('@_linked/auth:userTokenHeaders')];
  assert.equal(hook, tokens.userTokenHeaders);

  const first = await hook(requestFor('s1'), { method: 'post', url: `${URL_}?x=1#f` });
  assert.deepEqual(Object.keys(first).sort(), ['DPoP', 'x-linked-user-token']);
  assert.equal(first['x-linked-user-token'], grant.accessToken);
  const header = decodeProtectedHeader(first.DPoP);
  assert.equal(header.typ, 'dpop+jwt');
  assert.equal(header.alg, 'ES256');
  assert.equal('d' in header.jwk, false, 'the proof carries the public key only');
  assert.equal(await calculateJwkThumbprint(header.jwk), await calculateJwkThumbprint(grant.dpopPublicJwk));
  const { payload } = await jwtVerify(first.DPoP, await importJWK(header.jwk, 'ES256'), { typ: 'dpop+jwt' });
  assert.equal(payload.htm, 'POST');
  assert.equal(payload.htu, URL_, 'no query, no fragment');
  assert.equal(payload.ath, crypto.createHash('sha256').update(grant.accessToken).digest('base64url'));
  assert.ok(Math.abs(payload.iat - Date.now() / 1000) < 5);

  const second = await hook(requestFor('s1'), { method: 'POST', url: URL_ });
  const secondJti = JSON.parse(Buffer.from(second.DPoP.split('.')[1], 'base64url')).jti;
  assert.notEqual(secondJti, payload.jti, 'a new jti for every proof');
});

test('the hook answers undefined without a session, without a grant and near expiry', async () => {
  await tokens.keepIssuerGrant('fresh', newGrant());
  await tokens.keepIssuerGrant('ending', newGrant({ expiresIn: 10_000 }));
  const target = { method: 'POST', url: URL_ };
  assert.equal(await tokens.userTokenHeaders(undefined, target), undefined);
  assert.equal(await tokens.userTokenHeaders({}, target), undefined);
  assert.equal(await tokens.userTokenHeaders({ linkedAuth: { user: {} } }, target), undefined);
  assert.equal(await tokens.userTokenHeaders(requestFor('no-grant'), target), undefined);
  assert.equal(await tokens.userTokenHeaders(requestFor('ending'), target), undefined, 'under 30 s left');
  assert.ok(await tokens.userTokenHeaders(requestFor('fresh'), target));
});

test('the hook never throws: a broken record answers undefined', async () => {
  await store.put('s1', { sealed: 'v1.garbage', expiresAt: Date.now() + 60_000 });
  assert.equal(await tokens.userTokenHeaders(requestFor('s1'), { method: 'POST', url: URL_ }), undefined);
});

async function signedInSession(sessionId) {
  const memory = sessions.getRefreshSessionStore();
  await memory.create({
    tokenHash: crypto.randomBytes(16).toString('hex'),
    sessionId,
    accountId: ACCOUNT,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 3600_000),
  });
  await tokens.keepIssuerGrant(sessionId, newGrant());
}

test('sign-out and revocation of a session drop its grant', async () => {
  await signedInSession('a');
  await signedInSession('b');
  await sessions.revokeSession('a');
  assert.equal(store.records.has('a'), false);
  assert.equal(store.records.has('b'), true);
});

test("revoking every session of an account, and removing the account, drop their grants", async () => {
  await signedInSession('a');
  await signedInSession('b');
  await sessions.revokeAllSessionsForAccount(ACCOUNT);
  assert.equal(store.records.size, 0);

  await signedInSession('c');
  await sessions.deleteAllSessionsForAccount(ACCOUNT);
  assert.equal(store.records.size, 0);
});

test('session cleanup removes expired grants', async () => {
  await tokens.keepIssuerGrant('old', newGrant({ expiresIn: -1000 }));
  await tokens.keepIssuerGrant('live', newGrant());
  await sessions.cleanupExpiredSessions();
  assert.deepEqual([...store.records.keys()], ['live']);
});
