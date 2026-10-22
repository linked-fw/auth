// OAuth sign-in against a REAL graph store: which account a verified provider identity reaches,
// and what is stored for it. The provider token checks are stubbed (they are covered by
// test/apple.test.mjs and test/oauth.test.mjs); everything after them is real.
//
// Needs a Fuseki server (see fuseki.mjs). Runs against the BUILT package in lib/ (build first).
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { serving } from '../serving.mjs';
import { useThrowawayDataset, sparql, AUTH } from './fuseki.mjs';

process.env.NODE_ENV = 'test';
process.env.SITE_ROOT = 'https://app.test';
process.env.JWT_SECRET = 'integration-test-secret-integration';
process.env.SESSION_SECRET = 'integration-test-session-secret';
process.env.AUTH_SESSION_CLEANUP = 'false';
process.env.DATA_ROOT = 'https://data.app.test';

const libDir = new URL('../../lib/esm/', import.meta.url);
await import(new URL('shapes/index.js', libDir));
const { default: AuthBackendProvider } = await import(new URL('backend.js', libDir));
const { IdentityToken } = await import(new URL('shapes/IdentityToken.js', libDir));
const { AuthCredential } = await import(new URL('shapes/AuthCredential.js', libDir));
const { Person } = await import('@_linked/schema/shapes/Person');
const { UserAccount } = await import('@_linked/sioc/shapes/UserAccount');
const { default: GoogleHelper } = await import(new URL('helpers/google.js', libDir));
const { default: AppleHelper } = await import(new URL('helpers/apple.js', libDir));

const fakeLincdServer = { callGenericBackendProvidersMethod: async () => {} };

useThrowawayDataset();

beforeEach(() => {
  mock.method(console, 'log', () => {});
});
afterEach(() => mock.restoreAll());

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

const newEmail = () => `ada-${crypto.randomBytes(4).toString('hex')}@example.test`;
const newSub = () => `sub-${crypto.randomBytes(6).toString('hex')}`;

function googleSays(email, sub) {
  mock.method(GoogleHelper, 'validateIdToken', async () => ({
    sub,
    email,
    email_verified: true,
    given_name: 'Ada',
    family_name: 'Lovelace',
  }));
}
function appleSays(email, sub) {
  mock.method(AppleHelper, 'decodeIdentityToken', async () => ({ email, sub }));
}
const GOOGLE = { authentication: { idToken: 'google-id-token' } };

async function createLegacyOAuthOnlyAccount(email) {
  const person = await Person.create({
    __id: `https://legacy.example.test/person/${crypto.randomUUID()}`,
    givenName: 'Legacy',
  });
  const account = await UserAccount.create({ accountOf: person, email });
  await AuthCredential.create({
    credentialOf: { id: person.id },
    email,
    emailVerifiedAt: new Date(),
  });
  return { person, account };
}

/** Every value stored on the identity tokens with this subject, by predicate. */
async function identityTokensFor(sub) {
  const rows = await sparql(`
    PREFIX auth: <${AUTH}>
    SELECT ?s ?p ?o WHERE {
      { ?s auth:subject "${sub}" ; ?p ?o } UNION { GRAPH ?g { ?s auth:subject "${sub}" ; ?p ?o } }
    }`);
  const bySubject = {};
  for (const row of rows) {
    (bySubject[row.s.value] ??= {})[row.p.value.replace(AUTH, '')] = row.o.value;
  }
  return Object.values(bySubject);
}

test('a Google sign-in does not reach a password account registered for that email', async () => {
  // Pre-account hijacking: account creation does not verify the email, so the password account
  // may belong to someone who registered the victim's address in advance.
  const email = newEmail();
  const created = await provider().createAccount({ firstName: 'Mallory', email, password: 'attacker-Passw0rd!' });
  assert.equal(created.error, undefined, created.error);

  googleSays(email, newSub());
  const result = await provider().signinOAuth('google', GOOGLE);
  assert.equal(result.auth, undefined, 'signed in to the existing password account');
  assert.equal(result.action, 'sign_in_to_link');
});

test('AUTH_OAUTH_MATCH_PASSWORD_ACCOUNTS=true: Google and the password both reach the password account', async () => {
  process.env.AUTH_OAUTH_MATCH_PASSWORD_ACCOUNTS = 'true';
  try {
    const email = newEmail();
    const created = await provider().createAccount({ firstName: 'Ada', email, password: 'ada-Passw0rd!' });
    assert.equal(created.error, undefined, created.error);

    googleSays(email, newSub());
    const google = await provider().signinOAuth('google', GOOGLE);
    assert.equal(google.error, undefined, google.error);
    assert.equal(google.auth.userAccount.id, created.auth.userAccount.id);

    const password = await provider().signinWithPassword(email, 'ada-Passw0rd!');
    assert.equal(password.error, undefined, password.error);
    assert.equal(password.auth.userAccount.id, created.auth.userAccount.id);
  } finally {
    delete process.env.AUTH_OAUTH_MATCH_PASSWORD_ACCOUNTS;
  }
});

test('the owner of the password account can link Google from inside the session', async () => {
  const email = newEmail();
  const sub = newSub();
  const created = await provider().createAccount({ firstName: 'Ada', email, password: 'ada-Passw0rd!' });
  googleSays(email, sub);
  assert.equal((await provider().signinOAuth('google', GOOGLE)).action, 'sign_in_to_link');

  const p = await signedInProvider(created.accessToken);
  assert.deepEqual(await p.linkOAuthIdentity('google', GOOGLE), { linked: true });

  const signin = await provider().signinOAuth('google', GOOGLE);
  assert.equal(signin.error, undefined, signin.error);
  assert.equal(signin.auth.userAccount.id, created.auth.userAccount.id);
});

/** Mark the email of a person verified, as a verification link or a code sign-in does. */
async function verifyEmailOf(personId) {
  const credentials = await AuthCredential.select((c) => [c.emailVerifiedAt]).where((c) =>
    c.credentialOf.equals({ id: personId })
  );
  assert.ok(credentials.length, 'the person has a credential');
  for (const credential of credentials) {
    await AuthCredential.update({ emailVerifiedAt: new Date() }).for({ id: credential.id });
  }
}

test('a verified Google email signs in to the password account whose email is verified', async () => {
  const email = newEmail();
  const sub = newSub();
  const created = await provider().createAccount({ firstName: 'Ada', email, password: 'ada-Passw0rd!' });
  assert.equal(created.error, undefined, created.error);
  await verifyEmailOf(created.auth.user.id);

  googleSays(email.toUpperCase(), sub);
  const result = await provider().signinOAuth('google', GOOGLE);
  assert.equal(result.error, undefined, result.error);
  assert.equal(result.auth.userAccount.id, created.auth.userAccount.id);
  assert.equal(result.auth.user.id, created.auth.user.id);
  const [link] = await identityTokensFor(sub);
  assert.equal(link.account, created.auth.userAccount.id);
  assert.equal(link.email, email, 'the link records the normalised provider email');

  // the password still works, and the same identity signs in again by its link
  const again = await provider().signinOAuth('google', GOOGLE);
  assert.equal(again.auth.userAccount.id, created.auth.userAccount.id);
});

test('an unverified Google email does not reach a verified account', async () => {
  const email = newEmail();
  const created = await provider().createAccount({ firstName: 'Ada', email, password: 'ada-Passw0rd!' });
  await verifyEmailOf(created.auth.user.id);
  const sub = newSub();
  mock.method(GoogleHelper, 'validateIdToken', async () => ({ sub, email, email_verified: false }));
  const result = await provider().signinOAuth('google', GOOGLE);
  assert.equal(result.auth, undefined);
  assert.ok(result.error);
  assert.equal((await identityTokensFor(sub)).length, 0);
});

test('a different verified email gets its own account, never the existing one', async () => {
  const email = newEmail();
  const created = await provider().createAccount({ firstName: 'Ada', email, password: 'ada-Passw0rd!' });
  await verifyEmailOf(created.auth.user.id);
  googleSays(newEmail(), newSub());
  const result = await provider().signinOAuth('google', GOOGLE);
  assert.equal(result.error, undefined, result.error);
  assert.notEqual(result.auth.userAccount.id, created.auth.userAccount.id);
  assert.notEqual(result.auth.user.id, created.auth.user.id);
});

test('a Google identity whose email changed signs in by its new email, not to the old account', async () => {
  const oldEmail = newEmail();
  const sub = newSub();
  googleSays(oldEmail, sub);
  const first = await provider().signinOAuth('google', GOOGLE);
  assert.equal(first.error, undefined, first.error);

  const newAddress = newEmail();
  googleSays(newAddress, sub);
  const renamed = await provider().signinOAuth('google', GOOGLE);
  assert.equal(renamed.error, undefined, renamed.error);
  assert.notEqual(renamed.auth.userAccount.id, first.auth.userAccount.id);

  const tokens = await identityTokensFor(sub);
  assert.equal(tokens.length, 1, 'the identity is linked to one account');
  assert.equal(tokens[0].account, renamed.auth.userAccount.id);
  assert.equal(tokens[0].email, newAddress);

  // and it keeps signing in to the new account
  const again = await provider().signinOAuth('google', GOOGLE);
  assert.equal(again.auth.userAccount.id, renamed.auth.userAccount.id);
});

test('a changed email whose new address is refused keeps the old link', async () => {
  const sub = newSub();
  googleSays(newEmail(), sub);
  const first = await provider().signinOAuth('google', GOOGLE);
  assert.equal(first.error, undefined, first.error);

  // the new address has a password account whose email is not verified: refused
  const newAddress = newEmail();
  await provider().createAccount({ firstName: 'Mallory', email: newAddress, password: 'attacker-Passw0rd!' });
  googleSays(newAddress, sub);
  const refused = await provider().signinOAuth('google', GOOGLE);
  assert.equal(refused.action, 'sign_in_to_link');

  const tokens = await identityTokensFor(sub);
  assert.equal(tokens.length, 1, 'the link was removed by a refused sign-in');
  assert.equal(tokens[0].account, first.auth.userAccount.id);
});

test('a new OAuth user gets a link with its provider and no stored token', async () => {
  const email = newEmail();
  const sub = newSub();
  appleSays(email, sub);
  const result = await provider().signinOAuth('apple', { identityToken: 'raw-apple-identity-token', givenName: 'Ada' });
  assert.equal(result.error, undefined, result.error);
  const tokens = await identityTokensFor(sub);
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].identityProvider, 'apple');
  assert.equal(tokens[0].account, result.auth.userAccount.id);
  assert.equal(tokens[0].token, undefined, 'the raw identity token was stored');

  // the same identity signs in again, by its link
  const again = await provider().signinOAuth('apple', { identityToken: 'another-token' });
  assert.equal(again.auth.userAccount.id, result.auth.userAccount.id);
});

test('an Apple user linked by an earlier release signs in without an email, and the stored token is removed', async () => {
  const email = newEmail();
  const sub = newSub();
  appleSays(email, sub);
  const first = await provider().signinOAuth('apple', { identityToken: 'first-token' });
  assert.equal(first.error, undefined, first.error);
  // turn the link into what 3.0.6 wrote: a raw token and no provider
  const [link] = await IdentityToken.select((t) => [t.sub]).where((t) => t.sub.equals(sub));
  await IdentityToken.update({ identityProvider: null, token: 'legacy-raw-token' }).for({ id: link.id });

  appleSays(undefined, sub);
  const result = await provider().signinOAuth('apple', { identityToken: 'token-without-email' });
  assert.equal(result.error, undefined, result.error);
  assert.equal(result.auth.userAccount.id, first.auth.userAccount.id);
  const [stored] = await identityTokensFor(sub);
  assert.equal(stored.token, undefined, 'the legacy token is still stored');
  assert.equal(stored.identityProvider, 'apple');
});

test('a verified email attaches a second provider to an OAuth-only account', async () => {
  const email = newEmail();
  appleSays(email, newSub());
  const viaApple = await provider().signinOAuth('apple', { identityToken: 'apple-token' });
  assert.equal(viaApple.error, undefined, viaApple.error);

  googleSays(email, newSub());
  const viaGoogle = await provider().signinOAuth('google', GOOGLE);
  assert.equal(viaGoogle.error, undefined, viaGoogle.error);
  assert.equal(viaGoogle.auth.userAccount.id, viaApple.auth.userAccount.id);
});

test('Google reuses an OAuth-only legacy account whose WebID is not derived from its email', async () => {
  const email = newEmail();
  const legacy = await createLegacyOAuthOnlyAccount(email);
  googleSays(email, newSub());

  const result = await provider().signinOAuth('google', GOOGLE);

  assert.equal(result.error, undefined, result.error);
  assert.equal(result.auth.userAccount.id, legacy.account.id);
  assert.equal(result.auth.user.id, legacy.person.id);
});

test('Apple reuses an OAuth-only legacy account whose WebID is not derived from its email', async () => {
  const email = newEmail();
  const legacy = await createLegacyOAuthOnlyAccount(email);
  appleSays(email, newSub());

  const result = await provider().signinOAuth('apple', { identityToken: 'apple-token' });

  assert.equal(result.error, undefined, result.error);
  assert.equal(result.auth.userAccount.id, legacy.account.id);
  assert.equal(result.auth.user.id, legacy.person.id);
});

test('a verified email matching several legacy accounts fails closed', async () => {
  const email = newEmail();
  await createLegacyOAuthOnlyAccount(email);
  await createLegacyOAuthOnlyAccount(email);
  const sub = newSub();
  googleSays(email, sub);

  const result = await provider().signinOAuth('google', GOOGLE);

  assert.equal(result.auth, undefined);
  assert.equal(result.action, 'account_conflict');
  assert.equal((await identityTokensFor(sub)).length, 0, 'the ambiguous identity was linked');
});

test('a redeemed nonce is recorded once, and expired records are deleted', async () => {
  const { UsedNonceStore } = await import(new URL('utils/oauthNonce.js', libDir));
  const hash = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 600_000);
  assert.equal(await UsedNonceStore.markUsed(hash, expiresAt), true, 'first use');
  assert.equal(await UsedNonceStore.markUsed(hash, expiresAt), false, 'second use');

  const old = crypto.randomBytes(32).toString('hex');
  const { UsedOAuthNonce } = await import(new URL('shapes/UsedOAuthNonce.js', libDir));
  await UsedOAuthNonce.create({ nonceHash: old, expiresAt: new Date(Date.now() - 60_000) });
  await UsedNonceStore.markUsed(crypto.randomBytes(32).toString('hex'), expiresAt);
  const left = await sparql(`
    PREFIX auth: <${AUTH}>
    SELECT ?s WHERE { { ?s auth:nonceHash "${old}" } UNION { GRAPH ?g { ?s auth:nonceHash "${old}" } } }`);
  assert.equal(left.length, 0, 'the expired record is still stored');
  assert.equal(await UsedNonceStore.markUsed(hash, expiresAt), false, 'a live record was deleted');
});
