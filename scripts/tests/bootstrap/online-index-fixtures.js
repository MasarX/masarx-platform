const registry = require('../../../config/ops/online-index-phases.json');

function identifier(value) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value || '')) throw new Error('Invalid index fixture identifier');
  return `"${value}"`;
}

function indexFixtureSql(spec) {
  const relation = spec.relation.split('.');
  if (relation.length !== 2 || spec.method !== 'btree' || !spec.keys.length
      || !spec.predicate_not_null_columns.length) throw new Error('Unsupported index fixture contract');
  const keys = spec.keys.map(key => {
    if (!['ASC', 'DESC'].includes(key.order) || !['FIRST', 'LAST'].includes(key.nulls)) {
      throw new Error('Invalid index fixture ordering');
    }
    return `${identifier(key.column)}${key.collation ? ` COLLATE ${identifier(key.collation)}` : ''} ${identifier(key.opclass)} ${key.order} NULLS ${key.nulls}`;
  });
  const predicate = spec.predicate_not_null_columns.map(column => {
    if (!spec.keys.some(key => key.column === column)) throw new Error('Index fixture predicate must use a key');
    return `${identifier(column)} IS NOT NULL`;
  }).join(' AND ');
  // Recursive creation attaches all partition indexes on the disposable database.
  return `CREATE INDEX IF NOT EXISTS ${identifier(spec.index_name)} ON ${relation.map(identifier).join('.')} USING btree (${keys.join(', ')}) WHERE ${predicate}`;
}

function disposableIndexTarget(env) {
  const dsn = env.DATABASE_URL;
  const target = new URL(dsn);
  if (env.PGTAP_FULL_LOCAL_QUALIFICATION !== '1'
      || !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)
      || !['postgres:', 'postgresql:'].includes(target.protocol)) {
    throw new Error('Index fixtures require the qualified local test database');
  }
  return dsn;
}

async function seedOnlineIndexFixtures(env) {
  const dsn = disposableIndexTarget(env);
  if (registry.version !== 1 || !registry.phases.length) throw new Error('Unsupported online index registry');
  const statements = registry.phases.flatMap(phase => phase.indexes.map(indexFixtureSql));
  const { Client } = require('pg');
  const client = new Client({ connectionString: dsn, connectionTimeoutMillis: 10000 });
  try {
    await client.connect();
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '120s'");
    for (const statement of statements) await client.query(statement);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

module.exports = { indexFixtureSql, disposableIndexTarget, seedOnlineIndexFixtures };
