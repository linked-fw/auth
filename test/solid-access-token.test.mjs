// The verifier of a user's Solid-OIDC access token and DPoP proof (utils/solidAccessToken),
// against the mock issuer (mockIssuer.mjs): its keys, a WebID profile naming it, and proofs made
// here so each check can be broken on its own.
//
// Runs against the BUILT package in lib/ (build first: `npx linked build`). Every request goes
// through the real guarded fetch, with `allowLocalhost` since the mock runs on localhost.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { calculateJwkThumbprint } from 'jose';
import { startMockIssuer } from './mockIssuer.mjs';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'solid-access-token-test-secret-solid';

const libDir = new URL('../lib/esm/', import.meta.url);
const {
  createSolidAccessTokenVerifier,
  verifySolidAccessToken,
  InvalidUserTokenError,
  IssuerUnavailableError,
} = await import(new URL('utils/solidAccessToken.js', libDir));
const { dpopProofFor } = await import(new URL('utils/issuerTokens.js', libDir));

const CLIENT_ID = 'http://localhost:4010/.well-known/linked-client.jsonld';
const URL_ = 'http://localhost:4040/gateway/call/@_linked/server/selectQuery';

let issuer;
let webId;
let clock;
let verifier;

before(async () => {
  issuer = await startMockIssuer();
});
after(() => issuer.close());

beforeEach(() => {
  issuer.reset();
  webId = issuer.addProfile('ada', [issuer.issuer]);
  clock = Date.now();
  verifier = createSolidAccessTokenVerifier({ allowLocalhost: true, now: () => clock });
});

/** A DPoP key, the token bound to it, and a proof maker. */
async function holder({ claims, otherKey, keyFor } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const publicJwk = publicKey.export({ format: 'jwk' });
  const jkt = await calculateJwkThumbprint(publicJwk);
  const accessToken = issuer.mintAccessToken({ webId: keyFor ?? webId, clientId: CLIENT_ID, jkt, claims, otherKey });
  const grant = { accessToken, expiresAt: Date.now() + 300_000, dpopPublicJwk: publicJwk, dpopPrivateJwk: privateKey.export({ format: 'jwk' }) };
  return {
    accessToken,
    privateKey,
    publicJwk,
    proof: (target = { method: 'POST', url: URL_ }, now = clock) => dpopProofFor(grant, target, now),
  };
}

/** A proof with `payload` changed, signed with `key` (default: the holder's). */
function customProof(h, payload, { key = h.privateKey, jwk = h.publicJwk, typ = 'dpop+jwt' } = {}) {
  const b64 = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const body = {
    htm: 'POST',
    htu: URL_,
    iat: Math.floor(clock / 1000),
    jti: crypto.randomUUID(),
    ath: crypto.createHash('sha256').update(h.accessToken).digest('base64url'),
    ...payload,
  };
  for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
  const data = `${b64({ typ, alg: 'ES256', jwk })}.${b64(body)}`;
  const signature = crypto.sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' });
  return `${data}.${signature.toString('base64url')}`;
}

const input = (h, dpop, extra = {}) => ({
  accessToken: h.accessToken,
  dpop,
  method: 'POST',
  url: URL_,
  expectedClientId: CLIENT_ID,
  ...extra,
});

async function refused(promise, reason) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof InvalidUserTokenError, `${err?.name}: ${err?.message}`);
    assert.equal(err.reason, reason, err.message);
    assert.equal(err.code, 'invalid-user-token');
    return true;
  });
}

test('a valid token and proof: the WebID, issuer, client and expiry', async () => {
  const h = await holder();
  const verified = await verifier.verify(input(h, await h.proof()));
  assert.equal(verified.webId, webId);
  assert.equal(verified.issuer, issuer.issuer);
  assert.equal(verified.clientId, CLIENT_ID);
  assert.ok(verified.expiresAt > Date.now());
});

test('a verified token is cached: no second fetch of keys or profile, the proof still checked', async () => {
  const h = await holder();
  await verifier.verify(input(h, await h.proof()));
  const fetches = { jwks: issuer.jwksRequests, profile: issuer.profileRequests, discovery: issuer.discoveryRequests };
  await verifier.verify(input(h, await h.proof()));
  assert.deepEqual(
    { jwks: issuer.jwksRequests, profile: issuer.profileRequests, discovery: issuer.discoveryRequests },
    fetches
  );
  await refused(verifier.verify(input(h, undefined)), 'proof');
});

test('the signature must be by a key of the issuer', async () => {
  const h = await holder({ otherKey: true });
  await refused(verifier.verify(input(h, await h.proof())), 'signature');
});

test("the issuer must be named in the WebID's profile", async () => {
  const stranger = issuer.addProfile('stranger', ['https://other-issuer.test']);
  const h = await holder({ keyFor: stranger });
  await refused(verifier.verify(input(h, await h.proof())), 'issuer');
});

test('an expired token is refused', async () => {
  const past = Math.floor(Date.now() / 1000) - 600;
  const h = await holder({ claims: { iat: past - 300, exp: past } });
  await refused(verifier.verify(input(h, await h.proof())), 'expired');
});

test('a cached token is refused once it expires', async () => {
  const h = await holder();
  await verifier.verify(input(h, await h.proof()));
  clock += 301_000;
  await refused(verifier.verify(input(h, await h.proof())), 'expired');
});

test('aud must contain solid', async () => {
  const h = await holder({ claims: { aud: 'https://somewhere.test' } });
  await refused(verifier.verify(input(h, await h.proof())), 'audience');
});

test('a token for another client is refused as wrong-client', async () => {
  const h = await holder();
  await refused(
    verifier.verify(input(h, await h.proof(), { expectedClientId: 'http://localhost:4011/.well-known/linked-client.jsonld' })),
    'wrong-client'
  );
});

test('a token without webid, client_id or cnf.jkt is refused', async () => {
  for (const claims of [{ webid: undefined }, { client_id: undefined }, { cnf: undefined }]) {
    const h = await holder({ claims });
    await refused(verifier.verify(input(h, await h.proof())), 'malformed');
  }
  await refused(verifier.verify({ ...input(await holder(), 'x'), accessToken: 'not-a-jwt' }), 'malformed');
});

test("the proof's key must be the token's (cnf.jkt)", async () => {
  const h = await holder();
  const other = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const proof = customProof(h, {}, { key: other.privateKey, jwk: other.publicKey.export({ format: 'jwk' }) });
  await refused(verifier.verify(input(h, proof)), 'binding');
});

test('htm and htu must be the request method and URL', async () => {
  const h = await holder();
  await refused(verifier.verify(input(h, customProof(h, { htm: 'GET' }))), 'proof');
  await refused(verifier.verify(input(h, customProof(h, { htu: 'http://localhost:4040/gateway/call/@_linked/server/updateQuery' }))), 'proof');
  // a query or fragment is not part of the comparison
  await verifier.verify(input(h, customProof(h, { htu: `${URL_}?a=1` }), { url: `${URL_}#x` }));
});

test('a proof made more than 60 seconds away is refused', async () => {
  const h = await holder();
  await refused(verifier.verify(input(h, customProof(h, { iat: Math.floor(clock / 1000) - 61 }))), 'proof');
  await refused(verifier.verify(input(h, customProof(h, { iat: Math.floor(clock / 1000) + 61 }))), 'proof');
});

test('ath must be the hash of the token', async () => {
  const h = await holder();
  await refused(verifier.verify(input(h, customProof(h, { ath: 'AAAA' }))), 'binding');
});

test('a replayed proof (same jti) is refused', async () => {
  const h = await holder();
  const proof = await h.proof();
  await verifier.verify(input(h, proof));
  await refused(verifier.verify(input(h, proof)), 'replay');
});

test('a proof that is not dpop+jwt, unsigned by its key, or missing is refused', async () => {
  const h = await holder();
  await refused(verifier.verify(input(h, customProof(h, {}, { typ: 'JWT' }))), 'proof');
  const other = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  await refused(verifier.verify(input(h, customProof(h, {}, { key: other.privateKey }))), 'proof');
  await refused(verifier.verify(input(h, undefined)), 'proof');
  await refused(verifier.verify(input(h, 'nonsense')), 'proof');
});

test('a key the cached set lacks refetches the issuer keys once', async () => {
  const first = await holder();
  await verifier.verify(input(first, await first.proof()));
  const fetched = issuer.jwksRequests;
  issuer.rotateKey();
  clock += 31_000;
  const rotated = await holder();
  await verifier.verify(input(rotated, await rotated.proof()));
  assert.equal(issuer.jwksRequests, fetched + 1);
});

test('an issuer whose keys cannot be read is unavailable, not a refusal', async () => {
  issuer.jwksDown = true;
  const h = await holder();
  await assert.rejects(verifier.verify(input(h, await h.proof())), (err) => err instanceof IssuerUnavailableError);
});

test('loopback issuers only with allowLocalhost', async () => {
  const strict = createSolidAccessTokenVerifier({ now: () => clock });
  const h = await holder();
  await refused(strict.verify(input(h, await h.proof())), 'issuer');
});

test('verifySolidAccessToken uses the shared verifier', async () => {
  const h = await holder();
  const verified = await verifySolidAccessToken({ ...input(h, await h.proof(undefined, Date.now())), allowLocalhost: true });
  assert.equal(verified.webId, webId);
});
