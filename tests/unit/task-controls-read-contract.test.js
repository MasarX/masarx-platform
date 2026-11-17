const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(path.resolve(__dirname, '../../supabase/migrations/20260908113000_task_controls_read_contract_v1.sql'), 'utf8');
const initplanRepair = fs.readFileSync(path.resolve(__dirname, '../../supabase/migrations/20260920003000_task_text_resolver_initplan_v1.sql'), 'utf8');

describe('F675 canonical task read contract (source guards; native proof is pgTAP)', () => {
  test.each(['ui_list_resource_v1','ui_get_resource_v1','ui_resource_metrics_v1','ui_filter_distinct_values_v1'])('%s honors optional read identity without replacing write identity', name => {
    const start = migration.indexOf('CREATE OR REPLACE FUNCTION public.' + name + '(');
    const next = migration.indexOf('CREATE OR REPLACE FUNCTION ', start + 1);
    const source = migration.slice(start, next === -1 ? undefined : next);
    expect(start).toBeGreaterThan(-1);
    expect(source).toContain("v_relation := COALESCE(NULLIF(btrim(v_resource->>'read_relation'), ''), v_resource->>'relation');");
    expect(source).toContain('assert_capability_v1');
    expect(source).toContain("v_resource#>>ARRAY['scope_columns', v_scope_type]");
  });

  test('projection checks caller identity even under elevated UI readers', () => {
    expect(migration).toContain('WITH (security_invoker = true)');
    expect(migration).toContain("auth.role() = 'service_role'");
    expect(migration).toContain("public.user_has_capability_v1('tasks.read', public.current_user_scope_type(), public.current_user_scope_id())");
    expect(migration).toContain("t.organization_id = public.current_user_org_id()");
    expect(migration).toContain("t.client_id = public.current_user_client_id()");
    expect(migration).toContain("t.sender_id = public.current_user_sender_id()");
    expect(migration).not.toMatch(/current_user\s*=|session_user\s*=/);
  });

  test('search is literal, finite, scoped and does not add a payload haystack', () => {
    expect(migration).toContain("v_resolver = 'task_text'");
    expect(migration).toContain('ANY(public.ui_search_task_ids_v1(%L))');
    expect(migration).toContain('strpos(lower(concat_ws(');
    expect(migration).toContain("public.assert_capability_v1('tasks.read'");
    expect(migration).not.toContain('AS search_text');
    expect(migration).not.toContain('metadata::text');
  });

  test('task text resolver is evaluated through one uncorrelated array InitPlan without changing search authority', () => {
    expect(initplanRepair).toContain("v_resolver = 'task_text'");
    expect(initplanRepair).toContain("'%I = ANY(((SELECT public.ui_search_task_ids_v1(%L))::uuid[]))'");
    expect(initplanRepair).not.toContain("'%I = ANY(public.ui_search_task_ids_v1(%L))'");
    expect(initplanRepair).not.toContain('CREATE OR REPLACE FUNCTION public.ui_search_task_ids_v1');
    expect(initplanRepair).toContain("v_resolver = 'shipment_identifier'");
    expect(initplanRepair).toContain('ui_search_shipment_identifier_ids_v1');
    expect(initplanRepair).toContain("v_value_text = '$current_user'");
    expect(initplanRepair).toContain("v_value_text = '$now'");
  });

  test('group sorting is configuration-checked and identifier-quoted', () => {
    expect(migration).toContain("'{task_controls,group_columns}'");
    expect(migration).toContain("ARRAY['task_controls','group_sort_columns',v_group_key]");
    expect(migration).toContain("format('%I ASC, ', v_group_sort)");
    expect(migration).toContain('unconfigured group column');
  });

  test('ordinary default sorting and task write relation remain unchanged', () => {
    expect(migration).toContain("'read_relation','api.tasks_controls_v1'");
    expect(migration).not.toContain("'key','tasks_search'");
    expect(migration).not.toContain("'relation','api.tasks_controls_v1'");
    expect(migration).not.toContain("'default_sort',jsonb_build_object");
    expect(migration).not.toContain('CREATE OR REPLACE FUNCTION public.ui_update_resource_v1');
  });

  test('planned time resolves only exact canonical route identities', () => {
    expect(migration).toContain("t.resource_type = 'route_stop' AND t.resource_id = rs.id");
    expect(migration).toContain("t.resource_type = 'route_run' AND t.resource_id = rr.id");
    expect(migration).toContain('t.client_id = rs.client_id');
    expect(migration).not.toContain('COALESCE(t.sla_due_at');
    expect(migration).toContain("WHEN planned_at IS NULL THEN 'later'");
  });

  test('registry promotion is append-only, locked and pointer-checked', () => {
    expect(migration).toContain('FOR UPDATE OF s,sv');
    expect(migration).toContain('INSERT INTO public.settings_versions(');
    expect(migration).toContain('s.settings_version_id=v_row.settings_version_id');
    expect(migration).toContain('task registry promotion lost pointer CAS');
    expect(migration).not.toMatch(/UPDATE public.settings_versions\s+SET value/);
  });
});
