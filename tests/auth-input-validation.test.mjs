import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isOAuthProvider,
  OAUTH_PROVIDERS,
} from '../lib/esm/types/auth.js';
import { isCleanName } from '../lib/esm/utils/name-validation.js';
import {
  isAcceptableNewPassword,
  isCheckablePassword,
} from '../lib/esm/utils/password-policy.js';

test('OAuth provider runtime guard accepts only supported providers', () => {
  assert.deepEqual(OAUTH_PROVIDERS, ['facebook', 'google', 'apple']);
  assert.equal(isOAuthProvider('google'), true);
  assert.equal(isOAuthProvider('apple'), true);
  assert.equal(isOAuthProvider('facebook'), true);
  assert.equal(isOAuthProvider('custom'), false);
  assert.equal(isOAuthProvider(undefined), false);
});

test('name validation rejects profanity and preserves explicit name allowlist', () => {
  assert.equal(isCleanName('Friendly'), true);
  assert.equal(isCleanName('shit'), false);
  assert.equal(isCleanName('Dick'), true);
});

test('an empty or non-string password is never checked against a hash', () => {
  for (const value of ['', undefined, null, 0, [], {}]) {
    assert.equal(isCheckablePassword(value), false, JSON.stringify(value));
  }
  assert.equal(isCheckablePassword('a'), true);
});

test('a new password must be a string of at least six characters', () => {
  assert.equal(isAcceptableNewPassword('12345'), false);
  assert.equal(isAcceptableNewPassword(123456), false);
  assert.equal(isAcceptableNewPassword('123456'), true);
});

test('password sign-in refuses an unusable password before looking anything up', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(
    new URL('../lib/esm/backend.js', import.meta.url),
    'utf8'
  );
  const signin = source.slice(source.indexOf('async signinWithPassword('));
  assert.ok(
    signin.indexOf('isCheckablePassword(plainPassword)') <
      signin.indexOf('emailToWebID('),
  );
});
