// Email → WebID derivation: the default (UUID v5, unchanged), the HMAC rule webid.email mints with
// and its published test vector, and `Auth.webIdFor`, the configured derivation backend.ts calls.
//
// Runs against the BUILT package in lib/ (build first: `npx linked build`). The provider tests
// use the stubs of password-reset.test.mjs: no store, the email is captured instead of sent.
import { describe, test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serving } from './serving.mjs';
import { fakeCredentialTable } from './fakeStore.mjs';

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
const { emailToWebID, hmacWebId, hmacWebIdFor, HMAC_WEBID_TEST_VECTOR } = await import(
  new URL('utils/webID.js', libDir)
);
const { Auth } = await import(new URL('utils/auth.js', libDir));
const { AuthCredential } = await import(new URL('shapes/AuthCredential.js', libDir));
const sessions = await import(new URL('utils/sessions.js', libDir));
const { default: AuthBackendProvider } = await import(new URL('backend.js', libDir));
const { resetRateLimits } = await import(new URL('utils/rateLimit.js', libDir));
const { UserAccount } = await import('@_linked/sioc/shapes/UserAccount');
const { LinkedEmail } = await import('@_linked/server-utils/utils/LinkedEmail');

const DEV = { secret: 'local-dev-webid-secret', issuer: 'http://localhost:4050' };

// --- the default derivation -------------------------------------------------------------------

test('the default derivation is emailToWebID, unchanged', () => {
  assert.equal(Auth.webIdFor, emailToWebID);
  assert.equal(
    emailToWebID('ada@example.test'),
    'https://webid.email/id/1b4f387b-bd84-5bbe-b688-9be6677e46af'
  );
  assert.equal(emailToWebID('  ADA@Example.test '), emailToWebID('ada@example.test'));
});

// --- the HMAC rule ----------------------------------------------------------------------------

test('hmacWebId matches the published test vector', () => {
  const { email, secret, issuer, webId } = HMAC_WEBID_TEST_VECTOR;
  assert.equal(hmacWebId(email, { secret, issuer }), webId);
  assert.equal(hmacWebIdFor({ secret, issuer })(email), webId);
});

test('the test vector holds the dev secret and issuer, and an email that needs normalising', () => {
  const { email, secret, issuer } = HMAC_WEBID_TEST_VECTOR;
  assert.equal(secret, DEV.secret);
  assert.equal(issuer, DEV.issuer);
  assert.notEqual(email, email.trim().toLowerCase());
  assert.ok(Object.isFrozen(HMAC_WEBID_TEST_VECTOR));
});

test('hmacWebId is {issuer}/id/{first 128 bits of HMAC-SHA256 as hex}#me', () => {
  const h = crypto.createHmac('sha256', DEV.secret).update('bob@example.test').digest('hex');
  const webId = hmacWebId('bob@example.test', DEV);
  assert.equal(webId, `http://localhost:4050/id/${h.slice(0, 32)}#me`);
  assert.match(webId, /^http:\/\/localhost:4050\/id\/[0-9a-f]{32}#me$/);
});

test('hmacWebId normalises case and surrounding spaces only', () => {
  const webId = hmacWebId('bob@example.test', DEV);
  assert.equal(hmacWebId('BOB@Example.TEST', DEV), webId);
  assert.equal(hmacWebId(' \tbob@example.test\n ', DEV), webId);
  assert.notEqual(hmacWebId('bob+x@example.test', DEV), webId);
});

test('hmacWebId depends on the secret and the issuer', () => {
  const webId = hmacWebId('bob@example.test', DEV);
  assert.notEqual(hmacWebId('bob@example.test', { ...DEV, secret: 'another-secret' }), webId);
  assert.equal(
    hmacWebId('bob@example.test', { ...DEV, issuer: 'https://webid.email' }),
    webId.replace('http://localhost:4050', 'https://webid.email')
  );
});

test('an issuer with a trailing slash is refused, by the function and by the factory', () => {
  const options = { ...DEV, issuer: 'http://localhost:4050/' };
  assert.throws(() => hmacWebId('bob@example.test', options), /issuer must not end with a slash/);
  assert.throws(() => hmacWebIdFor(options), /issuer must not end with a slash/);
});

test('an empty secret or issuer is refused when the factory is created', () => {
  assert.throws(() => hmacWebIdFor({ ...DEV, secret: '' }), /secret/);
  assert.throws(() => hmacWebIdFor({ ...DEV, issuer: '' }), /issuer/);
  assert.throws(() => hmacWebIdFor({ issuer: DEV.issuer }), /secret/);
});

test('an empty email is refused', () => {
  const webIdFor = hmacWebIdFor(DEV);
  assert.throws(() => webIdFor(''), /non-empty/);
  assert.throws(() => webIdFor('   '), /non-empty/);
  assert.throws(() => hmacWebId(undefined, DEV), /non-empty/);
});

// --- backend.ts calls the configured derivation -----------------------------------------------

test('the built backend no longer calls emailToWebID directly', () => {
  const source = fs.readFileSync(new URL('backend.js', libDir), 'utf8');
  assert.doesNotMatch(source, /emailToWebID/);
  // the seven of the email-based methods, plus the Solid-OIDC sign-in's email check, the
  // account lookup for its mismatch hook, and whether a linked OAuth identity kept its email
  assert.equal(source.match(/Auth\.webIdFor\(/g)?.length, 10);
});

describe('backend.ts calls Auth.webIdFor', () => {
  const EMAIL = 'ada@example.test';
  const CONFIGURED_ID = 'https://issuer.test/id/configured#me';
  const fakeLincdServer = { callGenericBackendProvidersMethod: async () => {} };
  let provider;
  let derived;
  let defaultWebIdFor;
  let sentEmails;

  beforeEach(() => {
    resetRateLimits();
    fakeCredentialTable().install(AuthCredential);
    sentEmails = [];
    mock.method(LinkedEmail, 'send', async (options) => {
      sentEmails.push(options);
    });
    mock.method(UserAccount, 'select', () => ({
      where: () => ({ one: () => Promise.resolve(null) }),
    }));
    sessions.setRefreshSessionStore(new sessions.MemoryRefreshSessionStore());
    mock.method(console, 'log', () => {});
    mock.method(console, 'warn', () => {});
    mock.method(console, 'error', () => {});
    derived = [];
    defaultWebIdFor = Auth.webIdFor;
    Auth.webIdFor = (email) => {
      derived.push(email);
      return CONFIGURED_ID;
    };
    const request = { headers: {}, cookies: {}, res: { cookie() {}, clearCookie() {} } };
    provider = serving(new AuthBackendProvider(null, fakeLincdServer), request);
  });

  afterEach(() => {
    Auth.webIdFor = defaultWebIdFor;
    mock.restoreAll();
  });

  test('sendResetPasswordLink derives the WebID with Auth.webIdFor', async () => {
    await provider.sendResetPasswordLink(EMAIL);
    assert.deepEqual(derived, [EMAIL]);
  });

  test('signinWithPassword derives the WebID with Auth.webIdFor', async () => {
    await provider.signinWithPassword(EMAIL, 'not-the-password');
    assert.deepEqual(derived, [EMAIL]);
  });

  test('sendSigninCode derives the WebID with Auth.webIdFor', async () => {
    await provider.sendSigninCode(EMAIL);
    assert.deepEqual(derived, [EMAIL]);
  });

  test('signinWithCode derives the WebID with Auth.webIdFor', async () => {
    await provider.signinWithCode(EMAIL, '123456');
    assert.deepEqual(derived, [EMAIL]);
  });
});
