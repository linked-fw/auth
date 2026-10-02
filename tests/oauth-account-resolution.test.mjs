import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  decideEmailMatchedAccount,
  EMAIL_VERIFYING_PROVIDERS,
  LINK_REQUIRES_SIGN_IN_ACTION,
  resolveOAuthAccountInput,
  resolveVerifiedEmailAccount,
} from '../lib/esm/helpers/oauth-account.js';
import {
  buildOAuthSubjectLinkId,
  providerOfSubjectLink,
} from '../lib/esm/helpers/oauth-subject-link.js';

test('Apple first login continues with normalized verified email', () => {
  assert.deepEqual(
    resolveOAuthAccountInput({
      provider: 'apple',
      verifiedEmail: ' New@Example.COM ',
      subjectCandidates: [],
    }),
    { email: 'new@example.com' }
  );
});

test('Apple repeat login without email resolves the subject-linked account', () => {
  const account = { id: 'account-1' };
  assert.deepEqual(
    resolveOAuthAccountInput({
      provider: 'apple',
      subjectCandidates: [{ account, email: 'stored@example.com' }],
    }),
    { account, email: 'stored@example.com' }
  );
});

test('verified email overrides stale stored subject-link email', () => {
  const account = { id: 'account-1' };
  assert.deepEqual(
    resolveOAuthAccountInput({
      provider: 'apple',
      verifiedEmail: 'verified@example.com',
      subjectCandidates: [{ account, email: 'old@example.com' }],
    }),
    { account, email: 'verified@example.com' }
  );
});

test('duplicate subject links fail closed', () => {
  const resolution = resolveOAuthAccountInput({
    provider: 'apple',
    subjectCandidates: [
      { account: { id: 'account-1' } },
      { account: { id: 'account-2' } },
    ],
  });
  assert.match(resolution.error, /multiple accounts/i);
});

test('duplicate subject rows for the same account resolve idempotently', () => {
  const accountA = { id: 'account-1' };
  const accountB = { id: 'account-1' };
  assert.deepEqual(
    resolveOAuthAccountInput({
      provider: 'apple',
      subjectCandidates: [
        { account: accountA, email: 'stored@example.com' },
        { account: accountB, email: 'stored@example.com' },
      ],
    }),
    { account: accountA, email: 'stored@example.com' }
  );
});

test('OAuth subject link IDs are deterministic and provider-scoped', () => {
  const first = buildOAuthSubjectLinkId(
    'https://example.test/data/',
    'apple',
    'subject-1'
  );
  assert.equal(
    first,
    buildOAuthSubjectLinkId(
      'https://example.test/data',
      'apple',
      'subject-1'
    )
  );
  assert.notEqual(
    first,
    buildOAuthSubjectLinkId(
      'https://example.test/data',
      'google',
      'subject-1'
    )
  );
  assert.doesNotMatch(first, /subject-1/);
});

test('missing subject link and verified email fails closed', () => {
  const resolution = resolveOAuthAccountInput({
    provider: 'apple',
    subjectCandidates: [],
  });
  assert.match(resolution.error, /verified email/i);
});

test('verified email resolves one legacy account without changing its WebID', () => {
  const legacyAccount = {
    id: 'account-342',
    accountOf: { id: 'https://webid.create.now/abdi@semantu.com' },
  };
  assert.deepEqual(resolveVerifiedEmailAccount([legacyAccount]), {
    account: legacyAccount,
  });
});

test('verified email fails closed for multiple different accounts', () => {
  const resolution = resolveVerifiedEmailAccount([
    { id: 'account-1' },
    { id: 'account-2' },
  ]);
  assert.match(resolution.error, /multiple accounts/i);
});

test('duplicate query rows for one email account resolve once', () => {
  const first = { id: 'account-1' };
  assert.deepEqual(
    resolveVerifiedEmailAccount([first, { id: 'account-1' }]),
    { account: first }
  );
});

async function builtBackendSource() {
  return readFile(new URL('../lib/esm/backend.js', import.meta.url), 'utf8');
}

test('backend links an email-matched account only through the linking policy', async () => {
  const source = await builtBackendSource();
  const emailBranch = source.slice(
    source.indexOf('if (existingPersonId) {'),
    source.indexOf('return Auth.login(', source.indexOf('if (existingPersonId) {'))
  );
  assert.match(emailBranch, /decideEmailMatchedAccount\(/);
  assert.ok(
    emailBranch.indexOf("if ('error' in decision) return decision;") <
      emailBranch.indexOf('createSubjectLink(identity, email, account)'),
    'the policy must be consulted before a subject link is written'
  );
});

test('backend keeps token validation separate from account lookup failures', async () => {
  const source = await builtBackendSource();
  assert.match(source, /account resolution failed/);
  assert.match(source, /Sign-in is temporarily unavailable/);
});

test('backend signs a subject-linked account in before any email lookup', async () => {
  const source = await builtBackendSource();
  assert.ok(
    source.indexOf('if (subjectAccount) {') <
      source.indexOf('account.email.equals(email)'),
  );
});

test('OAuth internals are module functions, not RPC-callable provider methods', async () => {
  // Every method of a backend provider can be called over /call/<pkg>/<method>.
  const source = await builtBackendSource();
  const classStart = source.indexOf('class AuthBackendProvider');
  for (const name of [
    'verifyOAuthIdentity',
    'findSubjectLinks',
    'linkedProvidersOfAccount',
    'personHasPassword',
    'createSubjectLink',
  ]) {
    const definition = source.indexOf(`async function ${name}(`);
    assert.ok(definition >= 0 && definition < classStart, name);
  }
});

const noLinks = { hasPassword: false, linkedProviders: [] };

test('verified Google/Apple email may attach to a passwordless, unlinked account', () => {
  assert.deepEqual(
    decideEmailMatchedAccount({ provider: 'google', existing: noLinks }),
    { link: true }
  );
  assert.deepEqual(
    decideEmailMatchedAccount({
      provider: 'apple',
      existing: { hasPassword: false, linkedProviders: ['google'] },
    }),
    { link: true }
  );
});

test('Facebook email never attaches to an existing account', () => {
  const decision = decideEmailMatchedAccount({
    provider: 'facebook',
    existing: noLinks,
  });
  assert.equal(decision.action, LINK_REQUIRES_SIGN_IN_ACTION);
  assert.equal(EMAIL_VERIFYING_PROVIDERS.includes('facebook'), false);
});

test('an existing password account is never attached by email', () => {
  for (const provider of ['google', 'apple', 'facebook']) {
    const decision = decideEmailMatchedAccount({
      provider,
      existing: { hasPassword: true, linkedProviders: [] },
    });
    assert.equal(decision.action, LINK_REQUIRES_SIGN_IN_ACTION, provider);
    assert.match(decision.error, /already exists/);
  }
});

test('an account linked to another identity at the same provider is not attached', () => {
  const decision = decideEmailMatchedAccount({
    provider: 'google',
    existing: { hasPassword: false, linkedProviders: ['google'] },
  });
  assert.match(decision.error, /different google account/);
});

test('an account established through an unverified-email provider is not attached', () => {
  const decision = decideEmailMatchedAccount({
    provider: 'google',
    existing: { hasPassword: false, linkedProviders: ['facebook'] },
  });
  assert.equal(decision.action, LINK_REQUIRES_SIGN_IN_ACTION);
});

test('subject link provider is read from the link IRI, legacy links are Apple', () => {
  const id = buildOAuthSubjectLinkId('https://example.test/data', 'google', 's');
  assert.equal(providerOfSubjectLink({ id, sub: 's' }), 'google');
  assert.equal(
    providerOfSubjectLink({
      id: buildOAuthSubjectLinkId('https://example.test/data', 'facebook', 's'),
    }),
    'facebook'
  );
  assert.equal(
    providerOfSubjectLink({ id: 'https://example.test/data/identitytoken_01J', sub: '001.abc' }),
    'apple'
  );
  assert.equal(providerOfSubjectLink({ id: 'https://example.test/x' }), undefined);
});
