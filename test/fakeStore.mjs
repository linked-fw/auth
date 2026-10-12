// An in-memory stand-in for the query API of one shape, for tests that call providers directly:
// `select(...).where(...)/.for(...)` then `.one()` or awaited (every match, or the one row for
// `.for`), and `create(data)`. `where` records each `prop.equals(value)` the callback makes; a
// value with an `id` matches a row whose property has that id.
import { mock } from 'node:test';

/** A table of plain rows, with the query API above over them. */
export function fakeShapeTable(kind, rows = []) {
  let nextId = 1;
  const selects = [];
  const created = [];
  const matches = (row, conditions) =>
    conditions.every(([prop, value]) =>
      value && typeof value === 'object' ? row[prop]?.id === value.id : row[prop] === value
    );
  const find = (conditions) => rows.find((row) => matches(row, conditions)) ?? null;
  const query = (conditions = [], single = false) => ({
    where(fn) {
      const found = [];
      fn(
        new Proxy(
          {},
          { get: (_t, prop) => ({ equals: (value) => (found.push([prop, value]), true) }) }
        )
      );
      return query([...conditions, ...found], single);
    },
    for(node) {
      return query([...conditions, ['id', typeof node === 'string' ? node : node.id]], true);
    },
    async one() {
      return find(conditions);
    },
    then(resolve, reject) {
      const result = single
        ? find(conditions)
        : rows.filter((row) => matches(row, conditions));
      return Promise.resolve(result).then(resolve, reject);
    },
  });
  return {
    rows,
    selects,
    created,
    select() {
      selects.push(true);
      return query();
    },
    async create(data) {
      const { __id, ...rest } = data;
      const row = { id: __id ?? `https://app.test/${kind}/${nextId++}`, ...rest };
      rows.push(row);
      created.push(row);
      return { ...row };
    },
  };
}

/**
 * An in-memory stand-in for the `AuthCredential` query API the provider uses:
 * `select(...).where(...)/.for(...).one()` (or the query awaited for every match), `create(data)`,
 * `update(data).for(node)` and `update(data).where(...)`. A `null` in an update unsets the
 * property, as it does for a real store. An update with a `where` matches and writes in one step,
 * like the single SPARQL update a real store runs it as.
 */
export function fakeCredentialTable() {
  const rows = new Map();
  // every update, as [credential id, the data written]
  const updates = [];
  let nextId = 1;
  const copy = (row) => (row ? structuredClone(row) : null);
  const matches = (row, conditions) =>
    conditions.every(([prop, value]) =>
      value && typeof value === 'object' ? row[prop]?.id === value.id : row[prop] === value
    );
  // each `prop.equals(value)` a where callback makes, as [prop, value]
  const conditionsOf = (fn) => {
    const found = [];
    fn(
      new Proxy(
        {},
        { get: (_t, prop) => ({ equals: (value) => (found.push([prop, value]), true) }) }
      )
    );
    return found;
  };
  const query = (conditions = []) => ({
    where(fn) {
      return query([...conditions, ...conditionsOf(fn)]);
    },
    for(node) {
      return query([...conditions, ['id', typeof node === 'string' ? node : node.id]]);
    },
    async one() {
      return copy([...rows.values()].find((row) => matches(row, conditions)));
    },
    // awaiting the query itself gives every match, like the real query builder
    then(resolve, reject) {
      return Promise.resolve(
        [...rows.values()].filter((row) => matches(row, conditions)).map(copy)
      ).then(resolve, reject);
    },
  });
  const write = (row, data) => {
    for (const [key, value] of Object.entries(data)) {
      if (value === null) delete row[key];
      else if (value !== undefined) row[key] = value instanceof Date ? value.toISOString() : value;
    }
  };
  return {
    rows,
    updates,
    insert(data) {
      const row = { id: `https://app.test/credential/${nextId++}` };
      write(row, data);
      rows.set(row.id, row);
      return copy(row);
    },
    install(AuthCredential) {
      mock.method(AuthCredential, 'select', () => query());
      mock.method(AuthCredential, 'create', async (data) => this.insert(data));
      mock.method(AuthCredential, 'update', (data) => ({
        for: async (node) => {
          const id = typeof node === 'string' ? node : node.id;
          updates.push([id, { ...data }]);
          const row = rows.get(id);
          if (row) write(row, data);
          return copy(row);
        },
        where: (fn) => {
          const conditions = conditionsOf(fn);
          // resolves void, like the real where-mode update: it never says what it matched
          return Promise.resolve().then(() => {
            for (const row of rows.values()) {
              if (!matches(row, conditions)) continue;
              updates.push([row.id, { ...data }]);
              write(row, data);
            }
          });
        },
      }));
    },
  };
}
