// WebID derivation: the configurable `webIdFor` (default: today's `emailToWebID`) and the keyed
// `hmacWebId`, checked against its published test vector.
//
// Runs against the BUILT package in lib/ (build first: `npx linked build`). No store: the one
// backend test records which Person IRI a password reset request looks up.
import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serving } from './serving.mjs';

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
const { emailToWebID, webIdFor, setWebIdFor } = await import(new URL('utils/webID.js', libDir));
const { hmacWebId, HMAC_WEBID_TEST_VECTOR } = await import(
  new URL('utils/hmacWebId.js', libDir)
);
const { default: AuthBackendProvider } = await import(new URL('backend.js', libDir));
const { UserAccount } = await import('@_linked/sioc/shapes/UserAccount');
const { resetRateLimits } = await import(new URL('utils/rateLimit.js', libDir));

afterEach(() => {
  setWebIdFor(null);
  mock.restoreAll();
});

// --- webIdFor ----------------------------------------------------------------------------------

test('webIdFor defaults to emailToWebID, so existing WebIDs stay', () => {
  assert.equal(webIdFor('ada@example.test'), emailToWebID('ada@example.test'));
  // pinned: the UUID v5 derivation must not change
  assert.equal(
    emailToWebID('alice@example.com'),
    'https://webid.email/id/1ab64308-d717-590f-a42d-7190cf14fe95'
  );
});

test('setWebIdFor replaces the derivation, and null restores the default', () => {
  setWebIdFor((email) => `https://other.test/${email}`);
  assert.equal(webIdFor('ada@example.test'), 'https://other.test/ada@example.test');
  setWebIdFor(null);
  assert.equal(webIdFor('ada@example.test'), emailToWebID('ada@example.test'));
});

test('the backend turns emails into WebIDs with the configured derivation', async () => {
  const config = { secret: 'unit-test-webid-secret', issuer: 'https://issuer.test' };
  setWebIdFor((email) => hmacWebId(email, config));
  resetRateLimits();
  mock.method(console, 'warn', () => {});

  const lookedUp = [];
  class TestProvider extends AuthBackendProvider {
    async getPasswordForUser(person) {
      lookedUp.push(person.id);
      return null;
    }
  }
  // no account for the email: the reset request ends after the lookups
  mock.method(UserAccount, 'select', () => ({ where: () => ({ one: async () => null }) }));
  const request = { headers: {}, cookies: {}, res: { cookie() {}, clearCookie() {} } };
  const fakeLincdServer = { callGenericBackendProvidersMethod: async () => {} };
  const provider = serving(new TestProvider(null, fakeLincdServer), request);

  assert.equal(await provider.sendResetPasswordLink('Ada@Example.test'), true);
  assert.deepEqual(lookedUp, [hmacWebId('ada@example.test', config)]);
});

// --- hmacWebId -----------------------------------------------------------------------------------

test('hmacWebId matches the published test vector', () => {
  const { email, secret, issuer, webId } = HMAC_WEBID_TEST_VECTOR;
  assert.equal(hmacWebId(email, { secret, issuer }), webId);
  assert.equal(webId, 'http://localhost:4050/id/9d4e3c342ed7dc86a07831ea7b5dd19e#me');
});

test('hmacWebId is {issuer}/id/{first 128 bits of HMAC-SHA256 as hex}#me', () => {
  const secret = 's3cret';
  const h = createHmac('sha256', secret).update('bob@example.org').digest('hex');
  assert.equal(
    hmacWebId('bob@example.org', { secret, issuer: 'https://webid.email' }),
    `https://webid.email/id/${h.slice(0, 32)}#me`
  );
});

test('hmacWebId normalises case and surrounding spaces', () => {
  const { email, secret, issuer, webId } = HMAC_WEBID_TEST_VECTOR;
  assert.equal(hmacWebId(`  ${email.toUpperCase()}\t`, { secret, issuer }), webId);
  assert.equal(hmacWebId('Alice@Example.COM', { secret, issuer }), webId);
});

test('hmacWebId ignores a trailing slash on the issuer', () => {
  const { email, secret, issuer, webId } = HMAC_WEBID_TEST_VECTOR;
  assert.equal(hmacWebId(email, { secret, issuer: `${issuer}/` }), webId);
});

test('hmacWebId depends on the secret and the issuer', () => {
  const { email, secret, issuer, webId } = HMAC_WEBID_TEST_VECTOR;
  assert.notEqual(hmacWebId(email, { secret: 'another-secret', issuer }), webId);
  assert.ok(
    hmacWebId(email, { secret, issuer: 'https://webid.email' }).startsWith(
      'https://webid.email/id/9d4e3c342ed7dc86a07831ea7b5dd19e'
    )
  );
});

test('hmacWebId refuses an empty email, secret or issuer', () => {
  const { secret, issuer } = HMAC_WEBID_TEST_VECTOR;
  assert.throws(() => hmacWebId('', { secret, issuer }));
  assert.throws(() => hmacWebId('   ', { secret, issuer }));
  assert.throws(() => hmacWebId('a@b.test', { secret: '', issuer }));
  assert.throws(() => hmacWebId('a@b.test', { secret, issuer: '' }));
});
