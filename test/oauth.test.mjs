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
let removeLink;
let recordLinkEmail;
// what the stubbed store holds
let links;
let existingAccount;
let existingPerson;
let personHasPassword;
let linkedProviders;
let lookedUpWebID;
let credentialTable;

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
  removeLink = mock.method(OAuthIdentityStore, 'removeLink', async () => {});
  recordLinkEmail = mock.method(OAuthIdentityStore, 'recordLinkEmail', async () => {});
  credentialTable = fakeCredentialTable();
  credentialTable.install(AuthCredential);
  provider.accountShape = {
    select: () => ({
      where: (filter) => {
        let matches = true;
        filter({
          accountOf: {
            equals: (node) => {
              lookedUpWebID = node.id;
              matches = existingAccount?.accountOf?.id === node.id;
            },
          },
          email: {
            equals: (email) => {
              matches = existingAccount?.email === email;
            },
          },
        });
        const result = () => (matches && existingAccount ? [existingAccount] : []);
        return {
          one: async () => result()[0] ?? null,
          then: (resolve, reject) => Promise.resolve(result()).then(resolve, reject),
        };
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
const LEGACY_ADA_ACCOUNT = {
  id: 'https://app.test/account/legacy-ada',
  email: 'ada@example.test',
  accountOf: { id: 'https://legacy.example.test/person/ada' },
};

test('a linked identity signs in to its account while it keeps the email it was linked with', async () => {
  // a link recorded with an address other than the account's (an explicit linkOAuthIdentity)
  verifiedGoogle('someone-else@example.test');
  links = [{ id: 'link-1', accountId: ADA_ACCOUNT.id, legacy: false, email: 'someone-else@example.test' }];
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

test('Google attaches to an OAuth-only legacy account found by account email', async () => {
  verifiedGoogle();
  existingAccount = LEGACY_ADA_ACCOUNT;
  const result = await provider.signinOAuth('google', GOOGLE);
  assert.equal(result, SIGNED_IN);
  assert.equal(createLink.mock.calls[0].arguments[1], LEGACY_ADA_ACCOUNT.id);
  assert.equal(login.mock.callCount(), 0, 'a duplicate canonical account was created');
});

test('Apple attaches to an OAuth-only legacy account found by account email', async () => {
  mock.method(AppleHelper, 'decodeIdentityToken', async () => ({
    email: 'ada@example.test',
    sub: 'apple-legacy-ada',
  }));
  existingAccount = LEGACY_ADA_ACCOUNT;
  const result = await provider.signinOAuth('apple', { identityToken: 'apple-token' });
  assert.equal(result, SIGNED_IN);
  assert.equal(createLink.mock.calls[0].arguments[1], LEGACY_ADA_ACCOUNT.id);
  assert.equal(login.mock.callCount(), 0, 'a duplicate canonical account was created');
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

// ---- one verified email, one account; the email decides, not the provider's subject ----

/** Let the create step `Auth.login` is handed run against stubs. */
function allowNewAccounts() {
  provider.userShape = { ...provider.userShape, create: async (data) => ({ id: data.__id }) };
  provider.accountShape = { ...provider.accountShape, create: async () => ({ id: 'acc-new' }) };
}

/** Ada's person has a verified email (and, when `password`, a password). */
function adaVerified({ password = false } = {}) {
  credentialTable.insert({
    credentialOf: { id: ADA_WEBID },
    email: 'ada@example.test',
    emailVerifiedAt: new Date(),
    ...(password ? { passwordHash: 'hash' } : {}),
  });
  personHasPassword = password;
}

test('a verified Google email reaches the password account whose email is verified', async () => {
  verifiedGoogle();
  existingAccount = ADA_ACCOUNT;
  adaVerified({ password: true });
  const result = await provider.signinOAuth('google', GOOGLE);
  assert.equal(result, SIGNED_IN);
  assert.equal(onSignin.mock.calls[0].arguments[2], ADA_ACCOUNT);
  assert.equal(login.mock.callCount(), 0, 'no second account');
  const [identity, accountId] = createLink.mock.calls[0].arguments;
  assert.deepEqual([identity.subject, accountId], ['g-1', ADA_ACCOUNT.id]);
});

test('a verified email reaches a verified account already linked to another identity at the provider', async () => {
  verifiedGoogle('ada@example.test', 'g-2');
  existingAccount = ADA_ACCOUNT;
  linkedProviders = ['google'];
  adaVerified({ password: true });
  assert.equal(await provider.signinOAuth('google', GOOGLE), SIGNED_IN);
  assert.equal(createLink.mock.calls[0].arguments[1], ADA_ACCOUNT.id);
});

test('an unverified provider email never reaches the verified account', async () => {
  mock.method(GoogleHelper, 'validateIdToken', async () => ({
    sub: 'g-1',
    email: 'ada@example.test',
    email_verified: false,
  }));
  existingAccount = ADA_ACCOUNT;
  adaVerified({ password: true });
  const result = await provider.signinOAuth('google', GOOGLE);
  assert.ok(result.error);
  assert.equal(onSignin.mock.callCount() + login.mock.callCount(), 0);
  assert.equal(createLink.mock.callCount(), 0);
});

test('a different verified email gets a new account, never the existing one', async () => {
  verifiedGoogle('grace@example.test');
  existingAccount = ADA_ACCOUNT;
  adaVerified({ password: true });
  const result = await provider.signinOAuth('google', GOOGLE);
  assert.equal(result, SIGNED_IN);
  assert.equal(onSignin.mock.callCount(), 0, 'signed in to an existing account');
  assert.deepEqual(loginLabels(), ['google OAuth']);
  assert.equal(createLink.mock.callCount(), 0, 'linked to the existing account');
});

test('a linked identity whose email changed no longer signs in to the old account', async () => {
  verifiedGoogle('ada-renamed@example.test');
  const link = { id: 'link-1', accountId: ADA_ACCOUNT.id, legacy: false, email: 'ada@example.test' };
  links = [link];
  existingAccount = ADA_ACCOUNT;
  adaVerified();
  allowNewAccounts();
  const result = await provider.signinOAuth('google', GOOGLE);
  assert.equal(result, SIGNED_IN);
  assert.equal(onSignin.mock.callCount(), 0, 'signed in to the old account');
  assert.deepEqual(loginLabels(), ['google OAuth'], 'continued by the new email');
  assert.equal(removeLink.mock.callCount(), 0, 'removed before the new account exists');
  await login.mock.calls[0].arguments[2]();
  assert.deepEqual(removeLink.mock.calls.map((c) => c.arguments[0]), [link]);
  assert.equal(createLink.mock.callCount(), 1);
});

test('a changed email whose new address is refused keeps the old link', async () => {
  // the new address belongs to a password account whose email is not verified
  verifiedGoogle('grace@example.test');
  links = [{ id: 'link-1', accountId: ADA_ACCOUNT.id, legacy: false, email: 'ada@example.test' }];
  existingAccount = ADA_ACCOUNT;
  const graceAccount = { id: 'https://app.test/account/grace', email: 'grace@example.test', accountOf: { id: emailToWebID('grace@example.test') } };
  const select = provider.accountShape.select;
  provider.accountShape = {
    select: () => {
      const query = select();
      return {
        where: (filter) => {
          let byGrace = false;
          filter({
            accountOf: { equals: (node) => (byGrace = node.id === graceAccount.accountOf.id) },
            email: { equals: (email) => (byGrace = email === 'grace@example.test') },
          });
          const rows = byGrace ? [graceAccount] : [];
          return { one: async () => rows[0] ?? null, then: (res, rej) => Promise.resolve(rows).then(res, rej) };
        },
        for: query.for,
      };
    },
  };
  personHasPassword = true;
  const result = await provider.signinOAuth('google', GOOGLE);
  assert.equal(result.action, 'sign_in_to_link');
  assert.equal(onSignin.mock.callCount() + login.mock.callCount(), 0);
  assert.equal(removeLink.mock.callCount(), 0, 'the link was removed by a refused sign-in');
});

test('a link from an earlier release whose email resolves ambiguously is followed, not removed', async () => {
  verifiedGoogle();
  links = [{ id: 'link-1', accountId: LEGACY_ADA_ACCOUNT.id, legacy: false }];
  existingAccount = LEGACY_ADA_ACCOUNT;
  existingPerson = { id: ADA_WEBID }; // a second person for the same email: a conflict
  assert.equal(await provider.signinOAuth('google', GOOGLE), SIGNED_IN);
  assert.equal(onSignin.mock.calls[0].arguments[2], LEGACY_ADA_ACCOUNT);
  assert.equal(removeLink.mock.callCount(), 0);
  assert.equal(recordLinkEmail.mock.callCount(), 0, 'an ambiguous email was recorded');
});

test('a link from an earlier release is followed when the email gives no WebID', async () => {
  verifiedGoogle();
  links = [{ id: 'link-1', accountId: ADA_ACCOUNT.id, legacy: false }];
  existingAccount = ADA_ACCOUNT;
  // an accessor (shared by every copy of the module), so assigned rather than mocked
  const webIdFor = Auth.webIdFor;
  Auth.webIdFor = () => {
    throw new Error('no WebID for this email');
  };
  try {
    assert.equal(await provider.signinOAuth('google', GOOGLE), SIGNED_IN);
    assert.equal(onSignin.mock.calls[0].arguments[2], ADA_ACCOUNT);
    assert.equal(removeLink.mock.callCount(), 0);
  } finally {
    Auth.webIdFor = webIdFor;
  }
});

test('a link from an earlier release follows the email: kept and recorded when it still matches', async () => {
  verifiedGoogle('Ada@Example.test');
  const link = { id: 'link-1', accountId: ADA_ACCOUNT.id, legacy: false };
  links = [link];
  existingAccount = ADA_ACCOUNT;
  assert.equal(await provider.signinOAuth('google', GOOGLE), SIGNED_IN);
  assert.equal(onSignin.mock.calls[0].arguments[2], ADA_ACCOUNT);
  assert.deepEqual(recordLinkEmail.mock.calls[0].arguments, [link, 'Ada@Example.test']);
  assert.equal(removeLink.mock.callCount(), 0);
});

test('a link from an earlier release whose email no longer reaches its account is removed', async () => {
  verifiedGoogle('someone-else@example.test');
  links = [{ id: 'link-1', accountId: ADA_ACCOUNT.id, legacy: false }];
  existingAccount = ADA_ACCOUNT;
  allowNewAccounts();
  const result = await provider.signinOAuth('google', GOOGLE);
  assert.equal(result, SIGNED_IN);
  assert.equal(onSignin.mock.callCount(), 0, 'signed in to the old account');
  assert.deepEqual(loginLabels(), ['google OAuth']);
  await login.mock.calls[0].arguments[2]();
  assert.equal(removeLink.mock.callCount(), 1);
});

// ---- the provider's verified email verifies the person's email ----

/** The credentials of a person in an in-memory table installed for `AuthCredential`. */
function credentialsOf(table, personId) {
  return [...table.rows.values()].filter((row) => row.credentialOf?.id === personId);
}

test('a new OAuth user gets a credential whose email is already verified', async () => {
  verifiedGoogle();
  provider.userShape = { ...provider.userShape, create: async (data) => ({ id: data.__id }) };
  provider.accountShape = { ...provider.accountShape, create: async () => ({ id: 'acc-new' }) };
  await provider.signinOAuth('google', GOOGLE);
  assert.deepEqual(loginLabels(), ['google OAuth']);
  // run the create step Auth.login was handed
  await login.mock.calls[0].arguments[2]();
  const [credential] = credentialsOf(credentialTable, ADA_WEBID);
  assert.ok(credential, 'a credential was created');
  assert.equal(credential.email, 'ada@example.test');
  assert.ok(credential.emailVerifiedAt, 'emailVerifiedAt is set');
  assert.equal(credential.passwordHash, undefined);
});

test('a linked sign-in whose verified email maps to the person marks the email verified', async () => {
  credentialTable.insert({ credentialOf: { id: ADA_WEBID }, email: 'ada@example.test' });
  verifiedGoogle('Ada@Example.test');
  links = [{ id: 'link-1', accountId: ADA_ACCOUNT.id, legacy: false }];
  existingAccount = ADA_ACCOUNT;
  assert.equal(await provider.signinOAuth('google', GOOGLE), SIGNED_IN);
  assert.ok(credentialsOf(credentialTable, ADA_WEBID)[0].emailVerifiedAt);
});

test('a linked sign-in whose email is another address does not mark the email verified', async () => {
  credentialTable.insert({ credentialOf: { id: ADA_WEBID }, email: 'ada@example.test' });
  verifiedGoogle('someone-else@example.test');
  links = [{ id: 'link-1', accountId: ADA_ACCOUNT.id, legacy: false, email: 'someone-else@example.test' }];
  existingAccount = ADA_ACCOUNT;
  assert.equal(await provider.signinOAuth('google', GOOGLE), SIGNED_IN);
  assert.equal(credentialsOf(credentialTable, ADA_WEBID)[0].emailVerifiedAt, undefined);
  assert.equal(credentialsOf(credentialTable, ADA_WEBID).length, 1);
});

test('a verified email attached to an OAuth-only account marks the email verified', async () => {
  credentialTable.insert({ credentialOf: { id: ADA_WEBID }, email: 'ada@example.test' });
  verifiedGoogle();
  existingAccount = ADA_ACCOUNT;
  linkedProviders = ['apple'];
  assert.equal(await provider.signinOAuth('google', GOOGLE), SIGNED_IN);
  assert.ok(credentialsOf(credentialTable, ADA_WEBID)[0].emailVerifiedAt);
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
  const none = { emailVerified: false, hasPassword: false, linkedProviders: [] };
  const verified = (facts) => ({ emailVerified: true, hasPassword: false, linkedProviders: [], ...facts });
  // one verified email, one account: whatever else the account has
  assert.deepEqual(decide('google', true, verified({ hasPassword: true })), { link: true });
  assert.deepEqual(decide('google', true, verified({ linkedProviders: ['google', 'facebook'] })), { link: true });
  // never for an unverified provider email, or a provider that does not verify emails
  assert.equal(decide('google', false, verified({})).action, 'sign_in_to_link');
  assert.equal(decide('facebook', true, verified({})).action, 'sign_in_to_link');
  assert.deepEqual(decide('google', true, none), { link: true });
  assert.deepEqual(decide('apple', true, { ...none, linkedProviders: ['google'] }), { link: true });
  assert.equal(decide('google', false, none).action, 'sign_in_to_link');
  assert.equal(decide('facebook', true, none).action, 'sign_in_to_link');
  assert.equal(decide('google', true, { ...none, hasPassword: true }).action, 'sign_in_to_link');
  assert.equal(decide('google', true, { ...none, linkedProviders: ['google'] }).action, 'sign_in_to_link');
  assert.equal(decide('google', true, { ...none, linkedProviders: ['facebook'] }).action, 'sign_in_to_link');
});

test('providerOfIdentityLink: a row without a provider is a legacy Apple link', () => {
  assert.equal(providerOfIdentityLink({ sub: 's', identityProvider: 'google' }), 'google');
  assert.equal(providerOfIdentityLink({ sub: 's' }), 'apple');
  assert.equal(providerOfIdentityLink({ sub: 's', identityProvider: 'github' }), undefined);
  assert.equal(providerOfIdentityLink({}), undefined);
});
