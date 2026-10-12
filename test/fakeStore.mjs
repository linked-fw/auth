// An in-memory stand-in for the query API of one shape, for tests that call providers directly:
// `select(...).where(...)/.for(...)` then `.one()` or awaited (every match, or the one row for
// `.for`), and `create(data)`. `where` records each `prop.equals(value)` the callback makes; a
// value with an `id` matches a row whose property has that id.

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
