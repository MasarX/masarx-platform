const fs = require('fs');
const path = require('path');

const migration = fs.readFileSync(path.resolve(
  __dirname,
  '../../../supabase/migrations/20260920001000_label_renderer_tenant_provider_scope_v1.sql',
), 'utf8');

const privilegeMigration = fs.readFileSync(path.resolve(
  __dirname,
  '../../../supabase/migrations/20260920002000_label_renderer_invoke_privileges_v1.sql',
), 'utf8');

const migrationDir = path.resolve(__dirname, '../../../supabase/migrations');
const effectiveInvokeMigrationName = fs.readdirSync(migrationDir)
  .filter((name) => /^\d+.*\.sql$/.test(name))
  .sort()
  .filter((name) => fs.readFileSync(path.join(migrationDir, name), 'utf8')
    .includes('CREATE OR REPLACE FUNCTION public.invoke_label_renderer('))
  .at(-1);
const effectiveInvokeMigration = fs.readFileSync(
  path.join(migrationDir, effectiveInvokeMigrationName),
  'utf8',
);

describe('label renderer tenant provider scope', () => {
  test('resolves tenant identity from every supported request envelope', () => {
    expect(migration).toContain("NULLIF(p_payload->>'organization_id', '')::UUID");
    expect(migration).toContain("NULLIF(p_payload #>> '{bundle,organization_id}', '')::UUID");
    expect(migration).toContain("NULLIF(p_payload #>> '{print,organization_id}', '')::UUID");
    expect(migration).toContain('RETURN COALESCE(v_top_org_id, v_bundle_org_id, v_print_org_id)');
    expect(migration).toContain('v_org_id := public.resolve_label_renderer_organization_id_v1(v_body)');
    expect(migration).toContain('public.resolve_label_renderer_invoke_config_v1(v_org_id)');
  });

  test('rejects conflicting tenant identities before provider selection', () => {
    const conflictIndex = migration.indexOf('conflicting organization_id values in request envelope');
    const providerIndex = migration.indexOf('public.resolve_label_renderer_invoke_config_v1(v_org_id)');
    expect(conflictIndex).toBeGreaterThan(-1);
    expect(providerIndex).toBeGreaterThan(conflictIndex);
    expect(migration).toContain("USING ERRCODE = '22023'");
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.resolve_label_renderer_organization_id_v1(JSONB) FROM PUBLIC');
  });

  test('preserves the restricted security-definer boundary', () => {
    expect(migration).toContain('SECURITY DEFINER');
    expect(migration).toContain('SET search_path TO public, workflow_handlers, extensions, pg_temp');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.invoke_label_renderer(INT, JSONB) FROM PUBLIC');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.invoke_label_renderer(INT, JSONB) TO service_role');
  });

  test('removes named low-privilege grants while preserving renderer workers', () => {
    expect(privilegeMigration).toContain(
      'REVOKE ALL ON FUNCTION public.invoke_label_renderer(INT, JSONB)\n  FROM PUBLIC, anon, authenticated;',
    );
    expect(privilegeMigration).toContain(
      'GRANT EXECUTE ON FUNCTION public.invoke_label_renderer(INT, JSONB) TO service_role;',
    );
    expect(privilegeMigration).toContain("rolname = 'edge_label_renderer_role'");
    expect(privilegeMigration).toContain('TO edge_label_renderer_role;');
  });

  test('queues tenant-scoped render work for the leased Edge worker', () => {
    expect(effectiveInvokeMigrationName > '20260920005000_label_renderer_async_dispatch_restore_v1.sql').toBe(true);
    const invokeStart = effectiveInvokeMigration.indexOf('CREATE OR REPLACE FUNCTION public.invoke_label_renderer(');
    const invoke = effectiveInvokeMigration.slice(invokeStart, effectiveInvokeMigration.indexOf('\n$$;', invokeStart));
    const identityIndex = invoke.indexOf(
      'public.resolve_label_renderer_organization_id_v1(v_body)',
    );
    const enqueueIndex = invoke.indexOf('public.enqueue_label_renderer_edge_v1(v_org_id, v_body)');
    const helper = effectiveInvokeMigration.slice(
      effectiveInvokeMigration.indexOf('CREATE FUNCTION public.enqueue_label_renderer_edge_v1('), invokeStart,
    );
    expect(identityIndex).toBeGreaterThan(-1);
    expect(enqueueIndex).toBeGreaterThan(identityIndex);
    expect(helper).toMatch(/resolve_label_renderer_edge_config_v1[\s\S]+INSERT INTO public\.outbound_calls[\s\S]+renderer_credential_ref[\s\S]+'pending_edge'/);
    expect(invoke + helper).not.toMatch(/public\.(?:dispatch_api_request_v1|call_api|call_api_wait)\(/);
    expect(helper).toMatch(/'completed', FALSE, 'request_id', v_request_id, 'edge_job_id', v_job_id/);
  });
});
