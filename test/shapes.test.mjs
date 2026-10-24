// The RefreshToken shape as the query DSL sees it, and the ontology namespace.
// Runs against the BUILT package in lib/.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const libDir = new URL('../lib/esm/', import.meta.url);
const { RefreshToken } = await import(new URL('shapes/RefreshToken.js', libDir));
const auth = await import(new URL('ontologies/auth.js', libDir));
const { ns } = await import(new URL('ontologies/auth.data.js', libDir));


const NS = 'https://linked.cm/ont/auth/';
const XSD_DATETIME = 'http://www.w3.org/2001/XMLSchema#dateTime';

test('auth terms live in the linked.cm namespace', () => {
  assert.equal(ns('').id, NS);
  for (const [name, term] of Object.entries(auth)) {
    assert.ok(term.id.startsWith(NS), `${name}: ${term.id}`);
  }
  assert.equal(RefreshToken.targetClass.id, `${NS}RefreshToken`);
});

test('every RefreshToken property is declared for the DSL', () => {
  const props = Object.fromEntries(
    [...RefreshToken.shape.propertyShapes].map((p) => [p.label, p])
  );
  const expected = {
    tokenHash: { required: true },
    sessionId: { required: true },
    account: { required: true },
    createdAt: { required: true, dateTime: true },
    expiresAt: { required: true, dateTime: true },
    lastUsedAt: { dateTime: true },
    revokedAt: { dateTime: true },
    replacedBy: {},
    sessionStartedAt: { dateTime: true },
  };
  assert.deepEqual(Object.keys(props).sort(), Object.keys(expected).sort());
  for (const [label, want] of Object.entries(expected)) {
    const p = props[label];
    assert.equal(p.path.id, `${NS}${label}`, `${label} path`);
    assert.equal(p.maxCount, 1, `${label} maxCount`);
    assert.equal(p.minCount, want.required ? 1 : undefined, `${label} minCount`);
    if (want.dateTime) assert.equal(p.datatype?.id, XSD_DATETIME, `${label} datatype`);
  }
});
