// A throwaway Fuseki dataset for one integration test file: created before the file's tests and
// dropped after them. No other dataset is read or written.
//
//   AUTH_TEST_FUSEKI_URL=http://localhost:3030 AUTH_TEST_FUSEKI_USER=admin \
//   AUTH_TEST_FUSEKI_PASSWORD=... npm run test:integration
import { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const FUSEKI = process.env.AUTH_TEST_FUSEKI_URL?.replace(/\/+$/, '');
const USER = process.env.AUTH_TEST_FUSEKI_USER;
const PASSWORD = process.env.AUTH_TEST_FUSEKI_PASSWORD;
if (!FUSEKI || !USER || !PASSWORD) {
  // Fail loudly: a suite that silently skips proves nothing.
  throw new Error(
    'Set AUTH_TEST_FUSEKI_URL, AUTH_TEST_FUSEKI_USER and AUTH_TEST_FUSEKI_PASSWORD to run the integration tests'
  );
}

const DATASET = `linked-auth-test-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const authHeader = 'Basic ' + Buffer.from(`${USER}:${PASSWORD}`).toString('base64');

/** Register hooks that create the dataset and make it the default store, then drop it. */
export function useThrowawayDataset() {
  before(async () => {
    const { FusekiStore } = await import('@_linked/fuseki/shapes/FusekiStore');
    const { LinkedStorage } = await import('@_linked/core/utils/LinkedStorage');
    const res = await fetch(`${FUSEKI}/$/datasets`, {
      method: 'POST',
      headers: { authorization: authHeader, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ dbName: DATASET, dbType: 'mem' }),
    });
    assert.equal(res.status, 200, `could not create test dataset: ${await res.text()}`);
    LinkedStorage.setDefaultDataset(
      new FusekiStore({
        endpoint: `${FUSEKI}/${DATASET}`,
        credentials: { username: USER, password: PASSWORD },
      })
    );
  });
  after(async () => {
    const res = await fetch(`${FUSEKI}/$/datasets/${DATASET}`, {
      method: 'DELETE',
      headers: { authorization: authHeader },
    });
    assert.equal(res.status, 200, `could not drop test dataset ${DATASET}`);
  });
}

/** Run a SPARQL SELECT against the dataset (default graph and named graphs). */
export async function sparql(query) {
  const res = await fetch(`${FUSEKI}/${DATASET}/sparql`, {
    method: 'POST',
    headers: {
      authorization: authHeader,
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/sparql-results+json',
    },
    body: new URLSearchParams({ query }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  return (await res.json()).results.bindings;
}

/** How many subjects have `predicate` pointing at `object` (an IRI), in any graph. */
export async function countSubjectsWith(predicate, object) {
  const rows = await sparql(`
    SELECT DISTINCT ?s WHERE {
      { ?s <${predicate}> <${object}> } UNION { GRAPH ?g { ?s <${predicate}> <${object}> } }
    }`);
  return rows.length;
}

export const AUTH = 'https://linked.cm/ont/auth/';

/** Where the throwaway dataset lives, for a test that runs an app in another process. */
export const testDataset = {
  endpoint: `${FUSEKI}/${DATASET}`,
  username: USER,
  password: PASSWORD,
};
