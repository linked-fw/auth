// cleanPersonName: controls and bidi controls removed, whitespace collapsed, at most 200 characters.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { cleanPersonName, MAX_PERSON_NAME_LENGTH } = await import('../lib/esm/utils/personName.js');

test('removes control and bidi characters and collapses whitespace', () => {
  assert.equal(cleanPersonName('  Ada\u0000\u0007 ‎‮Love⁦lace\u0085  '), 'Ada Love lace');
  assert.equal(cleanPersonName('Ada\n\tLovelace'), 'Ada Lovelace');
});

test('caps the length and leaves nothing for an empty or non-string name', () => {
  assert.equal(cleanPersonName('x'.repeat(500)).length, MAX_PERSON_NAME_LENGTH);
  assert.equal(cleanPersonName(' ‏ '), undefined);
  assert.equal(cleanPersonName(42), undefined);
});
