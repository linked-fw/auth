// Password reset links: sendResetPasswordLink issues a token, resetPassword redeems it.
// Also: changing the password while signed in (resetPassword without a token) requires the
// current password, and signinWithPassword upgrades a hash below PASSWORD_HASH_COST.
//
// Runs against the BUILT package in lib/ (build first: `npx linked build`). No store: the
// `AuthCredential` and `UserAccount` queries are answered from an in-memory table, the email is
// captured instead of sent, refresh token records live in memory, and the final sign-in step is
// stubbed. So these tests check which tokens may reset a password, not the graph queries.
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
process.env.AUTH_SESSION_CLEANUP = 'false';

// connect-sqlite3 (express-session store) writes into <cwd>/data
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-auth-test-'));
fs.mkdirSync(path.join(workDir, 'data'));
process.chdir(workDir);
process.on('exit', () => fs.rmSync(workDir, { recursive: true, force: true }));

const libDir = new URL('../lib/esm/', import.meta.url);
const { Auth } = await import(new URL('utils/auth.js', libDir));
const { AuthCredential } = await import(new URL('shapes/AuthCredential.js', libDir));
const { emailToWebID } = await import(new URL('utils/webID.js', libDir));
const sessions = await import(new URL('utils/sessions.js', libDir));
const { default: PasswordHelper } = await import(new URL('helpers/password.js', libDir));
const { default: AuthBackendProvider } = await import(new URL('backend.js', libDir));
const { UserAccount } = await import('@_linked/sioc/shapes/UserAccount');
const { default: bcrypt } = await import('bcrypt');
const { LinkedEmail } = await import('@_linked/server-utils/utils/LinkedEmail');
const { resetRateLimits } = await import(new URL('utils/rateLimit.js', libDir));

const EMAIL = 'ada@example.test';
const PERSON_ID = emailToWebID(EMAIL);
const ACCOUNT = { id: 'https://app.test/account/ada', email: EMAIL, accountOf: { id: PERSON_ID } };
const SIGNED_IN = { user: { id: PERSON_ID }, userAccount: { id: ACCOUNT.id } };
const HOUR = 60 * 60 * 1000;

const fakeLincdServer = { callGenericBackendProvidersMethod: async () => {} };

/** The provider with the account lookups and the person shape replaced by fixtures. */
class TestProvider extends AuthBackendProvider {
  userShape = {
    select: () => ({ for: () => ({ one: async () => ({ id: PERSON_ID, givenName: 'Ada' }) }) }),
  };
  async getOrCreateAccount() {
    return { ...ACCOUNT };
  }
}

/**
 * An in-memory stand-in for the `AuthCredential` query API the provider uses:
 * `select(...).where(...)/.for(...).one()` (or the query awaited for every match), `create(data)` and `update(data).for(node)`.
 * A `null` in an update unsets the property, as it does for a real store.
 */
function fakeCredentialTable() {
  const rows = new Map();
  // every update, as [credential id, the data written]
  const updates = [];
  let nextId = 1;
  const copy = (row) => (row ? structuredClone(row) : null);
  const matches = (row, conditions) =>
    conditions.every(([prop, value]) =>
      value && typeof value === 'object' ? row[prop]?.id === value.id : row[prop] === value
    );
  const query = (conditions = []) => ({
    where(fn) {
      const found = [];
      const proxy = new Proxy(
        {},
        { get: (_t, prop) => ({ equals: (value) => (found.push([prop, value]), true) }) }
      );
      fn(proxy);
      return query([...conditions, ...found]);
    },
    for(node) {
      return query([...conditions, ['id', typeof node === 'string' ? node : node.id]]);
    },
    async one() {
      return copy([...rows.values()].find((row) => matches(row, conditions)));
    },
    // awaiting the query itself gives every match, like the real query builder
    then(resolve, reject) {
      return Promise.resolve(
        [...rows.values()].filter((row) => matches(row, conditions)).map(copy)
      ).then(resolve, reject);
    },
  });
  const write = (row, data) => {
    for (const [key, value] of Object.entries(data)) {
      if (value === null) delete row[key];
      else if (value !== undefined) row[key] = value instanceof Date ? value.toISOString() : value;
    }
  };
  return {
    rows,
    updates,
    insert(data) {
      const row = { id: `https://app.test/credential/${nextId++}` };
      write(row, data);
      rows.set(row.id, row);
      return copy(row);
    },
    install() {
      mock.method(AuthCredential, 'select', () => query());
      mock.method(AuthCredential, 'create', async (data) => this.insert(data));
      mock.method(AuthCredential, 'update', (data) => ({
        for: async (node) => {
          const id = typeof node === 'string' ? node : node.id;
          updates.push([id, { ...data }]);
          const row = rows.get(id);
          if (row) write(row, data);
          return copy(row);
        },
      }));
    },
  };
}

let credentials;
let sentEmails;
let provider;
let request;

beforeEach(() => {
  // every test requests links for the same email; each starts with a fresh limit budget
  resetRateLimits();
  credentials = fakeCredentialTable();
  credentials.install();
  sentEmails = [];
  mock.method(LinkedEmail, 'send', async (options) => {
    sentEmails.push(options);
  });
  // the email lookup of resetPassword, and the account lookup of a link for an account without
  // a password yet
  mock.method(UserAccount, 'select', () => ({
    where: () => ({ one: () => Promise.resolve({ ...ACCOUNT, accountOf: { id: PERSON_ID } }) }),
  }));
  mock.method(Auth, 'onSigninSuccessful', async () => SIGNED_IN);
  sessions.setRefreshSessionStore(new sessions.MemoryRefreshSessionStore());
  mock.method(console, 'log', () => {});
  mock.method(console, 'warn', () => {});
  mock.method(console, 'error', () => {});
  request = { headers: {}, cookies: {}, res: { cookie() {}, clearCookie() {} } };
  provider = serving(new TestProvider(null, fakeLincdServer), request);
});

afterEach(() => {
  mock.timers.reset();
  mock.restoreAll();
});

/** Request a reset link and return the token from the link in the email. */
async function requestResetLink() {
  const before = sentEmails.length;
  const result = await provider.sendResetPasswordLink(EMAIL);
  assert.equal(result, true, `sendResetPasswordLink failed: ${JSON.stringify(result)}`);
  assert.equal(sentEmails.length, before + 1, 'no email was sent');
  const match = sentEmails.at(-1).htmlbody.match(/reset-password\?token=([^'"&\s]+)/);
  assert.ok(match, 'no reset link in the email');
  return decodeURIComponent(match[1]);
}

/** The one stored credential of the test account. */
function storedCredential() {
  const rows = [...credentials.rows.values()].filter((row) => row.credentialOf?.id === PERSON_ID);
  assert.equal(rows.length, 1, `expected one credential, found ${rows.length}`);
  return rows[0];
}

async function passwordIs(password) {
  return PasswordHelper.checkPassword(password, storedCredential().passwordHash);
}

// a cost-4 hash of OLD_PASSWORD, as releases before 3.0.4 stored them
const OLD_PASSWORD = 'correct horse battery staple';
const COST_4_HASH = '$2b$04$eye1NrzS0IIvhvF2J5vUSev86XW.nY.Hn/2cnBV/0ecIMgys8pvGC';

function existingPassword(passwordHash = COST_4_HASH) {
  return credentials.insert({
    credentialOf: { id: PERSON_ID },
    email: EMAIL,
    passwordHash,
  });
}

const signedIn = () => (request.linkedAuth = { user: { id: PERSON_ID } });

test('a fresh reset link resets the password, without the current one, at cost 10', async () => {
  existingPassword();
  const token = await requestResetLink();
  const result = await provider.resetPassword('new-pass-1', 'new-pass-1', token);
  assert.equal(result, SIGNED_IN);
  assert.equal(await passwordIs('new-pass-1'), true);
  assert.equal(bcrypt.getRounds(storedCredential().passwordHash), 10);
});

test('a fresh reset link also works for an account that had no password yet', async () => {
  const token = await requestResetLink();
  const result = await provider.resetPassword('new-pass-1', 'new-pass-1', token);
  assert.equal(result, SIGNED_IN);
  assert.equal(await passwordIs('new-pass-1'), true);
});

test('a reset link works only once', async () => {
  existingPassword();
  const token = await requestResetLink();
  assert.equal(await provider.resetPassword('new-pass-1', 'new-pass-1', token), SIGNED_IN);

  const second = await provider.resetPassword('new-pass-2', 'new-pass-2', token);
  assert.ok(second?.error, `the token was accepted a second time: ${JSON.stringify(second)}`);
  assert.equal(await passwordIs('new-pass-1'), true, 'the second use changed the password');
});

test('mismatched passwords do not use up the link', async () => {
  existingPassword();
  const token = await requestResetLink();
  const typo = await provider.resetPassword('new-pass-1', 'new-pass-X', token);
  assert.deepEqual(typo, { error: 'Passwords do not match' });
  assert.equal(await provider.resetPassword('new-pass-1', 'new-pass-1', token), SIGNED_IN);
});

test('a reset link expires after an hour', async () => {
  existingPassword();
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-01T00:00:00Z') });
  const token = await requestResetLink();
  mock.timers.tick(HOUR + 1000);

  const result = await provider.resetPassword('new-pass-1', 'new-pass-1', token);
  assert.ok(result?.error, `an expired token was accepted: ${JSON.stringify(result)}`);
  assert.equal(await passwordIs('new-pass-1'), false, 'the expired token changed the password');
});

test('a reset link still works just before it expires', async () => {
  existingPassword();
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-01T00:00:00Z') });
  const token = await requestResetLink();
  mock.timers.tick(HOUR - 1000);
  assert.equal(await provider.resetPassword('new-pass-1', 'new-pass-1', token), SIGNED_IN);
});

test('a stored token from before expiry was recorded no longer resets the password', async () => {
  // what a link issued by an earlier release left in the store: the raw token, no expiry
  credentials.insert({
    credentialOf: { id: PERSON_ID },
    email: EMAIL,
    passwordHash: '$2b$04$eye1NrzS0IIvhvF2J5vUSev86XW.nY.Hn/2cnBV/0ecIMgys8pvGC',
    forgotPasswordToken: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
  });
  const result = await provider.resetPassword(
    'new-pass-1',
    'new-pass-1',
    'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
  );
  assert.ok(result?.error, `a legacy token was accepted: ${JSON.stringify(result)}`);
  assert.equal(await passwordIs('new-pass-1'), false, 'the legacy token changed the password');
});

test('requesting a new link invalidates the previous one', async () => {
  existingPassword();
  const first = await requestResetLink();
  const second = await requestResetLink();
  assert.notEqual(first, second);

  const old = await provider.resetPassword('new-pass-1', 'new-pass-1', first);
  assert.ok(old?.error, `the older link was accepted: ${JSON.stringify(old)}`);
  assert.equal(await provider.resetPassword('new-pass-2', 'new-pass-2', second), SIGNED_IN);
  assert.equal(await passwordIs('new-pass-2'), true);
});

test('changing the password while signed in ends an outstanding reset link', async () => {
  existingPassword();
  const token = await requestResetLink();
  signedIn();
  assert.equal(
    await provider.resetPassword('new-pass-1', 'new-pass-1', undefined, OLD_PASSWORD),
    SIGNED_IN
  );
  delete request.linkedAuth;

  const result = await provider.resetPassword('new-pass-2', 'new-pass-2', token);
  assert.ok(result?.error, `the outstanding link still worked: ${JSON.stringify(result)}`);
  assert.equal(await passwordIs('new-pass-1'), true);
});

test('the raw token is not stored', async () => {
  existingPassword();
  const token = await requestResetLink();
  assert.ok(storedCredential().forgotPasswordToken, 'no token stored');
  assert.notEqual(storedCredential().forgotPasswordToken, token);
});

test('an unknown or empty token is rejected', async () => {
  existingPassword();
  await requestResetLink();
  for (const token of ['not-a-token', '']) {
    const result = await provider.resetPassword('new-pass-1', 'new-pass-1', token);
    assert.ok(result?.error, `token ${JSON.stringify(token)} was accepted`);
  }
  assert.equal(await passwordIs('new-pass-1'), false);
});

// --- changing the password while signed in (no reset token) ---

test('a change without a token and without the current password is rejected', async () => {
  existingPassword();
  signedIn();
  for (const currentPassword of [undefined, '']) {
    const result = await provider.resetPassword('new-pass-1', 'new-pass-1', undefined, currentPassword);
    assert.deepEqual(result, { error: 'Your current password is required to change your password' });
  }
  assert.equal(await passwordIs(OLD_PASSWORD), true, 'the password was changed');
});

test('a change with a wrong current password is rejected', async () => {
  existingPassword();
  signedIn();
  const result = await provider.resetPassword('new-pass-1', 'new-pass-1', undefined, 'wrong');
  assert.deepEqual(result, { error: 'Your current password is incorrect' });
  assert.equal(await passwordIs(OLD_PASSWORD), true, 'the password was changed');
});

test('a change with the correct current password succeeds, at cost 10', async () => {
  existingPassword();
  signedIn();
  const result = await provider.resetPassword('new-pass-1', 'new-pass-1', undefined, OLD_PASSWORD);
  assert.equal(result, SIGNED_IN);
  assert.equal(await passwordIs('new-pass-1'), true);
  assert.equal(await passwordIs(OLD_PASSWORD), false);
  assert.equal(bcrypt.getRounds(storedCredential().passwordHash), 10);
});

test('a change without a token for an account with no password is rejected', async () => {
  signedIn();
  // no credential at all
  const none = await provider.resetPassword('new-pass-1', 'new-pass-1', undefined, 'anything');
  assert.equal(none?.action, 'reset_password_by_email', JSON.stringify(none));
  assert.equal(credentials.rows.size, 0, 'a credential was created');

  // a credential that only holds a reset token (an OAuth account that requested a link)
  await requestResetLink();
  signedIn();
  const tokenOnly = await provider.resetPassword('new-pass-1', 'new-pass-1', undefined, 'anything');
  assert.equal(tokenOnly?.action, 'reset_password_by_email', JSON.stringify(tokenOnly));
  assert.equal(storedCredential().passwordHash, undefined, 'a password was set');
});

test('a change without a token and without a session is rejected', async () => {
  existingPassword();
  const result = await provider.resetPassword('new-pass-1', 'new-pass-1', undefined, OLD_PASSWORD);
  assert.ok(result?.error, JSON.stringify(result));
  assert.equal(await passwordIs(OLD_PASSWORD), true);
});

// --- signing in upgrades old hashes ---

test('a cost-4 hash is upgraded to cost 10 by a successful sign-in', async () => {
  const { id } = existingPassword();
  const result = await provider.signinWithPassword(EMAIL, OLD_PASSWORD);
  assert.equal(result, SIGNED_IN);
  const hash = storedCredential().passwordHash;
  assert.equal(bcrypt.getRounds(hash), 10);
  assert.equal(await passwordIs(OLD_PASSWORD), true);
  // the upgrade writes the hash and nothing else
  assert.deepEqual(credentials.updates, [[id, { passwordHash: hash }]]);
});

test('a failed sign-in does not re-hash', async () => {
  existingPassword();
  const result = await provider.signinWithPassword(EMAIL, 'wrong');
  assert.ok(result?.error, JSON.stringify(result));
  assert.equal(storedCredential().passwordHash, COST_4_HASH);
  assert.deepEqual(credentials.updates, []);
});

test('a hash already at cost 10 is not rewritten by a sign-in', async () => {
  existingPassword(await bcrypt.hash(OLD_PASSWORD, 10));
  assert.equal(await provider.signinWithPassword(EMAIL, OLD_PASSWORD), SIGNED_IN);
  assert.deepEqual(credentials.updates, []);
});

test('a failed upgrade does not fail the sign-in', async () => {
  existingPassword();
  mock.method(AuthCredential, 'update', () => ({
    for: async () => {
      throw new Error('store down');
    },
  }));
  assert.equal(await provider.signinWithPassword(EMAIL, OLD_PASSWORD), SIGNED_IN);
  assert.equal(storedCredential().passwordHash, COST_4_HASH);
});
