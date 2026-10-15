// Sign-in by emailed code: sendSigninCode stores a code and emails it with a link, signinWithCode
// redeems it once, marks the email verified and signs in (creating the person and account for an
// email that has none).
//
// Runs against the BUILT package in lib/ (build first: `npx linked build`). No store: the
// `AuthCredential`, person and account queries are answered from in-memory tables, the email is
// captured instead of sent, and the final session step is stubbed. So these tests check which
// codes sign in and what they leave behind, not the graph queries.
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serving } from './serving.mjs';
import { fakeCredentialTable, fakeShapeTable } from './fakeStore.mjs';

process.env.NODE_ENV = 'test';
process.env.SITE_ROOT = 'https://app.test';
process.env.APP_NAME = 'Test App';
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
const { emailToWebID, hmacWebIdFor, HMAC_WEBID_TEST_VECTOR } = await import(
  new URL('utils/webID.js', libDir)
);
const { default: AuthBackendProvider, INVALID_SIGNIN_CODE_MESSAGE } = await import(
  new URL('backend.js', libDir)
);
const { DEFAULT_SIGNIN_CODE_TTL, hashToken } = await import(
  new URL('helpers/credentialToken.js', libDir)
);
const { resetRateLimits } = await import(new URL('utils/rateLimit.js', libDir));
const { UserAccount } = await import('@_linked/sioc/shapes/UserAccount');
const { LinkedEmail } = await import('@_linked/server-utils/utils/LinkedEmail');

const EMAIL = 'ada@example.test';
const PERSON_ID = emailToWebID(EMAIL);
const NEW_EMAIL = 'grace@example.test';
const NEW_PERSON_ID = emailToWebID(NEW_EMAIL);
const REFUSED = { error: INVALID_SIGNIN_CODE_MESSAGE, action: 'invalid_code' };
const fakeLincdServer = { callGenericBackendProvidersMethod: async () => {} };

let credentials;
let people;
let accounts;
let sentEmails;
let infoLogs;
let provider;
let request;

beforeEach(() => {
  resetRateLimits();
  delete process.env.DEV_AUTH;
  credentials = fakeCredentialTable();
  credentials.install(AuthCredential);
  people = fakeShapeTable('person', [{ id: PERSON_ID, givenName: 'Ada' }]);
  accounts = fakeShapeTable('account', [
    { id: 'https://app.test/account/ada', email: EMAIL, accountOf: { id: PERSON_ID } },
  ]);
  mock.method(UserAccount, 'select', () => accounts.select());
  sentEmails = [];
  mock.method(LinkedEmail, 'send', async (options) => {
    sentEmails.push(options);
  });
  // the session step: which person and account sign-in reached
  mock.method(Auth, 'onSigninSuccessful', async (_provider, person, account, isNew = false) => ({
    signedIn: person.id,
    account: account.id,
    isNew,
  }));
  infoLogs = [];
  mock.method(console, 'info', (line) => infoLogs.push(String(line)));
  mock.method(console, 'log', () => {});
  mock.method(console, 'warn', () => {});
  mock.method(console, 'error', () => {});
  request = { ip: '203.0.113.7', headers: {}, cookies: {}, res: { cookie() {}, clearCookie() {} } };
  class TestProvider extends AuthBackendProvider {
    userShape = people;
    accountShape = accounts;
  }
  provider = serving(new TestProvider(null, fakeLincdServer), request);
});

afterEach(() => {
  mock.restoreAll();
  delete process.env.DEV_AUTH;
});

/** Ada's password credential. */
function adaHasPassword() {
  return credentials.insert({ credentialOf: { id: PERSON_ID }, email: EMAIL, passwordHash: 'h' });
}

/** Request a code for `email` and return the code and link from the email sent. */
async function requestCode(email = EMAIL) {
  const before = sentEmails.length;
  const result = await provider.sendSigninCode(email);
  assert.equal(result, true, `sendSigninCode failed: ${JSON.stringify(result)}`);
  assert.equal(sentEmails.length, before + 1, 'no email was sent');
  const body = sentEmails.at(-1).htmlbody;
  const link = body.match(/href='([^']*signin-code[^']*)'/)?.[1]?.replace(/&amp;/g, '&');
  assert.ok(link, 'no sign-in link in the email');
  const code = new URL(link).searchParams.get('code');
  assert.match(code, /^\d{8}$/);
  assert.ok(body.includes(`>${code}<`), 'the code is not in the email text');
  return { code, link };
}

const rowsOf = (personId) =>
  [...credentials.rows.values()].filter((row) => row.credentialOf?.id === personId);

test('a code signs in to the account of its email and marks the email verified', async () => {
  adaHasPassword();
  const { code, link } = await requestCode();
  assert.equal(new URL(link).searchParams.get('email'), EMAIL);
  assert.equal(new URL(link).pathname, '/auth/signin-code');

  const result = await provider.signinWithCode(EMAIL, code);
  assert.deepEqual(result, {
    signedIn: PERSON_ID,
    account: 'https://app.test/account/ada',
    isNew: false,
  });
  const [credential] = rowsOf(PERSON_ID);
  assert.ok(credential.emailVerifiedAt, 'emailVerifiedAt was not set');
  assert.equal(credential.signinCode, undefined, 'the code is still stored');
  assert.equal(credential.passwordHash, 'h', 'the password was touched');
});

test('the email and code are matched loosely: case, spaces and dashes', async () => {
  adaHasPassword();
  const { code } = await requestCode('  Ada@Example.test ');
  const typed = ` ${code.slice(0, 4)}-${code.slice(4)} `;
  const result = await provider.signinWithCode('ADA@example.test', typed);
  assert.equal(result.signedIn, PERSON_ID);
});

test('a wrong code, or the right code with another email, is refused', async () => {
  adaHasPassword();
  const { code } = await requestCode();
  const wrong = code === '00000000' ? '00000001' : '00000000';
  assert.deepEqual(await provider.signinWithCode(EMAIL, wrong), REFUSED);
  assert.deepEqual(await provider.signinWithCode(NEW_EMAIL, code), REFUSED);
  assert.deepEqual(await provider.signinWithCode(EMAIL, ''), REFUSED);
  assert.deepEqual(await provider.signinWithCode(EMAIL, undefined), REFUSED);
  assert.deepEqual(await provider.signinWithCode('not-an-email', code), REFUSED);
  // the refusals did not use the code up
  assert.equal((await provider.signinWithCode(EMAIL, code)).signedIn, PERSON_ID);
});

test('a code works once', async () => {
  adaHasPassword();
  const { code } = await requestCode();
  assert.equal((await provider.signinWithCode(EMAIL, code)).signedIn, PERSON_ID);
  assert.deepEqual(await provider.signinWithCode(EMAIL, code), REFUSED);
});

test('an expired code is refused, and used up', async () => {
  adaHasPassword();
  const { code } = await requestCode();
  const [credential] = rowsOf(PERSON_ID);
  const expiresAt = new Date(credential.signinCodeExpiresAt).getTime();
  const issuedAt = expiresAt - DEFAULT_SIGNIN_CODE_TTL * 1000;
  assert.ok(Math.abs(issuedAt - Date.now()) < 5000, 'the code does not live for 15 minutes');
  credential.signinCodeExpiresAt = new Date(Date.now() - 1000).toISOString();
  assert.deepEqual(await provider.signinWithCode(EMAIL, code), REFUSED);
  assert.equal(rowsOf(PERSON_ID)[0].signinCode, undefined);
});

test('a second request replaces the first code', async () => {
  adaHasPassword();
  const first = await requestCode();
  let second = await requestCode();
  // the two codes could be equal by chance; then the first is the second
  while (second.code === first.code) second = await requestCode();
  assert.deepEqual(await provider.signinWithCode(EMAIL, first.code), REFUSED);
  assert.equal((await provider.signinWithCode(EMAIL, second.code)).signedIn, PERSON_ID);
});

test('a reset link and a code on one credential do not consume each other', async () => {
  adaHasPassword();
  const { code } = await requestCode();
  assert.equal(await provider.sendResetPasswordLink(EMAIL), true);
  const resetToken = sentEmails.at(-1).htmlbody.match(/reset-password\?token=([^'"&\s]+)/)[1];
  assert.equal((await provider.signinWithCode(EMAIL, code)).signedIn, PERSON_ID);
  assert.ok(rowsOf(PERSON_ID)[0].forgotPasswordToken, 'the reset token was removed');
  assert.ok(resetToken);
});

test('an email with no account gets the same answer, and its code creates the account', async () => {
  const { code } = await requestCode(NEW_EMAIL);
  // the code is held by a pending credential that no lookup by email finds
  const [pending] = [...credentials.rows.values()];
  assert.equal(pending.signinCodeEmailHash, hashToken(NEW_EMAIL));
  assert.ok(!JSON.stringify(pending).includes(NEW_EMAIL), 'the email is stored in plain text');
  assert.equal(pending.email, undefined);
  assert.equal(pending.credentialOf, undefined);

  const result = await provider.signinWithCode(NEW_EMAIL, code);
  assert.equal(result.signedIn, NEW_PERSON_ID);
  assert.equal(result.isNew, true);
  assert.deepEqual(
    people.created.map((p) => p.id),
    [NEW_PERSON_ID]
  );
  const account = accounts.created.at(-1);
  assert.equal(account.email, NEW_EMAIL);
  assert.equal(account.accountOf.id, NEW_PERSON_ID);
  const [credential] = rowsOf(NEW_PERSON_ID);
  assert.equal(credential.id, pending.id, 'the pending credential was not attached');
  assert.equal(credential.email, NEW_EMAIL);
  assert.equal(credential.signinCodeEmailHash, undefined);
  assert.ok(credential.emailVerifiedAt);
});

test('a second request for an email with no account reuses its pending credential', async () => {
  const first = await requestCode(NEW_EMAIL);
  let second = await requestCode(NEW_EMAIL);
  while (second.code === first.code) second = await requestCode(NEW_EMAIL);
  assert.equal(credentials.rows.size, 1);
  assert.deepEqual(await provider.signinWithCode(NEW_EMAIL, first.code), REFUSED);
  assert.equal((await provider.signinWithCode(NEW_EMAIL, second.code)).signedIn, NEW_PERSON_ID);
});

test('a pending code does not block a password signup for the email', async () => {
  await requestCode(NEW_EMAIL);
  mock.method(Auth, 'login', async (_provider, _find, create) => ({ created: await create() }));
  const result = await provider.createAccount({
    firstName: 'Grace',
    lastName: 'Hopper',
    email: NEW_EMAIL,
    password: 'long-enough',
  });
  assert.ok(result.created, `signup was refused: ${JSON.stringify(result)}`);
});

test('a pending code used after the email got an account elsewhere signs in to that account', async () => {
  const { code } = await requestCode(NEW_EMAIL);
  // meanwhile the email got a person and account that are not at its WebID (an older derivation)
  const elsewhere = 'https://app.test/person/grace';
  people.rows.push({ id: elsewhere, givenName: 'Grace' });
  accounts.rows.push({
    id: 'https://app.test/account/grace',
    email: NEW_EMAIL,
    accountOf: { id: elsewhere },
  });
  const result = await provider.signinWithCode(NEW_EMAIL, code);
  assert.equal(result.signedIn, elsewhere);
  assert.equal(result.account, 'https://app.test/account/grace');
  assert.equal(people.created.length, 0, 'a second person was created');
  assert.equal(rowsOf(elsewhere)[0].email, NEW_EMAIL);
});

test('a pending code used after the person was created at the WebID signs in to it', async () => {
  const { code } = await requestCode(NEW_EMAIL);
  people.rows.push({ id: NEW_PERSON_ID, givenName: 'Grace' });
  const result = await provider.signinWithCode(NEW_EMAIL, code);
  assert.equal(result.signedIn, NEW_PERSON_ID);
  assert.equal(people.created.length, 0, 'a second person was created');
});

test('a failed send for an email with no account leaves no working code', async () => {
  mock.method(LinkedEmail, 'send', async () => {
    throw new Error('provider down');
  });
  assert.equal(await provider.sendSigninCode(NEW_EMAIL), true);
  const [pending] = [...credentials.rows.values()];
  assert.equal(pending.signinCode, undefined);
});

test('a person found by the account email gets the code (WebID from an older derivation)', async () => {
  const legacyPerson = 'https://app.test/person/legacy';
  people.rows.push({ id: legacyPerson, givenName: 'Lin' });
  accounts.rows.push({
    id: 'https://app.test/account/lin',
    email: 'lin@example.test',
    accountOf: { id: legacyPerson },
  });
  const { code } = await requestCode('lin@example.test');
  assert.equal(rowsOf(legacyPerson).length, 1);
  const result = await provider.signinWithCode('lin@example.test', code);
  assert.equal(result.signedIn, legacyPerson);
  assert.equal(result.account, 'https://app.test/account/lin');
  assert.ok(rowsOf(legacyPerson)[0].emailVerifiedAt);
});

test('a new person gets the WebID of the configured derivation', async () => {
  const original = Auth.webIdFor;
  const { secret, issuer } = HMAC_WEBID_TEST_VECTOR;
  Auth.webIdFor = hmacWebIdFor({ secret, issuer });
  try {
    const { code } = await requestCode(NEW_EMAIL);
    const result = await provider.signinWithCode(NEW_EMAIL, code);
    assert.equal(result.signedIn, Auth.webIdFor(NEW_EMAIL));
    assert.ok(result.signedIn.startsWith(`${issuer}/id/`));
  } finally {
    Auth.webIdFor = original;
  }
});

test('requests are rate-limited by email, with the same answer for unknown emails', async () => {
  adaHasPassword();
  for (const email of [EMAIL, NEW_EMAIL]) {
    for (let i = 0; i < 3; i++) assert.equal(await provider.sendSigninCode(email), true);
    const limited = await provider.sendSigninCode(email);
    assert.equal(limited.action, 'rate_limited');
    assert.ok(limited.retryAfter > 0);
  }
});

test('checks are rate-limited by email, so a code cannot be guessed', async () => {
  adaHasPassword();
  const { code } = await requestCode();
  const wrong = code === '00000000' ? '00000001' : '00000000';
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(await provider.signinWithCode(EMAIL, wrong), REFUSED);
  }
  // the budget of this email is spent, from any address
  request.ip = '198.51.100.9';
  const limited = await provider.signinWithCode(EMAIL, code);
  assert.equal(limited.action, 'rate_limited');
});

test('with DEV_AUTH and no email provider, the code and link go to the log', async () => {
  process.env.DEV_AUTH = 'true';
  mock.method(LinkedEmail, 'hasDefaultProvider', () => false);
  adaHasPassword();
  assert.equal(await provider.sendSigninCode(EMAIL), true);
  assert.equal(sentEmails.length, 0);
  const line = infoLogs.find((l) => l.includes('signin-code link'));
  assert.ok(line, `no dev log line:\n${infoLogs.join('\n')}`);
  const match = line.match(
    /^\[@_linked\/auth\] dev: signin-code link: (\S+) \(code (\d{8})\)$/
  );
  assert.ok(match, `unexpected dev log line: ${line}`);
  assert.equal(new URL(match[1]).searchParams.get('code'), match[2]);
  assert.equal((await provider.signinWithCode(EMAIL, match[2])).signedIn, PERSON_ID);
});

test('a code whose email could not be sent is removed again', async () => {
  adaHasPassword();
  mock.method(LinkedEmail, 'send', async () => {
    throw new Error('provider down');
  });
  assert.equal(await provider.sendSigninCode(EMAIL), true);
  assert.equal(rowsOf(PERSON_ID)[0].signinCode, undefined);
});
