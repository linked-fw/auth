// Credentials and account removal against a REAL graph store.
//
// Needs a Fuseki server (see fuseki.mjs). Runs against the BUILT package in lib/ (build first).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { serving } from '../serving.mjs';
import { useThrowawayDataset, countSubjectsWith, sparql, AUTH } from './fuseki.mjs';

process.env.NODE_ENV = 'test';
process.env.SITE_ROOT = 'https://app.test';
process.env.JWT_SECRET = 'integration-test-secret-integration';
process.env.SESSION_SECRET = 'integration-test-session-secret';
process.env.AUTH_SESSION_CLEANUP = 'false';
process.env.DATA_ROOT = 'https://data.app.test';

const libDir = new URL('../../lib/esm/', import.meta.url);
await import(new URL('shapes/index.js', libDir));
const { default: AuthBackendProvider } = await import(new URL('backend.js', libDir));
const { AuthCredential } = await import(new URL('shapes/AuthCredential.js', libDir));
const { IdentityToken } = await import(new URL('shapes/IdentityToken.js', libDir));
const { default: PasswordHelper } = await import(new URL('helpers/password.js', libDir));
const { LinkedEmail } = await import('@_linked/server-utils/utils/LinkedEmail');

const fakeLincdServer = { callGenericBackendProvidersMethod: async () => {} };

useThrowawayDataset();

function provider(request = { headers: {}, cookies: {} }) {
  request.headers = { 'x-linked-auth-transport': 'body', ...request.headers };
  return serving(new AuthBackendProvider(null, fakeLincdServer), request);
}

async function signedInProvider(accessToken) {
  const request = { headers: { authorization: `Bearer ${accessToken}` }, cookies: {} };
  const p = provider(request);
  assert.ok(await p.validateRequestToken(request), 'access token accepted');
  return p;
}

/** Every node that still carries this email or subject, with its type: orphans included. */
async function nodesCarrying(value) {
  const rows = await sparql(`
    SELECT DISTINCT ?s ?type WHERE {
      { ?s ?p "${value}" OPTIONAL { ?s a ?type } }
      UNION { GRAPH ?g { ?s ?p "${value}" OPTIONAL { ?s a ?type } } }
    }`);
  return rows.map((row) => `${row.s.value} (${row.type?.value ?? 'no type'})`);
}

const newEmail = () => `ada-${crypto.randomBytes(4).toString('hex')}@example.test`;
const PASSWORD_1 = 'first-Passw0rd!';
const PASSWORD_2 = 'second-Passw0rd!';

test('password sign-in uses the credential that has a password when a person has several', async () => {
  const email = newEmail();
  const created = await provider().createAccount({ firstName: 'Ada', email, password: PASSWORD_1 });
  assert.equal(created.error, undefined, created.error);
  const personId = created.auth.user.id;
  // A credential row without a hash, as OAuth sign-in and older releases leave behind. Several
  // of them, so the store cannot happen to return the hashed row first.
  for (let i = 0; i < 3; i++) {
    await AuthCredential.create({ credentialOf: { id: personId }, email });
  }
  assert.equal(await countSubjectsWith(`${AUTH}credentialOf`, personId), 4);

  for (let i = 0; i < 3; i++) {
    const signin = await provider().signinWithPassword(email, PASSWORD_1);
    assert.equal(signin.error, undefined, `sign-in ${i + 1}: ${signin.error}`);
  }
  const credential = await provider().getPasswordForUser({ id: personId });
  assert.ok(credential?.passwordHash, 'getPasswordForUser returns the row with the hash');
});

test('removeAccount deletes every credential and identity token of the account', async () => {
  const email = newEmail();
  const created = await provider().createAccount({ firstName: 'Ada', email, password: PASSWORD_1 });
  assert.equal(created.error, undefined, created.error);
  const personId = created.auth.user.id;
  const accountId = created.auth.userAccount.id;
  await AuthCredential.create({ credentialOf: { id: personId }, email });
  await AuthCredential.create({
    credentialOf: { id: personId },
    email,
    passwordHash: await PasswordHelper.generateHashedPassword('leftover-Passw0rd!'),
  });
  await IdentityToken.create({ sub: 'apple-sub-1', email, account: { id: accountId } });
  assert.equal(await countSubjectsWith(`${AUTH}credentialOf`, personId), 3);
  assert.equal(await countSubjectsWith(`${AUTH}account`, accountId) > 0, true);

  const p = await signedInProvider(created.accessToken);
  assert.equal(await p.removeAccount(), true);

  assert.equal(await countSubjectsWith(`${AUTH}credentialOf`, personId), 0, 'credentials left');
  assert.equal(await countSubjectsWith(`${AUTH}account`, accountId), 0, 'identity tokens or sessions left');
  // Deleting the person and the account also removes the links pointing at them, which leaves
  // the credential and identity token nodes behind, unreachable but still holding the email,
  // password hashes and subject. Nothing may remain.
  assert.deepEqual(await nodesCarrying(email), [], 'nodes still holding the email');
  assert.deepEqual(await nodesCarrying('apple-sub-1'), [], 'nodes still holding the subject');

  // The same email gives the same WebID: a new account must not inherit an old password.
  const again = await provider().createAccount({ firstName: 'Ada', email, password: PASSWORD_2 });
  assert.equal(again.error, undefined, again.error);
  assert.ok((await provider().signinWithPassword(email, 'leftover-Passw0rd!')).error);
  assert.ok((await provider().signinWithPassword(email, PASSWORD_1)).error);
  assert.equal((await provider().signinWithPassword(email, PASSWORD_2)).error, undefined);
});

test('signup emails a verification link; verifying it shows in the next refresh', async () => {
  const sent = [];
  const send = mock.method(LinkedEmail, 'send', async (options) => sent.push(options));
  try {
    const email = newEmail();
    const created = await provider().createAccount({ firstName: 'Ada', email, password: PASSWORD_1 });
    assert.equal(created.error, undefined, created.error);
    assert.equal(created.auth.emailVerified, false);
    assert.equal(sent.length, 1, 'a verification email was sent');
    const token = decodeURIComponent(sent[0].htmlbody.match(/verify-email\?token=([^'"&\s]+)/)[1]);

    assert.deepEqual(await provider().verifyEmail(token), { verified: true });
    assert.equal((await provider().verifyEmail(token)).action, 'resend_verification', 'single-use');

    const refreshed = await provider().validateToken(created.refreshToken);
    assert.equal(refreshed.error, undefined, refreshed.error);
    assert.equal(refreshed.auth.emailVerified, true);
    const rows = await AuthCredential.select((c) => [
      c.emailVerificationToken,
      c.emailVerifiedAt,
    ]).where((c) => c.credentialOf.equals({ id: created.auth.user.id }));
    assert.equal(rows.length, 1);
    assert.ok(rows[0].emailVerifiedAt, 'emailVerifiedAt is stored');
    assert.ok(!rows[0].emailVerificationToken, 'no verification token left');
  } finally {
    send.mock.restore();
  }
});
