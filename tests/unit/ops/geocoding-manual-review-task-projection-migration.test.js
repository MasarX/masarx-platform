const fs = require('fs');
const path = require('path');

const migrationPath = path.join(
  process.cwd(),
  'supabase',
  'migrations',
  '202608161500_b3_geocoding_manual_review_task_projection_v1.sql',
);
const pgtapPath = path.join(
  process.cwd(),
  'supabase',
  'tests',
  'pgtap',
  '0zz_b22_geocoding_manual_review_task_projection_v1.sql',
);

describe('geocoding manual review Tasks SSOT migration', () => {
  const body = fs.readFileSync(migrationPath, 'utf8');
  const pgtapBody = fs.readFileSync(pgtapPath, 'utf8');

  test('creates an append-only row-driven task catalog version', () => {
    expect(body).toContain("public.upsert_settings_value_v1(\n      'task_type_catalog'");
    expect(body).toContain("'key', 'geocoding_manual_review'");
    expect(body).toContain("'manual_review_projection'");
    expect(body).toContain("'terminal_status_outcomes'");
    expect(body).not.toMatch(/UPDATE\s+public\.settings_versions\s+[\s\S]*?SET\s+value\s*=/i);
  });

  test('projects through the canonical task creator with deterministic idempotency', () => {
    expect(body).toContain('FROM public.create_task_system_v1(');
    expect(body).toContain("v_idempotency_key := 'geocoding-manual-review:' || v_canonical_review.id::text");
    expect(body).toContain('pg_advisory_xact_lock(hashtextextended(v_identity::text, 0))');
    expect(body).toContain('ORDER BY mrt.created_at, mrt.id');
    expect(body).toContain("'manual_review_canonical_source_id', v_canonical_review.id");
    expect(body).toContain("public.ensure_task_type_from_catalog_internal_v1(");
    expect(body).not.toMatch(/INSERT\s+INTO\s+public\.tasks/i);
  });

  test('fails closed on task collisions and source resource lineage mismatch', () => {
    expect(body).toContain('idempotency collision mismatch for source');
    expect(body).toContain('created task lineage mismatch for source');
    expect(body).toContain('client lineage mismatch for source');
    expect(body).toContain('sender lineage mismatch for source');
    expect(body).toContain('resource shipment lineage mismatch for source');
    expect(body).toContain("v_existing_task.metadata->'manual_review_identity' IS DISTINCT FROM v_identity");
  });

  test('keeps projection eligibility canonical and repairs disabled task types', () => {
    expect(body).toMatch(/UPDATE public\.task_types tt[\s\S]*?SET enabled = TRUE/i);
    expect(body).toContain("'{manual_review_projection}'");
    expect(body).toContain('v_effective_projection := v_catalog_projection');
  });

  test('installs both directional triggers and records decision lineage', () => {
    expect(body).toContain('trg_geocoding_manual_review_queue_task_sync_v1');
    expect(body).toContain('trg_geocoding_manual_review_operator_task_resolve_v1');
    expect(body).toContain("p_decision_point := 'resolve_from_canonical_task'");
    expect(body).toContain("'operator_resolution_decision_id', v_decision_id");
    expect(body).toContain('mrt.organization_id = NEW.organization_id');
    expect(body).toContain("v_primary_review.metadata->>'operator_task_id' IS DISTINCT FROM NEW.id::text");
    expect(body).toContain('NEW.idempotency_key IS DISTINCT FROM v_expected_idempotency_key');
    expect(body).toContain("mrt.metadata->>'operator_task_id' = NEW.id::text");
  });

  test('treats the source projection as create-once after initial status routing', () => {
    expect(body).toContain('AFTER INSERT OR UPDATE OF task_type, status');
    expect(body).not.toContain('AFTER INSERT OR UPDATE OF task_type, status, queue_assignment');
  });

  test('keeps direct synchronization service-only while tenant reads remain on tasks', () => {
    expect(body).toContain(
      'REVOKE ALL ON FUNCTION public.geocoding_manual_review_queue_task_sync_v1(UUID) FROM PUBLIC, anon, authenticated;',
    );
    expect(body).toContain(
      'GRANT EXECUTE ON FUNCTION public.geocoding_manual_review_queue_task_sync_v1(UUID) TO service_role;',
    );
    expect(body).not.toContain('GRANT SELECT ON public.manual_review_tasks TO authenticated');
  });

  test('ships adversarial database contracts for every projection guard', () => {
    expect(pgtapBody).toContain('active duplicate source identities share the earliest source task');
    expect(pgtapBody).toContain('same-tenant forged task cannot resolve a source without reciprocal lineage');
    expect(pgtapBody).toContain('cross-tenant forged task cannot resolve another organization source');
    expect(pgtapBody).toContain('cross-tenant shipment resource lineage fails closed');
    expect(pgtapBody).toContain('mismatched idempotency collision fails closed');
    expect(pgtapBody).toContain('sync repairs a disabled existing geocoding task type before creation');
    expect(pgtapBody).toContain('tenant catalog override cannot rewrite canonical terminal outcomes');
  });

});

describe('current geocoding sync wrapper NULL contract (source only)', () => {
  const root = process.cwd();
  const previous = fs.readFileSync(path.join(root, 'supabase/migrations/202608161870_runtime_failure_wave_terminal_reconciliation_v1.sql'), 'utf8');
  const repair = fs.readFileSync(path.join(root, 'supabase/migrations/20260905213000_geocoding_review_sync_null_guard_v1.sql'), 'utf8');
  const marker = 'CREATE OR REPLACE FUNCTION public.geocoding_manual_review_queue_task_sync_v1(';
  const guard = "  IF p_manual_review_task_id IS NULL THEN\n    RAISE EXCEPTION 'geocoding_manual_review_queue_task_sync_v1 requires manual_review_task_id'\n      USING ERRCODE = '23514';\n  END IF;\n\n";
  const wrapperAndGrants = sql => {
    const start = sql.indexOf(marker);
    const end = sql.indexOf('\nCOMMIT;', start);
    if (start < 0 || end < start) throw new Error('Missing current wrapper and grants');
    return sql.slice(start, end);
  };

  test('restores the original guard while preserving current wrapper and grants byte-for-byte', () => {
    const original = fs.readFileSync(migrationPath, 'utf8');
    expect(original).toContain(guard);
    expect(wrapperAndGrants(repair).replace(guard, '')).toBe(wrapperAndGrants(previous));
    expect(repair.match(/CREATE OR REPLACE FUNCTION /g)).toHaveLength(1);
    expect(repair).not.toMatch(/ALTER FUNCTION|CREATE TRIGGER|DROP TRIGGER|CREATE TABLE|upsert_settings|DO \$/);
    expect(repair.indexOf("SET LOCAL lock_timeout = '30s';")).toBeLessThan(repair.indexOf('pg_advisory_xact_lock('));
  });

  test('validates NULL before source locking and preserves absent-source return and base delegation', () => {
    const wrapper = wrapperAndGrants(repair);
    expect(wrapper).toContain('BEGIN\n' + guard + '  SELECT * INTO v_review');
    expect(wrapper).toMatch(/WHERE mrt.id = p_manual_review_task_id\s+FOR UPDATE;\s+IF NOT FOUND THEN\s+RETURN NULL;/);
    expect(wrapper).toContain('RETURN public.geocoding_manual_review_queue_task_sync_v1_base_202608161870(');
    expect(wrapper).toMatch(/REVOKE ALL ON FUNCTION public.geocoding_manual_review_queue_task_sync_v1\(UUID\)\s+FROM PUBLIC, anon, authenticated;/);
    expect(wrapper).toMatch(/GRANT EXECUTE ON FUNCTION public.geocoding_manual_review_queue_task_sync_v1\(UUID\)\s+TO service_role;/);
  });

  test('emits two top-level pgTAP regressions with verified absence and rollback', () => {
    const pgtap = fs.readFileSync(pgtapPath, 'utf8').replace(/\r\n/g, '\n');
    expect(pgtap).toContain('SELECT plan(37);');
    expect(pgtap.match(/(?:SELECT|RETURN NEXT) (?:has_function|ok|is|throws_ok)\(/g)).toHaveLength(37);
    expect(pgtap).toContain("'SELECT public.geocoding_manual_review_queue_task_sync_v1(NULL::uuid)'");
    expect(pgtap).toContain("'23514'");
    expect(pgtap).toContain('WITH candidate AS MATERIALIZED');
    expect(pgtap).toContain('SELECT gen_random_uuid() AS id');
    expect(pgtap).toContain('WHERE NOT EXISTS (\n    SELECT 1 FROM public.manual_review_tasks mrt WHERE mrt.id = candidate.id');
    expect(pgtap).toContain('public.geocoding_manual_review_queue_task_sync_v1((SELECT id FROM absent))');
    expect(pgtap).toContain('ROLLBACK;');
    expect(pgtap).not.toMatch(/\b(?:skip|todo)\(/i);
  });
});
