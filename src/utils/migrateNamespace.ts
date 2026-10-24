/**
 * Moves stored auth data from the legacy `http://lincd.org/ont/auth/` namespace to the current
 * one (`https://linked.cm/ont/auth/`). Server-only.
 *
 * Every auth term — the classes (`AuthCredential`, `RefreshToken`, …) and the properties
 * (`passwordHash`, `credentialOf`, `tokenHash`, …) — changed IRI with the namespace. Data written
 * by an earlier release still carries the old IRIs, and this release cannot see it: sign-in finds
 * no credential, and the account looks like it has no password. Run the migration once per
 * dataset that auth shapes are stored in, before (or right after) the new release starts serving.
 *
 * What it rewrites: every IRI that starts with the legacy namespace, in subject, predicate and
 * object position, in the default graph and in every named graph. That covers instance data
 * (`rdf:type`, property predicates) and the synced SHACL descriptions of auth's shapes
 * (`sh:targetClass`, `sh:path`). Literals are left alone. Blank nodes keep their identity.
 *
 * Safe to run more than once: once nothing carries the legacy namespace, it changes nothing. Both
 * graph passes go to the store as one SPARQL UPDATE request, which Fuseki applies in a single
 * transaction.
 */
import { ns } from '../ontologies/auth.data.js';

/** The namespace auth's terms lived in before 2.0. */
export const LEGACY_AUTH_NAMESPACE = 'http://lincd.org/ont/auth/';
/** The namespace auth's terms live in now. */
export const AUTH_NAMESPACE: string = ns('').id;

/**
 * Anything that executes raw SPARQL — every `SparqlDataset`, including `FusekiStore`. The app's
 * dataset router does not qualify: pass the store auth shapes are pinned to.
 */
export interface RawSparqlDataset {
  rawQuery(sparql: string, mode?: 'query' | 'update'): Promise<any>;
}

export interface NamespaceMigrationResult {
  /** Triples that carried the legacy namespace before the run. */
  before: number;
  /** Triples that still carry it afterwards (0 unless the run was a dry run). */
  after: number;
  dryRun: boolean;
}

function literal(value: string) {
  return JSON.stringify(value);
}

function matchesFrom(variable: string, from: string) {
  return `(isIRI(${variable}) && STRSTARTS(STR(${variable}), ${literal(from)}))`;
}

function rewritten(variable: string, from: string, to: string) {
  return `IF(${matchesFrom(variable, from)}, IRI(CONCAT(${literal(to)}, STRAFTER(STR(${variable}), ${literal(from)}))), ${variable})`;
}

function pattern(from: string) {
  return `?s ?p ?o .
    FILTER(${matchesFrom('?s', from)} || ${matchesFrom('?p', from)} || ${matchesFrom('?o', from)})`;
}

function binds(from: string, to: string) {
  return `BIND(${rewritten('?s', from, to)} AS ?s2)
  BIND(${rewritten('?p', from, to)} AS ?p2)
  BIND(${rewritten('?o', from, to)} AS ?o2)`;
}

/**
 * The SPARQL UPDATE that moves every IRI under `from` to `to`. Named graphs first: on a store
 * whose default graph is the union of the named graphs, the second pass then finds nothing left
 * to move instead of copying named-graph triples into the default graph.
 */
export function namespaceRewriteUpdate(from: string, to: string): string {
  if (!from || !to || from === to || to.startsWith(from)) {
    throw new Error(`@_linked/auth: refusing to rewrite namespace ${from} to ${to}`);
  }
  return `DELETE { GRAPH ?g { ?s ?p ?o } }
INSERT { GRAPH ?g { ?s2 ?p2 ?o2 } }
WHERE {
  GRAPH ?g {
    ${pattern(from)}
  }
  ${binds(from, to)}
};
DELETE { ?s ?p ?o }
INSERT { ?s2 ?p2 ?o2 }
WHERE {
  ${pattern(from)}
  ${binds(from, to)}
}`;
}

function countQuery(namespace: string) {
  return `SELECT (COUNT(*) AS ?n) WHERE {
  { ?s ?p ?o . FILTER(${matchesFrom('?s', namespace)} || ${matchesFrom('?p', namespace)} || ${matchesFrom('?o', namespace)}) }
  UNION
  { GRAPH ?g { ?s ?p ?o . FILTER(${matchesFrom('?s', namespace)} || ${matchesFrom('?p', namespace)} || ${matchesFrom('?o', namespace)}) } }
}`;
}

async function count(dataset: RawSparqlDataset, namespace: string): Promise<number> {
  const result = await dataset.rawQuery(countQuery(namespace), 'query');
  const value = result?.results?.bindings?.[0]?.n?.value;
  return value === undefined ? 0 : Number(value);
}

function assertDataset(dataset: RawSparqlDataset) {
  if (!dataset || typeof dataset.rawQuery !== 'function') {
    throw new Error(
      '@_linked/auth: migrateAuthNamespace needs a dataset that runs raw SPARQL (e.g. the FusekiStore auth shapes are stored in), not a router'
    );
  }
}

/**
 * How many triples still carry the legacy auth namespace (default graph and named graphs; on a
 * union-default-graph store a named-graph triple counts twice). Scans the whole dataset — use
 * `hasLegacyAuthData` for a cheap check at boot.
 */
export async function countLegacyAuthTriples(dataset: RawSparqlDataset): Promise<number> {
  assertDataset(dataset);
  return count(dataset, LEGACY_AUTH_NAMESPACE);
}

/**
 * Whether the dataset still holds auth records typed with a legacy class. Index lookups only, so
 * cheap enough to run at every boot and warn (or refuse to start) until the migration has run.
 */
export async function hasLegacyAuthData(dataset: RawSparqlDataset): Promise<boolean> {
  assertDataset(dataset);
  const classes = [
    'AuthCredential',
    'RefreshToken',
    'Password',
    'IdentityToken',
    'Authentication',
  ]
    .map((name) => `<${LEGACY_AUTH_NAMESPACE}${name}>`)
    .join(' ');
  const query = `SELECT ?s WHERE {
  VALUES ?class { ${classes} }
  { ?s a ?class } UNION { GRAPH ?g { ?s a ?class } }
} LIMIT 1`;
  const result = await dataset.rawQuery(query, 'query');
  return (result?.results?.bindings?.length ?? 0) > 0;
}

/**
 * Rewrite every legacy auth IRI in `dataset` to the current namespace. Idempotent.
 *
 * `dryRun` only counts. Returns the number of affected triples before and after, so a caller can
 * log it and confirm `after === 0`.
 */
export async function migrateAuthNamespace(
  dataset: RawSparqlDataset,
  options: { dryRun?: boolean } = {}
): Promise<NamespaceMigrationResult> {
  assertDataset(dataset);
  const before = await count(dataset, LEGACY_AUTH_NAMESPACE);
  if (options.dryRun || before === 0) {
    return { before, after: before, dryRun: !!options.dryRun };
  }
  await dataset.rawQuery(namespaceRewriteUpdate(LEGACY_AUTH_NAMESPACE, AUTH_NAMESPACE), 'update');
  const after = await count(dataset, LEGACY_AUTH_NAMESPACE);
  return { before, after, dryRun: false };
}
