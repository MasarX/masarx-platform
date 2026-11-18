const fs = require('fs');
const path = require('path');

const migration = fs.readFileSync(
  path.resolve(
    process.cwd(),
    'supabase/migrations/202608161910_public_intake_service_auth_grants_v1.sql',
  ),
  'utf8',
);
const atomicityMigration = fs.readFileSync(
  path.resolve(
    process.cwd(),
    'supabase/migrations/202608161920_marketing_lead_followup_atomicity_v1.sql',
  ),
  'utf8',
);

describe('public intake service-only grants', () => {
  test('revokes only the obsolete marketing and tenant-signup edge grants', () => {
    expect(migration).toContain('REVOKE EXECUTE ON FUNCTION api.marketing_lead_request_create_v1(');
    expect(migration).toContain('REVOKE EXECUTE ON FUNCTION api.marketing_demo_request_create_v1(');
    expect(migration).toContain('REVOKE EXECUTE ON FUNCTION public.marketing_demo_request_create_v1(');
    expect(migration).toContain('REVOKE EXECUTE ON FUNCTION api.tenant_signup_policy_v1()');
    expect(migration).toContain('REVOKE EXECUTE ON FUNCTION api.tenant_signup_request_create_v1(');
    expect(migration).toContain('FROM edge_api_gateway_role;');
    expect(migration).not.toContain('GRANT ');
    expect(migration).not.toContain('TO anon');
    expect(migration).not.toContain('TO authenticated');
  });

  test('rolls back a new lead unless its exact workflow dispatch and task complete', () => {
    expect(atomicityMigration).toContain("COALESCE(v_dispatch_result->>'ok', 'false') <> 'true'");
    expect(atomicityMigration).toContain("COALESCE(v_dispatch_result->>'outcome', '') <> 'completed'");
    expect(atomicityMigration).toContain("d.binding_key = 'marketing_lead'");
    expect(atomicityMigration).toContain("d.stage_key = 'review_requested'");
    expect(atomicityMigration).toContain('d.id = v_dispatch_id');
    expect(atomicityMigration).toContain('t.id = v_task_id');
    expect(atomicityMigration).toContain('tt.key = v_task_type_key');
    expect(atomicityMigration).toContain("ERRCODE = 'P0001'");
    expect(atomicityMigration).toContain("MESSAGE = 'marketing_lead_followup_atomicity_failed'");
  });
});
