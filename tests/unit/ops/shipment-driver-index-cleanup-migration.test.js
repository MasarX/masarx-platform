const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const migration = fs.readFileSync(
  path.join(
    repoRoot,
    'supabase',
    'migrations',
    '202607151153_remove_redundant_shipment_driver_index_v1.sql',
  ),
  'utf8',
);
const pgTap = fs.readFileSync(
  path.join(
    repoRoot,
    'supabase',
    'tests',
    'pgtap',
    '0zz_b07_shipment_driver_index_cleanup_v1.sql',
  ),
  'utf8',
);
const proofPath = path.join(
  repoRoot,
  'scripts',
  'ops',
  'audit',
  'shipment-driver-index-cleanup-proof.js',
);
const proofSource = fs.readFileSync(proofPath, 'utf8');
const {
  SCENARIOS,
  resolveProofConfig,
  withScenario,
} = require('../../../scripts/ops/audit/shipment-driver-index-cleanup-proof');

describe('shipment driver index cleanup migration', () => {
  test('serializes the cleanup with a short transaction-scoped lock', () => {
    expect(migration).toContain(
      "pg_advisory_xact_lock(\n  hashtext('202607151153_remove_redundant_shipment_driver_index_v1')",
    );
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'");
    expect(migration).toContain(
      'LOCK TABLE ONLY public.shipments IN ACCESS EXCLUSIVE MODE',
    );
    expect(migration.indexOf("SET LOCAL lock_timeout = '5s'")).toBeLessThan(
      migration.indexOf('pg_advisory_xact_lock'),
    );
    expect(migration).not.toContain('pg_advisory_lock(');
    expect(migration).not.toContain('pg_advisory_unlock(');
  });

  test('fails closed unless the recursive replacement is exact and complete', () => {
    for (const requiredContract of [
      "v_replacement_oid OID := to_regclass('public.idx_shipments_driver_user_id_fk')",
      'replacement root contract drifted',
      'replacement partition coverage is incomplete',
      'replacement index tree has unexpected attachments',
      'replacement partition contract drifted',
      'index_row.indisvalid',
      'index_row.indisready',
      'index_row.indislive',
      'NOT index_row.indisclustered',
      'index_row.indpred IS NULL',
      "key_attribute.attname = 'driver_user_id'",
      'key_opclass.oid = v_uuid_btree_opclass_oid',
    ]) {
      expect(migration).toContain(requiredContract);
    }
  });

  test('drops only the exact obsolete invalid non-owned root', () => {
    for (const requiredGuard of [
      'NOT index_row.indisvalid',
      'index_row.indisready',
      'index_row.indislive',
      "= 'driver_user_idisnotnull'",
      'constraint_row.conindid = v_obsolete_oid',
      'inheritance.inhrelid = v_obsolete_oid',
      'inheritance.inhparent = v_obsolete_oid',
      'dependency.refobjid = v_obsolete_oid',
      'obsolete root contract drifted',
      'obsolete root is constraint-backed',
      'obsolete root has index inheritance',
      'obsolete root has unexpected dependencies',
      'obsolete root has unexpected dependents',
    ]) {
      expect(migration).toContain(requiredGuard);
    }
    expect(migration).toContain(
      "EXECUTE 'DROP INDEX public.idx_shipments_driver_user_id RESTRICT'",
    );
    expect(migration).not.toMatch(/\bDROP\s+INDEX\s+IF\s+EXISTS\b/i);
    expect(migration).not.toMatch(/\bDROP\s+INDEX\b[^;]*\bCASCADE\b/i);
    expect(migration).not.toMatch(/\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/i);
  });

  test('accepts already-absent state only after validating the replacement', () => {
    const replacementAssertion = migration.indexOf('replacement root contract drifted');
    const alreadyAbsent = migration.indexOf('IF v_obsolete_oid IS NULL THEN');
    expect(replacementAssertion).toBeGreaterThan(-1);
    expect(alreadyAbsent).toBeGreaterThan(replacementAssertion);
  });

  test('ships database proof for absence, replacement coverage, and zero invalid indexes', () => {
    expect(pgTap).toContain('SELECT plan(5)');
    expect(pgTap).toContain("to_regclass('public.idx_shipments_driver_user_id')");
    expect(pgTap).toContain("to_regclass('public.idx_shipments_driver_user_id_fk')");
    expect(pgTap).toContain('covers every shipment partition exactly once');
    expect(pgTap).toContain('no invalid indexes remain in application schemas');
  });

  test('binds executable failure proof to an exact loopback ephemeral database and migration hash', () => {
    const migrationSha256 = crypto.createHash('sha256').update(migration).digest('hex');
    const config = resolveProofConfig({
      SHIPMENT_DRIVER_INDEX_CLEANUP_PROOF_ALLOW: '1',
      SHIPMENT_DRIVER_INDEX_CLEANUP_PROOF_ENVIRONMENT: 'local_ephemeral',
      SHIPMENT_DRIVER_INDEX_CLEANUP_PROOF_ADMIN_DATABASE_URL:
        (['postgresql',":","/","/",'postgres',":",'secret',"@",'127.0.0.1',":",'5432',"/",'postgres'].join("")),
      SHIPMENT_DRIVER_INDEX_CLEANUP_PROOF_TEMPLATE_DATABASE: 'mx_b07_template',
      SHIPMENT_DRIVER_INDEX_CLEANUP_PROOF_DATABASE_PREFIX: 'mx_b07_cleanup',
      SHIPMENT_DRIVER_INDEX_CLEANUP_PROOF_EXPECTED_MIGRATION_SHA256: migrationSha256,
    });
    expect(config.migrationSha256).toBe(migrationSha256);
    expect(() => resolveProofConfig({
      SHIPMENT_DRIVER_INDEX_CLEANUP_PROOF_ALLOW: '1',
      SHIPMENT_DRIVER_INDEX_CLEANUP_PROOF_ENVIRONMENT: 'local_ephemeral',
      SHIPMENT_DRIVER_INDEX_CLEANUP_PROOF_ADMIN_DATABASE_URL:
        (['postgresql',":","/","/",'postgres',":",'secret',"@",'db.example.invalid',":",'5432',"/",'postgres'].join("")),
      SHIPMENT_DRIVER_INDEX_CLEANUP_PROOF_TEMPLATE_DATABASE: 'mx_b07_template',
      SHIPMENT_DRIVER_INDEX_CLEANUP_PROOF_DATABASE_PREFIX: 'mx_b07_cleanup',
      SHIPMENT_DRIVER_INDEX_CLEANUP_PROOF_EXPECTED_MIGRATION_SHA256: migrationSha256,
    })).toThrow('restricted to a loopback local/ephemeral database');
  });

  test('exercises upgrade, rerun, representative drift, attachment, and lock contention scenarios', () => {
    expect(SCENARIOS).toEqual([
      'upgrade',
      'replacement_missing',
      'replacement_drifted',
      'replacement_invalid',
      'obsolete_drifted',
      'obsolete_attachment',
      'advisory_contention',
    ]);
    for (const proofContract of [
      'Already-absent migration rerun changed catalog state',
      'replacement index is missing',
      'replacement root contract drifted',
      'obsolete root contract drifted',
      'A one-leaf topology becomes valid as soon as that leaf is attached',
      'canceling statement due to lock timeout',
      'Failure path mutated protected catalog state',
      'Cleanup proof scenario database already exists',
    ]) {
      expect(proofSource).toContain(proofContract);
    }
    expect(proofSource).not.toContain(
      'await dropScenarioDatabase(admin, databaseName);\n    await createScenarioDatabase',
    );
  });

  test('always closes the admin connection when scenario database cleanup fails', async () => {
    const admin = {
      connect: jest.fn(async () => {}),
      query: jest.fn(async (sql) => {
        if (sql.includes('SELECT EXISTS')) return { rows: [{ exists: false }] };
        if (sql.startsWith('CREATE DATABASE')) return { rows: [] };
        if (sql.startsWith('DROP DATABASE')) throw new Error('synthetic drop failure');
        throw new Error(`unexpected admin query: ${sql}`);
      }),
      end: jest.fn(async () => {}),
    };
    const scenario = {
      connect: jest.fn(async () => {}),
      query: jest.fn(async (sql) => {
        if (sql.includes('index_class.relname AS index_name')) {
          return {
            rows: [
              {
                index_name: 'idx_shipments_driver_user_id',
                indisvalid: false,
                indisready: true,
                indislive: true,
              },
              {
                index_name: 'idx_shipments_driver_user_id_fk',
                indisvalid: true,
                indisready: true,
                indislive: true,
              },
            ],
          };
        }
        if (sql.includes('child.relname AS child_name')) return { rows: [] };
        if (sql.includes('schema_name')) {
          return {
            rows: [{ schema_name: 'public', index_name: 'idx_shipments_driver_user_id' }],
          };
        }
        throw new Error(`unexpected scenario query: ${sql}`);
      }),
      end: jest.fn(async () => {}),
    };
    const clients = [admin, scenario];
    const config = {
      adminConnectionString: (['postgresql',":","/","/",'postgres',":",'secret',"@",'127.0.0.1',":",'5432',"/",'postgres'].join("")),
      templateDatabase: 'mx_b07_template',
      databasePrefix: 'mx_b07_cleanup',
    };

    await expect(withScenario(
      config,
      'upgrade',
      async () => ({ ok: true }),
      () => clients.shift(),
    )).rejects.toThrow('Cleanup failed for scenario database');
    expect(scenario.end).toHaveBeenCalledTimes(1);
    expect(admin.end).toHaveBeenCalledTimes(1);
  });
});
