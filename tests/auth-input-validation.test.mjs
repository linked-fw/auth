import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isOAuthProvider,
  OAUTH_PROVIDERS,
} from '../lib/esm/types/auth.js';
import { isCleanName } from '../lib/esm/utils/name-validation.js';

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
