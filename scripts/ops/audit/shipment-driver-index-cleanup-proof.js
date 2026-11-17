#!/usr/bin/env node
/* eslint-disable no-console */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { loadEnv } = require('../../utils/load-env');

loadEnv();

const MIGRATION_ID = '202607151153_remove_redundant_shipment_driver_index_v1';
const OBSOLETE_INDEX = 'idx_shipments_driver_user_id';
const REPLACEMENT_INDEX = 'idx_shipments_driver_user_id_fk';
const SCENARIOS = [
  'upgrade',
  'replacement_missing',
  'replacement_drifted',
  'replacement_invalid',
  'obsolete_drifted',
  'obsolete_attachment',
  'advisory_contention',
];

function strictIdentifier(value, label) {
  const normalized = String(value || '').trim();
  if (!/^[a-z][a-z0-9_]{0,39}$/.test(normalized)) {
    throw new Error(`${label} must match ^[a-z][a-z0-9_]{0,39}$`);
  }
  return normalized;
}

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function databaseUrl(connectionString, databaseName) {
  const parsed = new URL(connectionString);
  parsed.pathname = `/${encodeURIComponent(databaseName)}`;
  return parsed.toString();
}

function resolveProofConfig(env = process.env) {
  if (
    String(env.SHIPMENT_DRIVER_INDEX_CLEANUP_PROOF_ALLOW || '') !== '1'
    || String(env.SHIPMENT_DRIVER_INDEX_CLEANUP_PROOF_ENVIRONMENT || '') !== 'local_ephemeral'
  ) {
    throw new Error(
      'Cleanup proof requires SHIPMENT_DRIVER_INDEX_CLEANUP_PROOF_ALLOW=1 '
      + 'and SHIPMENT_DRIVER_INDEX_CLEANUP_PROOF_ENVIRONMENT=local_ephemeral',
    );
  }

  const adminConnectionString = String(
    env.SHIPMENT_DRIVER_INDEX_CLEANUP_PROOF_ADMIN_DATABASE_URL || '',
  ).trim();
  if (!adminConnectionString) {
    throw new Error('SHIPMENT_DRIVER_INDEX_CLEANUP_PROOF_ADMIN_DATABASE_URL is required');
  }

  const parsed = new URL(adminConnectionString);
  // objectives:allow LOCALHOST Justification: destructive cleanup proof is fail-closed to an explicitly local ephemeral database.
  if (!['localhost', '127.0.0.1'].includes(parsed.hostname.toLowerCase())) {
    throw new Error('Cleanup proof is restricted to a loopback local/ephemeral database');
  }

  const templateDatabase = strictIdentifier(
    env.SHIPMENT_DRIVER_INDEX_CLEANUP_PROOF_TEMPLATE_DATABASE,
    'SHIPMENT_DRIVER_INDEX_CLEANUP_PROOF_TEMPLATE_DATABASE',
  );
  const databasePrefix = strictIdentifier(
    env.SHIPMENT_DRIVER_INDEX_CLEANUP_PROOF_DATABASE_PREFIX,
    'SHIPMENT_DRIVER_INDEX_CLEANUP_PROOF_DATABASE_PREFIX',
  );
  const adminDatabase = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!adminDatabase || adminDatabase === templateDatabase) {
    throw new Error('Cleanup proof admin database must be distinct from the template database');
  }
  for (const scenario of SCENARIOS) {
    const scenarioDatabase = `${databasePrefix}_${scenario}`;
    if (scenarioDatabase === adminDatabase || scenarioDatabase === templateDatabase) {
      throw new Error(`Cleanup proof scenario database collides with protected database: ${scenarioDatabase}`);
    }
  }

  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const migrationPath = path.join(
    repoRoot,
    'supabase',
    'migrations',
    `${MIGRATION_ID}.sql`,
  );
  const migration = fs.readFileSync(migrationPath, 'utf8');
  const migrationSha256 = crypto.createHash('sha256').update(migration).digest('hex');
  const expectedSha256 = String(
    env.SHIPMENT_DRIVER_INDEX_CLEANUP_PROOF_EXPECTED_MIGRATION_SHA256 || '',
  ).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expectedSha256) || expectedSha256 !== migrationSha256) {
    throw new Error('Cleanup proof migration SHA-256 does not match the expected exact source');
  }

  return {
    adminConnectionString,
    templateDatabase,
    databasePrefix,
    migration,
    migrationPath,
    migrationSha256,
  };
}

async function catalogSnapshot(client) {
  const indexes = await client.query(
    `SELECT index_class.relname AS index_name,
            table_class.relname AS table_name,
            index_class.relkind AS index_relkind,
            index_row.indisvalid,
            index_row.indisready,
            index_row.indislive,
            index_row.indisunique,
            index_row.indisprimary,
            index_row.indisexclusion,
            index_row.indisclustered,
            index_row.indisreplident,
            index_row.indnkeyatts,
            index_row.indnatts,
            COALESCE(pg_get_expr(index_row.indpred, index_row.indrelid), '') AS predicate,
            COALESCE(pg_get_expr(index_row.indexprs, index_row.indrelid), '') AS expressions,
            pg_get_indexdef(index_row.indexrelid) AS definition
       FROM pg_index index_row
       JOIN pg_class index_class ON index_class.oid = index_row.indexrelid
       JOIN pg_class table_class ON table_class.oid = index_row.indrelid
       JOIN pg_namespace namespace ON namespace.oid = index_class.relnamespace
      WHERE namespace.nspname = 'public'
        AND index_class.relname IN ($1, $2)
      ORDER BY index_class.relname, table_class.relname`,
    [OBSOLETE_INDEX, REPLACEMENT_INDEX],
  );
  const inheritance = await client.query(
    `SELECT child.relname AS child_name, parent.relname AS parent_name
       FROM pg_inherits inheritance
       JOIN pg_class child ON child.oid = inheritance.inhrelid
       JOIN pg_class parent ON parent.oid = inheritance.inhparent
      WHERE child.oid IN (
              SELECT indexrelid
                FROM pg_index
               WHERE indrelid IN (
                 SELECT relid FROM pg_partition_tree('public.shipments'::regclass)
               )
            )
         OR parent.oid IN (
              SELECT indexrelid
                FROM pg_index
               WHERE indrelid IN (
                 SELECT relid FROM pg_partition_tree('public.shipments'::regclass)
               )
            )
      ORDER BY parent.relname, child.relname`,
  );
  const invalid = await client.query(
    `SELECT namespace.nspname AS schema_name,
            index_class.relname AS index_name
       FROM pg_index index_row
       JOIN pg_class index_class ON index_class.oid = index_row.indexrelid
       JOIN pg_namespace namespace ON namespace.oid = index_class.relnamespace
      WHERE namespace.nspname IN ('public', 'qa')
        AND NOT index_row.indisvalid
      ORDER BY namespace.nspname, index_class.relname`,
  );
  return {
    indexes: indexes.rows,
    inheritance: inheritance.rows,
    invalid: invalid.rows,
  };
}

function fingerprint(snapshot) {
  return crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

function assertPreMigrationState(snapshot) {
  const obsolete = snapshot.indexes.find((row) => row.index_name === OBSOLETE_INDEX);
  const replacement = snapshot.indexes.find((row) => row.index_name === REPLACEMENT_INDEX);
  if (!obsolete || obsolete.indisvalid || !obsolete.indisready || !obsolete.indislive) {
    throw new Error('Proof template lacks the exact invalid/ready/live obsolete root');
  }
  if (!replacement || !replacement.indisvalid || !replacement.indisready || !replacement.indislive) {
    throw new Error('Proof template lacks the healthy recursive replacement root');
  }
}

function assertPostMigrationState(snapshot) {
  if (snapshot.indexes.some((row) => row.index_name === OBSOLETE_INDEX)) {
    throw new Error('Obsolete root remains after cleanup migration');
  }
  const replacement = snapshot.indexes.find((row) => row.index_name === REPLACEMENT_INDEX);
  if (!replacement || !replacement.indisvalid || !replacement.indisready || !replacement.indislive) {
    throw new Error('Healthy recursive replacement is missing after cleanup migration');
  }
  if (snapshot.invalid.length !== 0) {
    throw new Error(`Invalid indexes remain after cleanup: ${JSON.stringify(snapshot.invalid)}`);
  }
}

async function expectFailurePreservesState(client, migration, expectedMessage, maximumMs = 15000) {
  const before = fingerprint(await catalogSnapshot(client));
  const started = Date.now();
  let error = null;
  try {
    await client.query(migration);
  } catch (caught) {
    error = caught;
  }
  const elapsedMs = Date.now() - started;
  try { await client.query('ROLLBACK'); } catch {}
  if (!error || !String(error.message || '').includes(expectedMessage)) {
    throw new Error(
      `Expected migration failure containing "${expectedMessage}", got "${error?.message || 'success'}"`,
    );
  }
  if (elapsedMs > maximumMs) {
    throw new Error(`Expected bounded failure within ${maximumMs}ms, observed ${elapsedMs}ms`);
  }
  const after = fingerprint(await catalogSnapshot(client));
  if (after !== before) {
    throw new Error(`Failure path mutated protected catalog state for "${expectedMessage}"`);
  }
  return { elapsed_ms: elapsedMs, error_code: error.code || null, message: error.message };
}

async function createScenarioDatabase(admin, templateDatabase, databaseName) {
  await admin.query(
    `CREATE DATABASE ${quoteIdentifier(databaseName)} TEMPLATE ${quoteIdentifier(templateDatabase)}`,
  );
}

async function dropScenarioDatabase(admin, databaseName) {
  await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
}

async function withScenario(config, scenario, callback, clientFactory) {
  const databaseName = `${config.databasePrefix}_${scenario}`;
  const admin = clientFactory({
    connectionString: config.adminConnectionString,
    application_name: `${MIGRATION_ID}:admin`,
  });
  let created = false;
  let adminConnected = false;
  let scenarioClient = null;
  let scenarioConnected = false;
  let result;
  let primaryError = null;
  try {
    await admin.connect();
    adminConnected = true;
    const collision = await admin.query(
      'SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists',
      [databaseName],
    );
    if (collision.rows[0]?.exists) {
      throw new Error(`Cleanup proof scenario database already exists: ${databaseName}`);
    }
    await createScenarioDatabase(admin, config.templateDatabase, databaseName);
    created = true;
    scenarioClient = clientFactory({
      connectionString: databaseUrl(config.adminConnectionString, databaseName),
      application_name: `${MIGRATION_ID}:${scenario}`,
    });
    await scenarioClient.connect();
    scenarioConnected = true;
    assertPreMigrationState(await catalogSnapshot(scenarioClient));
    result = await callback(scenarioClient, databaseName);
  } catch (error) {
    primaryError = error;
  }

  const cleanupErrors = [];
  if (scenarioConnected) {
    try {
      await scenarioClient.end();
    } catch (error) {
      cleanupErrors.push(new Error(`scenario connection cleanup failed: ${error.message}`));
    }
  }
  if (created && adminConnected) {
    try {
      await dropScenarioDatabase(admin, databaseName);
    } catch (error) {
      cleanupErrors.push(new Error(`scenario database cleanup failed: ${error.message}`));
    }
  }
  if (adminConnected) {
    try {
      await admin.end();
    } catch (error) {
      cleanupErrors.push(new Error(`admin connection cleanup failed: ${error.message}`));
    }
  }

  if (primaryError) {
    if (cleanupErrors.length > 0) {
      primaryError.cleanup_failures = cleanupErrors.map((error) => error.message);
    }
    throw primaryError;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, `Cleanup failed for scenario database ${databaseName}`);
  }
  return result;
}

async function runProof({
  env = process.env,
  clientFactory = (options) => new Client(options),
} = {}) {
  const config = resolveProofConfig(env);
  const results = {};

  results.upgrade = await withScenario(config, 'upgrade', async (client) => {
    await client.query(config.migration);
    const afterUpgrade = await catalogSnapshot(client);
    assertPostMigrationState(afterUpgrade);
    const afterUpgradeFingerprint = fingerprint(afterUpgrade);
    await client.query(config.migration);
    const afterRerun = await catalogSnapshot(client);
    assertPostMigrationState(afterRerun);
    if (fingerprint(afterRerun) !== afterUpgradeFingerprint) {
      throw new Error('Already-absent migration rerun changed catalog state');
    }
    return { after_upgrade_fingerprint: afterUpgradeFingerprint, rerun: 'unchanged' };
  }, clientFactory);

  results.replacement_missing = await withScenario(
    config,
    'replacement_missing',
    async (client) => {
      await client.query(`DROP INDEX public.${REPLACEMENT_INDEX} RESTRICT`);
      return expectFailurePreservesState(client, config.migration, 'replacement index is missing');
    },
    clientFactory,
  );

  results.replacement_drifted = await withScenario(
    config,
    'replacement_drifted',
    async (client) => {
      await client.query(`DROP INDEX public.${REPLACEMENT_INDEX} RESTRICT`);
      await client.query(`CREATE INDEX ${REPLACEMENT_INDEX} ON public.shipments (id)`);
      return expectFailurePreservesState(client, config.migration, 'replacement root contract drifted');
    },
    clientFactory,
  );

  results.replacement_invalid = await withScenario(
    config,
    'replacement_invalid',
    async (client) => {
      await client.query(`DROP INDEX public.${REPLACEMENT_INDEX} RESTRICT`);
      await client.query(
        `CREATE INDEX ${REPLACEMENT_INDEX} ON ONLY public.shipments (driver_user_id)`,
      );
      return expectFailurePreservesState(client, config.migration, 'replacement root contract drifted');
    },
    clientFactory,
  );

  results.obsolete_drifted = await withScenario(
    config,
    'obsolete_drifted',
    async (client) => {
      await client.query(`DROP INDEX public.${OBSOLETE_INDEX} RESTRICT`);
      await client.query(
        `CREATE INDEX ${OBSOLETE_INDEX} ON ONLY public.shipments (id) WHERE id IS NOT NULL`,
      );
      return expectFailurePreservesState(client, config.migration, 'obsolete root contract drifted');
    },
    clientFactory,
  );

  results.obsolete_attachment = await withScenario(
    config,
    'obsolete_attachment',
    async (client, databaseName) => {
      const leaf = await client.query(
        `SELECT namespace.nspname AS schema_name, relation.relname AS table_name
           FROM pg_partition_tree('public.shipments'::regclass) partition_row
           JOIN pg_class relation ON relation.oid = partition_row.relid
           JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
          WHERE partition_row.isleaf
          ORDER BY partition_row.level, relation.oid
          LIMIT 1`,
      );
      if (!leaf.rows[0]) throw new Error('No shipment leaf partition is available');
      const childIndex = strictIdentifier(
        `${databaseName.slice(0, 24)}_old_child`,
        'temporary child index',
      );
      const relation = `${quoteIdentifier(leaf.rows[0].schema_name)}.${quoteIdentifier(leaf.rows[0].table_name)}`;
      await client.query(
        `CREATE INDEX ${quoteIdentifier(childIndex)}
           ON ${relation} (driver_user_id)
        WHERE driver_user_id IS NOT NULL`,
      );
      await client.query(
        `ALTER INDEX public.${OBSOLETE_INDEX}
         ATTACH PARTITION ${quoteIdentifier(leaf.rows[0].schema_name)}.${quoteIdentifier(childIndex)}`,
      );
      // A one-leaf topology becomes valid as soon as that leaf is attached, so
      // the earlier exact-obsolete-root guard is the authoritative failure.
      return expectFailurePreservesState(client, config.migration, 'obsolete root contract drifted');
    },
    clientFactory,
  );

  results.advisory_contention = await withScenario(
    config,
    'advisory_contention',
    async (client, databaseName) => {
      const blocker = clientFactory({
        connectionString: databaseUrl(config.adminConnectionString, databaseName),
        application_name: `${MIGRATION_ID}:blocker`,
      });
      await blocker.connect();
      try {
        await blocker.query('BEGIN');
        await blocker.query(
          'SELECT pg_advisory_xact_lock(hashtext($1))',
          [MIGRATION_ID],
        );
        return await expectFailurePreservesState(
          client,
          config.migration,
          'canceling statement due to lock timeout',
          10000,
        );
      } finally {
        try { await blocker.query('ROLLBACK'); } catch {}
        await blocker.end();
      }
    },
    clientFactory,
  );

  return {
    schema: 'masarx-shipment-driver-index-cleanup-proof.v1',
    migration_sha256: config.migrationSha256,
    scenarios: results,
  };
}

async function main() {
  const result = await runProof();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[shipment-driver-index-cleanup-proof] ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  MIGRATION_ID,
  SCENARIOS,
  assertPostMigrationState,
  assertPreMigrationState,
  catalogSnapshot,
  expectFailurePreservesState,
  fingerprint,
  resolveProofConfig,
  runProof,
  withScenario,
};
