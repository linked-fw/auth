// Apple identity token verification (helpers/apple).
//
// Runs against the BUILT package in lib/ (build first: `npx linked build`). No network: tokens are
// signed with a locally generated RSA key, and the helper's key lookup is stubbed to serve that
// key the way Apple's JWKS endpoint would (by `kid`).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const libDir = new URL('../lib/esm/', import.meta.url);
const { default: jwt } = await import('jsonwebtoken');
const { default: AppleHelper } = await import(new URL('helpers/apple.js', libDir));

const KID = 'test-kid';
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });

const CLIENT_ID = 'com.example.app';
const APPLE_ISSUER = 'https://appleid.apple.com';

const ENV_KEYS = ['APPLE_CLIENT_ID', 'APPLE_CLIENT_ID_IOS'];
let savedEnv;
let originalKey;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.APPLE_CLIENT_ID = CLIENT_ID;
  originalKey = AppleHelper.key;
  AppleHelper.key = async (kid) => {
    if (kid !== KID) throw new Error(`unknown kid ${kid}`);
    return { getPublicKey: () => publicPem };
  };
});

afterEach(() => {
  AppleHelper.key = originalKey;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function sign(overrides = {}, options = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: APPLE_ISSUER,
    aud: CLIENT_ID,
    sub: '001234.abcdef.0001',
    email: 'ada@example.test',
    email_verified: 'true',
    iat: now,
    exp: now + 600,
    ...overrides,
  };
  return jwt.sign(payload, privatePem, { algorithm: 'RS256', keyid: KID, ...options });
}

// A rejected token either throws or resolves to null; anything else is an accepted token.
async function assertRejected(promise) {
  let result;
  try {
    result = await promise;
  } catch {
    return;
  }
  assert.equal(result, null, `token was accepted: ${JSON.stringify(result)}`);
}

test('a valid token for a configured client ID is accepted, with its issue time', async () => {
  const iat = Math.floor(Date.now() / 1000) - 30;
  const result = await AppleHelper.decodeIdentityToken(sign({ iat }));
  assert.deepEqual(result, { email: 'ada@example.test', sub: '001234.abcdef.0001', iat });
});

test('a token for the iOS bundle ID (APPLE_CLIENT_ID_IOS) is accepted', async () => {
  process.env.APPLE_CLIENT_ID = 'com.example.web';
  process.env.APPLE_CLIENT_ID_IOS = 'com.example.ios';
  const result = await AppleHelper.decodeIdentityToken(sign({ aud: 'com.example.ios' }));
  assert.equal(result?.sub, '001234.abcdef.0001');
});

test('a token issued to another app (wrong aud) is rejected', async () => {
  await assertRejected(AppleHelper.decodeIdentityToken(sign({ aud: 'some.other.app' })));
});

test('a token from another issuer (wrong iss) is rejected', async () => {
  await assertRejected(AppleHelper.decodeIdentityToken(sign({ iss: 'https://evil.example' })));
});

test('an expired token is rejected', async () => {
  const now = Math.floor(Date.now() / 1000);
  await assertRejected(AppleHelper.decodeIdentityToken(sign({ iat: now - 1200, exp: now - 600 })));
});

test('with no Apple client ID configured every token is rejected', async () => {
  delete process.env.APPLE_CLIENT_ID;
  await assertRejected(AppleHelper.decodeIdentityToken(sign()));
});

test('an unsigned token (alg: none) is rejected', async () => {
  const unsigned = jwt.sign(
    { iss: APPLE_ISSUER, aud: CLIENT_ID, sub: 'x', email: 'ada@example.test', email_verified: 'true' },
    null,
    { algorithm: 'none', keyid: KID }
  );
  await assertRejected(AppleHelper.decodeIdentityToken(unsigned));
});

test('a token whose email is not verified is rejected', async () => {
  await assertRejected(AppleHelper.decodeIdentityToken(sign({ email_verified: 'false' })));
});

test('a value that is not a JWT is rejected', async () => {
  await assertRejected(AppleHelper.decodeIdentityToken('not-a-jwt'));
});
