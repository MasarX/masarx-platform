const fs = require('fs');
const path = require('path');

describe('fk index hygiene reconcile rerun migration', () => {
  const migrationPath = path.join(
    process.cwd(),
    'supabase',
    'migrations',
    '202603150610_fk_index_hygiene_reconcile_rerun_v2.sql',
  );

  test('keeps the repair generic and schema-driven', () => {
    const body = fs.readFileSync(migrationPath, 'utf8');

    expect(body).toContain("SELECT pg_advisory_lock(hashtext('202603150610_fk_index_hygiene_reconcile_rerun_v2'))");
    expect(body).toContain("n.nspname IN ('public', 'qa')");
    expect(body).toContain('i.indexrelid AS index_oid');
    expect(body).toContain('ic.columns[1:array_length(fk.columns, 1)] = fk.columns');
    expect(body).toContain('CREATE INDEX IF NOT EXISTS %I ON %I.%I (%s)');
    expect(body).toContain("RAISE NOTICE 'fk_index_hygiene_reconcile_rerun_v2 created % missing full FK index(es)'");
    expect(body).not.toContain('workflow_binding_dispatches');
  });
});
