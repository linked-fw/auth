import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  resolveOAuthAccountInput,
  resolveVerifiedEmailAccount,
} from '../lib/esm/helpers/oauth-account.js';
import { buildOAuthSubjectLinkId } from '../lib/esm/helpers/oauth-subject-link.js';

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

test('backend persists an Apple subject link for an existing account', async () => {
  const source = await readFile(
    new URL('../lib/esm/backend.js', import.meta.url),
    'utf8'
  );
  const existingAccountBranch = source.slice(
    source.indexOf('if (!existingAccount)'),
    source.indexOf('// create new user and account')
  );
  assert.match(existingAccountBranch, /createAppleIdentityLink\(existingAccount\)/);
});

test('backend keeps token validation separate from account lookup failures', async () => {
  const source = await readFile(
    new URL('../lib/esm/backend.js', import.meta.url),
    'utf8'
  );
  assert.match(source, /Apple account resolution failed/);
  assert.match(source, /Apple sign-in is temporarily unavailable/);
});

test('backend bypasses email collision checks for a subject-linked account', async () => {
  const source = await readFile(
    new URL('../lib/esm/backend.js', import.meta.url),
    'utf8'
  );
  assert.match(source, /if \(!subjectAccount\) \{/);
});
