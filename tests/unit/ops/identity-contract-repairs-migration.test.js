const fs = require('fs');
const path = require('path');

describe('identity contract repair migration', () => {
  const body = fs.readFileSync(
    path.join(process.cwd(), 'supabase', 'migrations', '202609041040_identity_contract_repairs_v1.sql'),
    'utf8',
  );

  test('uses one transaction-scoped migration lock', () => {
    expect(body).toContain("SET LOCAL lock_timeout = '30s'");
    expect(body).toContain(
      "SELECT pg_advisory_xact_lock(hashtext('202609041040_identity_contract_repairs_v1'))",
    );
    expect(body).not.toContain('pg_advisory_unlock');
  });

  test('repairs dispute UUID, capability, wrapper, and ACL contracts', () => {
    expect(body).toContain('v_correlation_id UUID := gen_random_uuid()');
    expect(body).toContain("assert_capability_v1('marketplace_disputes.write')");
    expect(body).toContain('CREATE OR REPLACE FUNCTION api.dispute_escalate_v1');
    expect(body).not.toContain("assert_capability_v1('disputes.write')");
    expect(body).not.toContain("encode(gen_random_bytes(8), 'hex')");
  });

  test('does not rehome or rewrite an existing signup identity', () => {
    expect(body).toContain('ON CONFLICT (id) DO NOTHING');
    expect(body).toMatch(/FROM public\.users[\s\S]*WHERE id = p_invited_auth_user_id[\s\S]*FOR UPDATE/);
    expect(body).toContain('v_existing_user.organization_id IS DISTINCT FROM v_org_id');
    expect(body).toContain("IS DISTINCT FROM lower(btrim(COALESCE(v_req.email, '')))");
    expect(body).toContain("v_provision_error_code TEXT := 'provision_failed'");
    expect(body).toContain("v_provision_error_code := 'invited_auth_user_conflict'");
    expect(body).toContain(`v_req.id,
        v_provision_error_code,`);
    expect(body).toContain("'code', v_provision_error_code");
    expect(body).not.toMatch(/CASE WHEN SQLSTATE = '23505'/);
    expect(body).not.toMatch(/ON CONFLICT \(id\) DO UPDATE\s+SET\s+organization_id/);
  });

  test('keeps shared path resolution and branch writes canonical', () => {
    expect(body).toContain('jsonb_array_elements_text(v_paths_json) WITH ORDINALITY');
    expect(body).toContain("jsonb_typeof(value) IS DISTINCT FROM 'string'");
    expect(body.match(/assert_capability_v1\('agreements\.write'/g)).toHaveLength(6);
    expect(body).not.toContain("'branches.write'");
    expect(body).toContain('CREATE OR REPLACE FUNCTION api.branch_zone_assign_v1');
    expect(body).toContain('CREATE OR REPLACE FUNCTION api.branch_zone_unassign_v1');
    expect(body).toContain('CREATE OR REPLACE FUNCTION api.add_branch_member_v1');
  });

  test.each([
    ['branch_zone_assign_v1', 'FROM public.branches'],
    ['branch_zone_unassign_v1', 'FROM public.branch_zones'],
    ['add_branch_member_v1', 'FROM public.branches'],
  ])('%s authorizes before row discovery', (name, lookup) => {
    const start = body.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
    const end = body.indexOf('$;', start);
    const definition = body.slice(start, end);
    const authorization = definition.indexOf("assert_capability_v1('agreements.write')");
    expect(authorization).toBeGreaterThan(-1);
    expect(authorization).toBeLessThan(definition.indexOf(lookup));
  });

  test('prefers specific update actions over generic materialization', () => {
    const specific = body.indexOf("WHEN sa.action_type IN ('address_update', 'status_change') THEN 0");
    const generic = body.indexOf("WHEN sa.action_type = 'api_gateway_materialized' THEN 1");
    const timestamp = body.indexOf('sa."timestamp" DESC', specific);
    expect(specific).toBeGreaterThan(-1);
    expect(generic).toBeGreaterThan(specific);
    expect(timestamp).toBeGreaterThan(generic);
    expect(body).toContain('WITH (security_invoker = true)');
  });
});
