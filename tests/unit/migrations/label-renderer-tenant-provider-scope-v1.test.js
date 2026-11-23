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
    const dir = path.resolve(__dirname, '../../../supabase/migrations');
    const migrations = fs.readdirSync(dir).filter((name) => /^\d+.*\.sql$/.test(name)).sort().reverse()
      .map((name) => fs.readFileSync(path.join(dir, name), 'utf8'));
    const effectiveBody = (signature) => migrations
      .flatMap((source) => [...source.matchAll(/CREATE (?:OR REPLACE )?FUNCTION public\.[\s\S]+?AS (\$\w*\$)([\s\S]+?)\1;/gi)].reverse())
      .find(([definition]) => signature.test(definition))?.[2] ?? '';
    const invoke = effectiveBody(/^CREATE.*public\.invoke_label_renderer\(\s*p_max_jobs INT,\s*p_payload JSONB\s*\)/i);
    const overload = effectiveBody(/^CREATE.*public\.invoke_label_renderer\(p_max_jobs INT DEFAULT 5\)/i);
    const print = effectiveBody(/^CREATE.*public\.invoke_label_renderer_print_sync_v1\(/i);
    const enqueue = effectiveBody(/^CREATE.*public\.enqueue_label_renderer_edge_v1\(/i);
    const config = effectiveBody(/^CREATE.*public\.resolve_label_renderer_edge_config_v1\(/i);

    expect(invoke).toMatch(/resolve_label_renderer_organization_id_v1\(v_body\)[\s\S]+enqueue_label_renderer_edge_v1\(v_org_id, v_body\)/);
    expect(overload).toContain('RETURN public.invoke_label_renderer(p_max_jobs, NULL::jsonb)');
    expect(print).toMatch(/resolve_label_renderer_organization_id_v1\(p_payload\)[\s\S]+requires organization_id[\s\S]+enqueue_label_renderer_edge_v1\(v_org_id, v_request_body\)/);
    expect(config).toMatch(/v_url := NULLIF[\s\S]+v_ref :=[\s\S]+pinned_invoke_url[\s\S]+renderer_credential_ref/);
    expect(enqueue).toMatch(/resolve_label_renderer_edge_config_v1\(p_organization_id\)[\s\S]+INSERT INTO public\.outbound_calls[\s\S]+renderer_credential_ref[\s\S]+'pending_edge'/);
    expect(invoke + overload + print + enqueue + config).not.toMatch(/\b(?:dispatch_api_request_v1|call_api|call_api_wait)\s*\(/);
    expect(enqueue).toMatch(/v_request_id := nextval[\s\S]+v_request_id, \(v_provider->>'renderer_credential_ref'\)::uuid[\s\S]+'completed', FALSE, 'request_id', v_request_id, 'edge_job_id', v_job_id/);
  });
});
