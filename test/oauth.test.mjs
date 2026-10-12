// signinOAuth only signs in with providers whose token the server verifies itself, and only
// reaches an existing account by email when that cannot hand it to someone else.
//
// Runs against the BUILT package in lib/ (build first: `npx linked build`). No network and no
// store: the token helpers, the identity-link store and `Auth.login` are stubbed, so these tests
// only check which inputs are allowed to reach which account. The same flows run against a real
// store in test/integration/oauth.fuseki.test.mjs.
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeCredentialTable } from './fakeStore.mjs';

process.env.NODE_ENV = 'test';
process.env.SITE_ROOT = 'https://app.test';
process.env.JWT_SECRET = 'unit-test-secret-unit-test-secret';
process.env.SESSION_SECRET = 'unit-test-session-secret';

// connect-sqlite3 (express-session store) writes into <cwd>/data
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-auth-test-'));
fs.mkdirSync(path.join(workDir, 'data'));
process.chdir(workDir);
process.on('exit', () => fs.rmSync(workDir, { recursive: true, force: true }));

const libDir = new URL('../lib/esm/', import.meta.url);
const { Auth } = await import(new URL('utils/auth.js', libDir));
const { default: AppleHelper } = await import(new URL('helpers/apple.js', libDir));
const { default: GoogleHelper } = await import(new URL('helpers/google.js', libDir));
const { default: AuthBackendProvider } = await import(new URL('backend.js', libDir));
const { emailToWebID } = await import(new URL('utils/webID.js', libDir));
const { OAuthIdentityStore } = await import(new URL('utils/oauthIdentities.js', libDir));
const { AuthCredential } = await import(new URL('shapes/AuthCredential.js', libDir));
const { decideEmailMatchedAccount, providerOfIdentityLink } = await import(
  new URL('helpers/oauth-account.js', libDir)
);

const fakeLincdServer = { callGenericBackendProvidersMethod: async () => {} };
const SIGNED_IN = { user: { id: 'https://id.test/person/x' }, userAccount: { id: 'acc' } };

let provider;
let login;
let onSignin;
let createLink;
// what the stubbed store holds
let links;
let existingAccount;
let existingPerson;
let personHasPassword;
let linkedProviders;
let lookedUpWebID;

beforeEach(() => {
  provider = new AuthBackendProvider(null, fakeLincdServer);
  login = mock.method(Auth, 'login', async () => SIGNED_IN);
  onSignin = mock.method(Auth, 'onSigninSuccessful', async () => SIGNED_IN);
  mock.method(console, 'log', () => {});
  mock.method(console, 'error', () => {});
  mock.method(console, 'warn', () => {});
  links = [];
  existingAccount = null;
  existingPerson = null;
  personHasPassword = false;
  linkedProviders = [];
  lookedUpWebID = undefined;
  mock.method(OAuthIdentityStore, 'findLinks', async () => links);
  mock.method(OAuthIdentityStore, 'personHasPassword', async () => personHasPassword);
  mock.method(OAuthIdentityStore, 'findLinkedProviders', async () => linkedProviders);
  mock.method(OAuthIdentityStore, 'upgradeLegacyLink', async () => {});
  createLink = mock.method(OAuthIdentityStore, 'createLink', async () => {});
  provider.accountShape = {
    select: () => ({
      where: (filter) => {
        filter({ accountOf: { equals: (node) => (lookedUpWebID = node.id) } });
        return { one: async () => existingAccount };
      },
      for: async (node) => (existingAccount?.id === node.id ? existingAccount : null),
    }),
  };
  provider.userShape = { select: () => ({ for: async () => existingPerson }) };
});

afterEach(() => {
  mock.restoreAll();
});

/** The label `Auth.login` was called with, one per call. */
const loginLabels = () => login.mock.calls.map((call) => call.arguments[3]);


test('facebook with a client-supplied email is rejected and never reaches login', async () => {
  const result = await provider.signinOAuth('facebook', {
    email: 'victim@example.test',
    name: 'Victim',
  });
  assert.equal(login.mock.callCount(), 0, `login was called: ${JSON.stringify(loginLabels())}`);
  assert.ok(result?.error, `expected an error, got ${JSON.stringify(result)}`);
});

test('an unknown provider is rejected and never reaches login', async () => {
  const result = await provider.signinOAuth('github', { email: 'victim@example.test' });
  assert.equal(login.mock.callCount(), 0, `login was called: ${JSON.stringify(loginLabels())}`);
  assert.ok(result?.error, `expected an error, got ${JSON.stringify(result)}`);
});

test('a missing provider is rejected and never reaches login', async () => {
  const result = await provider.signinOAuth(undefined, { email: 'victim@example.test' });
  assert.equal(login.mock.callCount(), 0, `login was called: ${JSON.stringify(loginLabels())}`);
  assert.ok(result?.error, `expected an error, got ${JSON.stringify(result)}`);
});

test('google signs in with the email from the verified ID token, not the client', async () => {
  const validate = mock.method(GoogleHelper, 'validateIdToken', async () => ({
    sub: 'g-1',
    email: 'ada@example.test',
    email_verified: true,
    name: 'Ada Lovelace',
    given_name: 'Ada',
    family_name: 'Lovelace',
  }));
  const result = await provider.signinOAuth('google', {
    email: 'victim@example.test',
    authentication: { idToken: 'google-id-token' },
  });
  assert.equal(validate.mock.calls[0].arguments[0], 'google-id-token');
  assert.deepEqual(loginLabels(), ['google OAuth']);
  assert.equal(lookedUpWebID, emailToWebID('ada@example.test'));
  assert.equal(result, SIGNED_IN);
});

test('google without an ID token is rejected', async () => {
  const result = await provider.signinOAuth('google', { email: 'victim@example.test' });
  assert.deepEqual(result, { error: 'No Google ID token provided' });
  assert.equal(login.mock.callCount(), 0);
});

test('google with an invalid ID token is rejected', async () => {
  mock.method(GoogleHelper, 'validateIdToken', async () => null);
  const result = await provider.signinOAuth('google', {
    email: 'victim@example.test',
    authentication: { idToken: 'bad' },
  });
  assert.deepEqual(result, { error: 'Invalid Google ID token' });
  assert.equal(login.mock.callCount(), 0);
});

test('apple signs in with the email from the verified identity token, not the client', async () => {
  const decode = mock.method(AppleHelper, 'decodeIdentityToken', async () => ({
    email: 'ada@example.test',
    sub: '001234.abcdef.0001',
  }));
  const result = await provider.signinOAuth('apple', {
    email: 'victim@example.test',
    identityToken: 'apple-identity-token',
  });
  assert.equal(decode.mock.calls[0].arguments[0], 'apple-identity-token');
  assert.deepEqual(loginLabels(), ['apple OAuth']);
  assert.equal(lookedUpWebID, emailToWebID('ada@example.test'));
  assert.equal(result, SIGNED_IN);
});

test('apple without an identity token is rejected', async () => {
  const result = await provider.signinOAuth('apple', { email: 'victim@example.test' });
  assert.deepEqual(result, { error: 'No Apple identity token provided' });
  assert.equal(login.mock.callCount(), 0);
});

test('apple with an invalid identity token is rejected', async () => {
  mock.method(AppleHelper, 'decodeIdentityToken', async () => null);
  const result = await provider.signinOAuth('apple', {
    email: 'victim@example.test',
    identityToken: 'bad',
  });
  assert.deepEqual(result, { error: 'Invalid Apple identity token' });
  assert.equal(login.mock.callCount(), 0);
});

const GOOGLE = { authentication: { idToken: 'google-id-token' } };
function verifiedGoogle(email = 'ada@example.test', sub = 'g-1') {
  mock.method(GoogleHelper, 'validateIdToken', async () => ({
    sub,
    email,
    email_verified: true,
    given_name: 'Ada',
  }));
}
const ADA_WEBID = emailToWebID('ada@example.test');
const ADA_ACCOUNT = { id: 'https://app.test/account/ada', accountOf: { id: ADA_WEBID } };

test('a linked identity signs in to its account without looking at the email', async () => {
  verifiedGoogle('someone-else@example.test');
  links = [{ id: 'link-1', accountId: ADA_ACCOUNT.id, legacy: false }];
  existingAccount = ADA_ACCOUNT;
  const result = await provider.signinOAuth('google', GOOGLE);
  assert.equal(result, SIGNED_IN);
  assert.equal(onSignin.mock.calls[0].arguments[2], ADA_ACCOUNT);
  assert.equal(lookedUpWebID, undefined, 'the email was not consulted');
  assert.equal(login.mock.callCount(), 0);
});

test('an Apple identity whose token has no email signs in through its link', async () => {
  mock.method(AppleHelper, 'decodeIdentityToken', async () => ({ sub: 'apple-1', email: undefined }));
  links = [{ id: 'legacy-1', accountId: ADA_ACCOUNT.id, legacy: true }];
  existingAccount = ADA_ACCOUNT;
  const result = await provider.signinOAuth('apple', { identityToken: 'apple-token' });
  assert.equal(result, SIGNED_IN);
  assert.equal(OAuthIdentityStore.upgradeLegacyLink.mock.callCount(), 1, 'legacy link upgraded');
});

test('an identity linked to several accounts fails closed', async () => {
  verifiedGoogle();
  links = [
    { id: 'l1', accountId: 'acc-1', legacy: false },
    { id: 'l2', accountId: 'acc-2', legacy: false },
  ];
  const result = await provider.signinOAuth('google', GOOGLE);
  assert.ok(result.error);
  assert.equal(onSignin.mock.callCount() + login.mock.callCount(), 0);
});

test('a verified email does NOT reach an existing account that has a password', async () => {
  // pre-account hijacking: someone registered a password account for this address in advance
  verifiedGoogle();
  existingAccount = ADA_ACCOUNT;
  personHasPassword = true;
  const result = await provider.signinOAuth('google', GOOGLE);
  assert.equal(result.action, 'sign_in_to_link');
  assert.ok(result.error);
  assert.equal(onSignin.mock.callCount() + login.mock.callCount(), 0);
  assert.equal(createLink.mock.callCount(), 0);
});

test('a verified email does NOT reach a password person that has no account here yet', async () => {
  verifiedGoogle();
  existingPerson = { id: ADA_WEBID };
  personHasPassword = true;
  const result = await provider.signinOAuth('google', GOOGLE);
  assert.equal(result.action, 'sign_in_to_link');
  assert.equal(onSignin.mock.callCount() + login.mock.callCount(), 0);
});

test('a verified email attaches to an OAuth-only account and links the identity', async () => {
  verifiedGoogle();
  existingAccount = ADA_ACCOUNT;
  linkedProviders = ['apple'];
  const result = await provider.signinOAuth('google', GOOGLE);
  assert.equal(result, SIGNED_IN);
  assert.equal(createLink.mock.callCount(), 1);
  const [identity, accountId] = createLink.mock.calls[0].arguments;
  assert.deepEqual([identity.provider, identity.subject, accountId], ['google', 'g-1', ADA_ACCOUNT.id]);
});

test('a second identity at the same provider is not attached by email', async () => {
  verifiedGoogle('ada@example.test', 'g-2');
  existingAccount = ADA_ACCOUNT;
  linkedProviders = ['google'];
  const result = await provider.signinOAuth('google', GOOGLE);
  assert.equal(result.action, 'sign_in_to_link');
});

test('a new identity creates an account and links it', async () => {
  verifiedGoogle();
  const result = await provider.signinOAuth('google', GOOGLE);
  assert.equal(result, SIGNED_IN);
  assert.deepEqual(loginLabels(), ['google OAuth']);
});

// ---- the provider's verified email verifies the person's email ----

/** The credentials of a person in an in-memory table installed for `AuthCredential`. */
function credentialsOf(table, personId) {
  return [...table.rows.values()].filter((row) => row.credentialOf?.id === personId);
}

test('a new OAuth user gets a credential whose email is already verified', async () => {
  const table = fakeCredentialTable();
  table.install(AuthCredential);
  verifiedGoogle();
  provider.userShape = { ...provider.userShape, create: async (data) => ({ id: data.__id }) };
  provider.accountShape = { ...provider.accountShape, create: async () => ({ id: 'acc-new' }) };
  await provider.signinOAuth('google', GOOGLE);
  assert.deepEqual(loginLabels(), ['google OAuth']);
  // run the create step Auth.login was handed
  await login.mock.calls[0].arguments[2]();
  const [credential] = credentialsOf(table, ADA_WEBID);
  assert.ok(credential, 'a credential was created');
  assert.equal(credential.email, 'ada@example.test');
  assert.ok(credential.emailVerifiedAt, 'emailVerifiedAt is set');
  assert.equal(credential.passwordHash, undefined);
});

test('a linked sign-in whose verified email maps to the person marks the email verified', async () => {
  const table = fakeCredentialTable();
  table.install(AuthCredential);
  table.insert({ credentialOf: { id: ADA_WEBID }, email: 'ada@example.test' });
  verifiedGoogle('Ada@Example.test');
  links = [{ id: 'link-1', accountId: ADA_ACCOUNT.id, legacy: false }];
  existingAccount = ADA_ACCOUNT;
  assert.equal(await provider.signinOAuth('google', GOOGLE), SIGNED_IN);
  assert.ok(credentialsOf(table, ADA_WEBID)[0].emailVerifiedAt);
});

test('a linked sign-in whose email is another address does not mark the email verified', async () => {
  const table = fakeCredentialTable();
  table.install(AuthCredential);
  table.insert({ credentialOf: { id: ADA_WEBID }, email: 'ada@example.test' });
  verifiedGoogle('someone-else@example.test');
  links = [{ id: 'link-1', accountId: ADA_ACCOUNT.id, legacy: false }];
  existingAccount = ADA_ACCOUNT;
  assert.equal(await provider.signinOAuth('google', GOOGLE), SIGNED_IN);
  assert.equal(credentialsOf(table, ADA_WEBID)[0].emailVerifiedAt, undefined);
  assert.equal(credentialsOf(table, ADA_WEBID).length, 1);
});

test('a verified email attached to an OAuth-only account marks the email verified', async () => {
  const table = fakeCredentialTable();
  table.install(AuthCredential);
  table.insert({ credentialOf: { id: ADA_WEBID }, email: 'ada@example.test' });
  verifiedGoogle();
  existingAccount = ADA_ACCOUNT;
  linkedProviders = ['apple'];
  assert.equal(await provider.signinOAuth('google', GOOGLE), SIGNED_IN);
  assert.ok(credentialsOf(table, ADA_WEBID)[0].emailVerifiedAt);
});

test('linkOAuthIdentity needs a signed-in account', async () => {
  verifiedGoogle();
  const result = await provider.linkOAuthIdentity('google', GOOGLE);
  assert.ok(result.error);
  assert.equal(createLink.mock.callCount(), 0);
});

test('linkOAuthIdentity rejects an unverified provider', async () => {
  const { serving } = await import('./serving.mjs');
  const p = serving(provider, { headers: {}, cookies: {}, linkedAuth: { userAccount: ADA_ACCOUNT } });
  const result = await p.linkOAuthIdentity('facebook', { accessToken: 'x', email: 'ada@example.test' });
  assert.ok(result.error);
  assert.equal(createLink.mock.callCount(), 0);
});

test('linkOAuthIdentity links a verified identity to the signed-in account', async () => {
  const { serving } = await import('./serving.mjs');
  verifiedGoogle('other@example.test', 'g-9');
  const p = serving(provider, { headers: {}, cookies: {}, linkedAuth: { userAccount: ADA_ACCOUNT } });
  assert.deepEqual(await p.linkOAuthIdentity('google', GOOGLE), { linked: true });
  assert.equal(createLink.mock.calls[0].arguments[1], ADA_ACCOUNT.id);
});

test('linkOAuthIdentity refuses an identity linked to another account', async () => {
  const { serving } = await import('./serving.mjs');
  verifiedGoogle();
  links = [{ id: 'l1', accountId: 'someone-else', legacy: false }];
  const p = serving(provider, { headers: {}, cookies: {}, linkedAuth: { userAccount: ADA_ACCOUNT } });
  const result = await p.linkOAuthIdentity('google', GOOGLE);
  assert.ok(result.error);
  assert.equal(createLink.mock.callCount(), 0);
});

test('decideEmailMatchedAccount: each rule', () => {
  const decide = (provider, emailVerified, existing) =>
    decideEmailMatchedAccount({ provider, emailVerified, existing });
  const none = { hasPassword: false, linkedProviders: [] };
  assert.deepEqual(decide('google', true, none), { link: true });
  assert.deepEqual(decide('apple', true, { hasPassword: false, linkedProviders: ['google'] }), { link: true });
  assert.equal(decide('google', false, none).action, 'sign_in_to_link');
  assert.equal(decide('facebook', true, none).action, 'sign_in_to_link');
  assert.equal(decide('google', true, { hasPassword: true, linkedProviders: [] }).action, 'sign_in_to_link');
  assert.equal(decide('google', true, { hasPassword: false, linkedProviders: ['google'] }).action, 'sign_in_to_link');
  assert.equal(decide('google', true, { hasPassword: false, linkedProviders: ['facebook'] }).action, 'sign_in_to_link');
});

test('providerOfIdentityLink: a row without a provider is a legacy Apple link', () => {
  assert.equal(providerOfIdentityLink({ sub: 's', identityProvider: 'google' }), 'google');
  assert.equal(providerOfIdentityLink({ sub: 's' }), 'apple');
  assert.equal(providerOfIdentityLink({ sub: 's', identityProvider: 'github' }), undefined);
  assert.equal(providerOfIdentityLink({}), undefined);
});
