// Email verification: createAccount and resendEmailVerification email a single-use link, and
// verifyEmail redeems it. A password reset by token also verifies the email.
//
// Runs against the BUILT package in lib/ (build first: `npx linked build`). No store: the
// credential, person and account shapes are in-memory tables, the email is captured instead of
// sent, and the sign-in step is stubbed. So these tests check which tokens verify an email, not
// the graph queries. The same flow runs against a real store in
// test/integration/accounts.fuseki.test.mjs.
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serving } from './serving.mjs';
import { fakeCredentialTable, fakeShapeTable } from './fakeStore.mjs';

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
const { default: PasswordHelper } = await import(new URL('helpers/password.js', libDir));
const verification = await import(new URL('helpers/emailVerification.js', libDir));
const sessions = await import(new URL('utils/sessions.js', libDir));
const { default: AuthBackendProvider } = await import(new URL('backend.js', libDir));
const { resetRateLimits } = await import(new URL('utils/rateLimit.js', libDir));
const { UserAccount } = await import('@_linked/sioc/shapes/UserAccount');
const { LinkedEmail } = await import('@_linked/server-utils/utils/LinkedEmail');

const EMAIL = 'ada@example.test';
const WEBID = emailToWebID(EMAIL);
const PASSWORD = 'long-enough';
const SIGNED_IN = { auth: { user: { id: WEBID } }, accessToken: 'access' };
const INVALID_LINK = {
  error: 'This verification link is invalid or has expired.',
  action: 'resend_verification',
};
const DAY = 24 * 60 * 60 * 1000;
const fakeLincdServer = { callGenericBackendProvidersMethod: async () => {} };

let credentials;
let people;
let accounts;
let sentEmails;

beforeEach(() => {
  resetRateLimits();
  credentials = fakeCredentialTable();
  credentials.install(AuthCredential);
  people = fakeShapeTable('person');
  accounts = fakeShapeTable('account');
  sentEmails = [];
  mock.method(LinkedEmail, 'send', async (options) => {
    sentEmails.push(options);
  });
  // only the create step: the sign-in that follows it is not what these tests check
  mock.method(Auth, 'login', async (_provider, _find, create) => {
    await create();
    return SIGNED_IN;
  });
  mock.method(Auth, 'onSigninSuccessful', async () => SIGNED_IN);
  sessions.setRefreshSessionStore(new sessions.MemoryRefreshSessionStore());
  mock.method(console, 'log', () => {});
  mock.method(console, 'warn', () => {});
  mock.method(console, 'error', () => {});
});

afterEach(() => {
  delete process.env.DEV_AUTH;
  mock.restoreAll();
});

/** The provider serving one call; `linkedAuth` makes it a signed-in call. */
function providerFor(linkedAuth) {
  const instance = new AuthBackendProvider(null, fakeLincdServer);
  instance.userShape = people;
  instance.accountShape = accounts;
  const request = { headers: {}, cookies: {}, res: { cookie() {}, clearCookie() {} } };
  if (linkedAuth) request.linkedAuth = linkedAuth;
  return serving(instance, request);
}

/** The signed-in session of the account created by `signup`. */
function sessionOfSignup() {
  const account = accounts.rows.find((row) => row.accountOf?.id === WEBID);
  assert.ok(account, 'signup created an account');
  return { user: { id: WEBID }, userAccount: { id: account.id } };
}

const signup = () =>
  providerFor().createAccount({ firstName: 'Ada', lastName: 'Lovelace', email: EMAIL, password: PASSWORD });

/** The token in the verification link of the last email sent. */
function tokenFromLastEmail() {
  const match = sentEmails.at(-1)?.htmlbody.match(/verify-email\?token=([^'"&\s]+)/);
  assert.ok(match, 'no verification link in the email');
  return decodeURIComponent(match[1]);
}

/** The credentials of the test person. */
const personRows = () =>
  [...credentials.rows.values()].filter((row) => row.credentialOf?.id === WEBID);

function onlyRow() {
  const rows = personRows();
  assert.equal(rows.length, 1, `expected one credential, found ${rows.length}`);
  return rows[0];
}

test('signup stores only a hash of the verification token, with an expiry, and emails the link', async () => {
  const before = Date.now();
  assert.equal(await signup(), SIGNED_IN);
  assert.equal(sentEmails.length, 1);
  assert.equal(sentEmails[0].to[0].email_address.address, EMAIL);
  const token = tokenFromLastEmail();
  const row = onlyRow();
  assert.equal(row.emailVerificationToken, verification.hashToken(token));
  assert.notEqual(row.emailVerificationToken, token);
  assert.ok(!JSON.stringify(row).includes(token), 'the raw token is not stored');
  const expiresAt = new Date(row.emailVerificationTokenExpiresAt).getTime();
  assert.ok(expiresAt >= before + 7 * DAY && expiresAt <= Date.now() + 7 * DAY, 'expires in 7 days');
  assert.equal(row.emailVerifiedAt, undefined, 'not verified yet');
});

test('signup signs in even when the email cannot be sent, and the unsent token is removed', async () => {
  mock.method(LinkedEmail, 'send', () => {
    throw new Error('No default email provider');
  });
  assert.equal(await signup(), SIGNED_IN);
  const row = onlyRow();
  assert.equal(row.emailVerificationToken, undefined);
  assert.equal(row.emailVerificationTokenExpiresAt, undefined);
  assert.ok(row.passwordHash, 'the account was created');
});

test('verifyEmail with a valid token sets emailVerifiedAt, and works only once', async () => {
  await signup();
  const token = tokenFromLastEmail();
  assert.equal(await verification.personEmailVerified(WEBID), false);

  assert.deepEqual(await providerFor().verifyEmail(token), { verified: true });
  const row = onlyRow();
  assert.ok(row.emailVerifiedAt, 'emailVerifiedAt is set');
  assert.equal(row.emailVerificationToken, undefined, 'the token is gone');
  assert.equal(await verification.personEmailVerified(WEBID), true);

  assert.deepEqual(await providerFor().verifyEmail(token), INVALID_LINK);
});

test('concurrent verifyEmail calls with one token: exactly one succeeds', async () => {
  await signup();
  const token = tokenFromLastEmail();
  const results = await Promise.all([1, 2, 3].map(() => providerFor().verifyEmail(token)));
  const verified = results.filter((result) => result.verified === true);
  assert.equal(verified.length, 1, JSON.stringify(results));
  for (const result of results.filter((r) => !r.verified)) assert.deepEqual(result, INVALID_LINK);
  assert.ok(onlyRow().emailVerifiedAt);
});

test('an expired or unknown token is refused with resend_verification, and an expired one is used up', async () => {
  credentials.insert({
    credentialOf: { id: WEBID },
    email: EMAIL,
    ...verification.verificationTokenFields('old-token', new Date(Date.now() - 8 * DAY)),
  });
  assert.deepEqual(await providerFor().verifyEmail('old-token'), INVALID_LINK);
  assert.equal(onlyRow().emailVerificationToken, undefined, 'the expired token is used up');
  assert.equal(onlyRow().emailVerifiedAt, undefined);

  assert.deepEqual(await providerFor().verifyEmail('never-issued'), INVALID_LINK);
  assert.deepEqual(await providerFor().verifyEmail(undefined), INVALID_LINK);
});

test('resendEmailVerification sends a new link that replaces the old one', async () => {
  await signup();
  const first = tokenFromLastEmail();
  const result = await providerFor(sessionOfSignup()).resendEmailVerification();
  assert.deepEqual(result, { sent: true });
  assert.equal(sentEmails.length, 2);
  const second = tokenFromLastEmail();
  assert.notEqual(second, first);
  assert.equal(onlyRow().emailVerificationToken, verification.hashToken(second));

  assert.deepEqual(await providerFor().verifyEmail(first), INVALID_LINK);
  assert.deepEqual(await providerFor().verifyEmail(second), { verified: true });
});

test('resendEmailVerification for a person without a credential creates one with the email', async () => {
  const account = await accounts.create({ accountOf: { id: WEBID }, email: EMAIL });
  const result = await providerFor({
    user: { id: WEBID },
    userAccount: { id: account.id },
  }).resendEmailVerification();
  assert.deepEqual(result, { sent: true });
  const row = onlyRow();
  assert.equal(row.email, EMAIL);
  assert.equal(row.emailVerificationToken, verification.hashToken(tokenFromLastEmail()));
});

test('resendEmailVerification: an account without an email gets no_email', async () => {
  const account = await accounts.create({ accountOf: { id: 'https://app.test/person/temp' } });
  const result = await providerFor({
    user: { id: 'https://app.test/person/temp' },
    userAccount: { id: account.id },
  }).resendEmailVerification();
  assert.equal(result.action, 'no_email');
  assert.ok(result.error);
  assert.equal(sentEmails.length, 0);
});

test('resendEmailVerification: an already verified email gets {verified: true} and no email', async () => {
  await signup();
  await providerFor().verifyEmail(tokenFromLastEmail());
  const result = await providerFor(sessionOfSignup()).resendEmailVerification();
  assert.deepEqual(result, { verified: true });
  assert.equal(sentEmails.length, 1, 'only the signup email');
});

test('resendEmailVerification: a failed send answers email_failed and removes the token', async () => {
  await signup();
  mock.method(LinkedEmail, 'send', async () => {
    throw new Error('provider down');
  });
  const result = await providerFor(sessionOfSignup()).resendEmailVerification();
  assert.deepEqual(result, {
    error: "Sorry, we couldn't send the email, please try again later",
    action: 'email_failed',
  });
  assert.equal(onlyRow().emailVerificationToken, undefined);
});

test('resendEmailVerification with DEV_AUTH and no provider logs the link and keeps the token', async () => {
  process.env.DEV_AUTH = 'true';
  mock.method(LinkedEmail, 'hasDefaultProvider', () => false);
  await signup();
  const info = mock.method(console, 'info', () => {});
  const result = await providerFor(sessionOfSignup()).resendEmailVerification();
  assert.deepEqual(result, { sent: true });
  const logged = info.mock.calls.map((call) => call.arguments.join(' ')).join('\n');
  const match = logged.match(/verify link: .*verify-email\?token=([^\s]+)/);
  assert.ok(match, `the link was logged: ${logged}`);
  assert.deepEqual(await providerFor().verifyEmail(match[1]), { verified: true });
});

test('resendEmailVerification without a session is refused with 401', async () => {
  await assert.rejects(providerFor().resendEmailVerification(), (err) => {
    assert.equal(err.status, 401);
    return true;
  });
});

test('a password reset with a token marks the email verified', async () => {
  const hashed = await PasswordHelper.generateHashedPassword('old-password');
  credentials.insert({
    credentialOf: { id: WEBID },
    email: EMAIL,
    passwordHash: hashed,
    ...PasswordHelper.resetPasswordTokenFields('reset-token'),
  });
  // the email lookup of resetPassword
  mock.method(UserAccount, 'select', () => ({
    where: () => ({ one: () => Promise.resolve({ id: 'acc', email: EMAIL, accountOf: { id: WEBID } }) }),
  }));
  const instance = new (class extends AuthBackendProvider {
    async getOrCreateAccount() {
      return { id: 'acc', email: EMAIL, accountOf: { id: WEBID } };
    }
  })(null, fakeLincdServer);
  const request = { headers: {}, cookies: {}, res: { cookie() {}, clearCookie() {} } };
  const result = await serving(instance, request).resetPassword(
    'new-password',
    'new-password',
    'reset-token'
  );
  assert.equal(result, SIGNED_IN);
  assert.ok(onlyRow().emailVerifiedAt, 'emailVerifiedAt is set');
  assert.equal(await verification.personEmailVerified(WEBID), true);
});

test('markEmailVerified gives a person without a credential a verified one, and is idempotent', async () => {
  await verification.markEmailVerified(WEBID, EMAIL);
  const first = onlyRow();
  assert.equal(first.email, EMAIL);
  assert.ok(first.emailVerifiedAt);
  const updatesBefore = credentials.updates.length;
  await verification.markEmailVerified(WEBID, EMAIL);
  assert.equal(personRows().length, 1, 'no second row');
  assert.equal(credentials.updates.length, updatesBefore, 'nothing written again');
});

test('personEmailVerified is false on a store error', async () => {
  mock.method(AuthCredential, 'select', () => {
    throw new Error('store down');
  });
  assert.equal(await verification.personEmailVerified(WEBID), false);
});
