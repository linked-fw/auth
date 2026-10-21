// migrateAuthNamespace against a REAL graph store: data written under the legacy
// http://lincd.org/ont/auth/ namespace is invisible to this release until it is migrated, and
// fully usable afterwards (sign-in, refresh).
//
// Legacy data is produced by writing through this build and rewriting the result back to the
// legacy namespace, plus a hand-written legacy shape description in a named graph. (Verified
// separately against data written by the 1.x build itself — see the PR.)
//
// Needs a Fuseki server; creates a throwaway dataset and drops it afterwards. Same environment
// as sessions.fuseki.test.mjs. Runs against the BUILT package in lib/.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { serving } from '../serving.mjs';

const FUSEKI = process.env.AUTH_TEST_FUSEKI_URL?.replace(/\/+$/, '');
const USER = process.env.AUTH_TEST_FUSEKI_USER;
const PASSWORD = process.env.AUTH_TEST_FUSEKI_PASSWORD;
if (!FUSEKI || !USER || !PASSWORD) {
  throw new Error(
    'Set AUTH_TEST_FUSEKI_URL, AUTH_TEST_FUSEKI_USER and AUTH_TEST_FUSEKI_PASSWORD to run the integration tests'
  );
}

const SITE_ROOT = 'https://app.test';
const SECRET = 'integration-test-secret-integration';
process.env.NODE_ENV = 'test';
process.env.SITE_ROOT = SITE_ROOT;
process.env.JWT_SECRET = SECRET;
process.env.SESSION_SECRET = 'integration-test-session-secret';

const DATASET = `linked-auth-nsmig-test-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const authHeader = 'Basic ' + Buffer.from(`${USER}:${PASSWORD}`).toString('base64');
const OLD = 'http://lincd.org/ont/auth/';
const NEW = 'https://linked.cm/ont/auth/';
const SHAPES_GRAPH = 'https://app.test/shapes';
const SHAPE = 'https://linked.cm/shape/auth/AuthCredential';

const libDir = new URL('../../lib/esm/', import.meta.url);
const { default: jwt } = await import('jsonwebtoken');
const { FusekiStore } = await import('@_linked/fuseki/shapes/FusekiStore');
const { LinkedStorage } = await import('@_linked/core/utils/LinkedStorage');
await import(new URL('shapes/index.js', libDir));
const { default: AuthBackendProvider } = await import(new URL('backend.js', libDir));
const migration = await import(new URL('utils/migrateNamespace.js', libDir));

let store;

async function sparql(query) {
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

// The native token contract (refresh token in the response body); browsers get it as a cookie.
function provider(request = { headers: {}, cookies: {} }) {
  request.headers = { 'x-linked-auth-transport': 'body', ...request.headers };
  return serving(
    new AuthBackendProvider(null, { callGenericBackendProvidersMethod: async () => {} }),
    request
  );
}

before(async () => {
  const res = await fetch(`${FUSEKI}/$/datasets`, {
    method: 'POST',
    headers: { authorization: authHeader, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ dbName: DATASET, dbType: 'tdb2' }),
  });
  assert.ok(res.ok, `could not create test dataset: ${res.status} ${await res.text()}`);
  store = new FusekiStore({
    endpoint: `${FUSEKI}/${DATASET}`,
    credentials: { username: USER, password: PASSWORD },
  });
  LinkedStorage.setDefaultDataset(store);
});

after(async () => {
  const res = await fetch(`${FUSEKI}/$/datasets/${DATASET}`, {
    method: 'DELETE',
    headers: { authorization: authHeader },
  });
  assert.ok(res.ok, `could not drop test dataset ${DATASET}: ${res.status}`);
});

const email = `legacy-${crypto.randomBytes(4).toString('hex')}@example.test`;
const password = 'legacy-Passw0rd!';
let created;

test('the current namespace is linked.cm', () => {
  assert.equal(migration.AUTH_NAMESPACE, NEW);
  assert.equal(migration.LEGACY_AUTH_NAMESPACE, OLD);
  assert.throws(() => migration.namespaceRewriteUpdate(NEW, NEW));
});

test('data in the legacy namespace is invisible until migrated', async () => {
  created = await provider().createAccount({ firstName: 'Leg', lastName: 'Acy', email, password });
  assert.equal(created.error, undefined, created.error);

  // Make it look like a 1.x release wrote it: credential, refresh token record, and a synced
  // shape description (named graph, sh:path through a blank-node list) in the legacy namespace.
  await store.rawQuery(migration.namespaceRewriteUpdate(NEW, OLD), 'update');
  await store.rawQuery(
    `PREFIX sh: <http://www.w3.org/ns/shacl#>
     PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
     INSERT DATA { GRAPH <${SHAPES_GRAPH}> {
       <${SHAPE}> a sh:NodeShape ; sh:targetClass <${OLD}AuthCredential> ;
         sh:property <${SHAPE}/email> .
       <${SHAPE}/email> sh:path ( <${OLD}email> ) ;
         sh:description "was ${OLD}email" .
     } }`,
    'update'
  );
  assert.equal(
    (await sparql(`SELECT ?s WHERE { ?s ?p ?o FILTER(STRSTARTS(STR(?p), "${NEW}")) }`)).length,
    0,
    'nothing left in the current namespace'
  );

  const signin = await provider().signinWithPassword(email, password);
  assert.ok(signin.error, 'this release cannot see a legacy credential');
  assert.equal(await migration.hasLegacyAuthData(store), true);
});

test('a dry run only counts', async () => {
  const result = await migration.migrateAuthNamespace(store, { dryRun: true });
  assert.ok(result.before > 0);
  assert.equal(result.after, result.before);
  assert.equal(result.dryRun, true);
  assert.equal(await migration.countLegacyAuthTriples(store), result.before);
});

test('migrating makes the account usable again and leaves nothing behind', async () => {
  const result = await migration.migrateAuthNamespace(store);
  assert.ok(result.before > 0);
  assert.equal(result.after, 0);
  assert.equal(await migration.hasLegacyAuthData(store), false);

  const again = await migration.migrateAuthNamespace(store);
  assert.deepEqual(again, { before: 0, after: 0, dryRun: false }, 'idempotent');

  const signin = await provider().signinWithPassword(email, password);
  assert.equal(signin.error, undefined, `sign-in after migration: ${signin.error}`);
  assert.ok((await provider().signinWithPassword(email, 'wrong-Passw0rd!')).error);

  // The refresh token issued before the migration still refreshes: its record moved too.
  const { exp, iat, nbf, aud, iss, sub, jti, ...claims } = jwt.decode(created.accessToken);
  const expired = jwt.sign({ ...claims, exp: Math.floor(Date.now() / 1000) - 60 }, SECRET, {
    audience: SITE_ROOT,
  });
  const refreshed = await provider({
    headers: { authorization: `Bearer ${expired}` },
    cookies: {},
  }).validateToken(created.refreshToken);
  assert.equal(refreshed.error, undefined, `refresh after migration: ${refreshed.error}`);
});

test('shape descriptions are rewritten in place; literals are not', async () => {
  const rows = await sparql(`
    PREFIX sh: <http://www.w3.org/ns/shacl#>
    PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
    SELECT ?class ?first ?description WHERE { GRAPH <${SHAPES_GRAPH}> {
      <${SHAPE}> sh:targetClass ?class .
      <${SHAPE}/email> sh:path ?list ; sh:description ?description .
      ?list rdf:first ?first ; rdf:rest rdf:nil .
    } }`);
  assert.equal(rows.length, 1, 'still one description, in its named graph, list intact');
  assert.equal(rows[0].class.value, `${NEW}AuthCredential`);
  assert.equal(rows[0].first.value, `${NEW}email`);
  assert.equal(rows[0].description.value, `was ${OLD}email`);
});
