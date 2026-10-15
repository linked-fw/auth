// Apple sign-in nonces: issued by the server, carried by the identity token, usable once.
//
// Runs against the BUILT package in lib/. Apple identity tokens are signed with a locally
// generated key (served the way Apple's JWKS would); the identity-link store, the used-nonce
// store and `Auth.login` are stubbed.
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeCredentialTable } from './fakeStore.mjs';

process.env.NODE_ENV = 'test';
process.env.SITE_ROOT = 'https://app.test';
process.env.JWT_SECRET = 'unit-test-secret-unit-test-secret';
process.env.SESSION_SECRET = 'unit-test-session-secret';
process.env.AUTH_SESSION_CLEANUP = 'false';

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-auth-test-'));
fs.mkdirSync(path.join(workDir, 'data'));
process.chdir(workDir);
process.on('exit', () => fs.rmSync(workDir, { recursive: true, force: true }));

const libDir = new URL('../lib/esm/', import.meta.url);
const { default: jwt } = await import('jsonwebtoken');
const { Auth } = await import(new URL('utils/auth.js', libDir));
const { default: AppleHelper } = await import(new URL('helpers/apple.js', libDir));
const { default: AuthBackendProvider } = await import(new URL('backend.js', libDir));
const { AuthCredential } = await import(new URL('shapes/AuthCredential.js', libDir));
const { OAuthIdentityStore } = await import(new URL('utils/oauthIdentities.js', libDir)).catch(
  () => ({ OAuthIdentityStore: null })
);
const nonces = await import(new URL('utils/oauthNonce.js', libDir)).catch(() => null);

const KID = 'test-kid';
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const CLIENT_ID = 'com.example.app';
const SIGNED_IN = { user: { id: 'https://id.test/person/x' }, userAccount: { id: 'acc' } };
const fakeLincdServer = { callGenericBackendProvidersMethod: async () => {} };
const sha256hex = (value) => crypto.createHash('sha256').update(value).digest('hex');

function appleToken(claims = {}) {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      iss: 'https://appleid.apple.com',
      aud: CLIENT_ID,
      sub: '001234.abcdef.0001',
      email: 'ada@example.test',
      email_verified: 'true',
      iat: now,
      exp: now + 600,
      ...claims,
    },
    privatePem,
    { algorithm: 'RS256', keyid: KID }
  );
}

let provider;
let originalKey;
let used;

beforeEach(() => {
  process.env.APPLE_CLIENT_ID = CLIENT_ID;
  delete process.env.AUTH_APPLE_NONCE;
  originalKey = AppleHelper.key;
  AppleHelper.key = async () => ({ getPublicKey: () => publicPem });
  provider = new AuthBackendProvider(null, fakeLincdServer);
  mock.method(Auth, 'login', async () => SIGNED_IN);
  mock.method(Auth, 'onSigninSuccessful', async () => SIGNED_IN);
  for (const level of ['log', 'warn', 'error']) mock.method(console, level, () => {});
  if (OAuthIdentityStore) {
    mock.method(OAuthIdentityStore, 'findLinks', async () => []);
    mock.method(OAuthIdentityStore, 'createLink', async () => {});
  }
  provider.accountShape = {
    select: () => ({
      where: () => ({
        one: async () => null,
        then: (resolve, reject) => Promise.resolve([]).then(resolve, reject),
      }),
      for: async () => null,
    }),
  };
  provider.userShape = { select: () => ({ for: async () => null }) };
  fakeCredentialTable().install(AuthCredential);
  used = new Set();
  if (nonces) {
    mock.method(nonces.UsedNonceStore, 'markUsed', async (hash) => {
      if (used.has(hash)) return false;
      used.add(hash);
      return true;
    });
  }
});

afterEach(() => {
  AppleHelper.key = originalKey;
  delete process.env.APPLE_CLIENT_ID;
  delete process.env.AUTH_APPLE_NONCE;
  mock.restoreAll();
});

/** A nonce from the server, as a client gets it. */
async function serverNonce() {
  assert.equal(typeof provider.createOAuthNonce, 'function', 'createOAuthNonce exists');
  const { nonce, expiresAt } = await provider.createOAuthNonce();
  assert.ok(Date.parse(expiresAt) > Date.now());
  return nonce;
}

const signsIn = (result) => result === SIGNED_IN;

test('a stolen Apple identity token cannot sign in a second time', async () => {
  const nonce = await serverNonce();
  const identityToken = appleToken({ nonce: sha256hex(nonce) });
  assert.ok(signsIn(await provider.signinOAuth('apple', { identityToken, nonce })), 'first sign-in');
  const replay = await provider.signinOAuth('apple', { identityToken, nonce });
  assert.ok(!signsIn(replay), 'the same token and nonce signed in again');
  assert.ok(replay.error);
});

test('the nonce may be carried verbatim (Sign in with Apple JS)', async () => {
  const nonce = await serverNonce();
  const result = await provider.signinOAuth('apple', { identityToken: appleToken({ nonce }), nonce });
  assert.ok(signsIn(result), JSON.stringify(result));
});

test('a nonce the server did not issue is rejected', async () => {
  const nonce = 'client-made-nonce';
  const result = await provider.signinOAuth('apple', {
    identityToken: appleToken({ nonce: sha256hex(nonce) }),
    nonce,
  });
  assert.ok(!signsIn(result));
});

test('a nonce signed with another secret is rejected', async () => {
  const nonce = await serverNonce();
  const [random, expiry] = nonce.split('.');
  const forged = `${random}.${expiry}.${crypto.createHmac('sha256', 'other').update('x').digest('base64url')}`;
  const result = await provider.signinOAuth('apple', {
    identityToken: appleToken({ nonce: sha256hex(forged) }),
    nonce: forged,
  });
  assert.ok(!signsIn(result));
});

test('an expired nonce is rejected', async () => {
  assert.ok(nonces, 'utils/oauthNonce exists');
  const { nonce } = nonces.issueOAuthNonce(new Date(Date.now() - 11 * 60 * 1000));
  const result = await provider.signinOAuth('apple', {
    identityToken: appleToken({ nonce: sha256hex(nonce) }),
    nonce,
  });
  assert.ok(!signsIn(result));
});

test('a token that carries a different nonce is rejected, and does not use the nonce up', async () => {
  const nonce = await serverNonce();
  const other = await serverNonce();
  const wrong = await provider.signinOAuth('apple', {
    identityToken: appleToken({ nonce: sha256hex(other) }),
    nonce,
  });
  assert.ok(!signsIn(wrong));
  const right = await provider.signinOAuth('apple', {
    identityToken: appleToken({ nonce: sha256hex(nonce) }),
    nonce,
  });
  assert.ok(signsIn(right));
});

test('optional (the default): a sign-in without a nonce still works', async () => {
  assert.ok(signsIn(await provider.signinOAuth('apple', { identityToken: appleToken() })));
});

test('required: a sign-in without a nonce is rejected', async () => {
  process.env.AUTH_APPLE_NONCE = 'required';
  const result = await provider.signinOAuth('apple', { identityToken: appleToken() });
  assert.ok(!signsIn(result));
  assert.match(result.error, /nonce/);
});

test('an unknown AUTH_APPLE_NONCE value fails closed', async () => {
  process.env.AUTH_APPLE_NONCE = 'requird';
  assert.ok(!signsIn(await provider.signinOAuth('apple', { identityToken: appleToken() })));
});

test('required: a valid nonce signs in', async () => {
  process.env.AUTH_APPLE_NONCE = 'required';
  const nonce = await serverNonce();
  const result = await provider.signinOAuth('apple', {
    identityToken: appleToken({ nonce: sha256hex(nonce) }),
    nonce,
  });
  assert.ok(signsIn(result));
});
