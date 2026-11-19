const fs = require('fs');
const path = require('path');

const migrationsDir = path.join(__dirname, '..', '..', '..', 'supabase', 'migrations');
const contactContractPath = path.join(
  migrationsDir,
  '202604101430_uc084_task_context_contact_contract_v1.sql'
);
const noHardcodedContactsPath = path.join(
  migrationsDir,
  '202606291735_dispatch_task_contact_policy_examples_no_hardcoded_contacts_v1.sql'
);
const policySupportReadbackPath = path.join(
  migrationsDir,
  '202606301840_dispatch_task_contact_policy_support_readback_v1.sql'
);

function readSql(filePath) {
  return fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
}

function functionBody(sql, name) {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION ${name}`);
  expect(start).toBeGreaterThan(-1);
  const end = sql.indexOf('\n$function$;', start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

function sectionBetween(sql, startNeedle, endNeedle) {
  const start = sql.indexOf(startNeedle);
  const end = sql.indexOf(endNeedle, start + startNeedle.length);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

describe('dispatch task-contact support readback contract migrations', () => {
  test('reads support contacts from the canonical route assignment projection', () => {
    const sql = readSql(contactContractPath);
    const body = functionBody(sql, 'public.route_stop_task_contact_metadata_v1');

    expect(body).toContain('public.route_run_assignment_projection_v1(v_stop.route_run_id)');
    expect(body).toContain("v_support_contacts := COALESCE(v_assignment #> '{metadata,support_contacts}', '[]'::jsonb)");
    expect(body).toContain("IF jsonb_typeof(v_support_contacts) IS DISTINCT FROM 'array' THEN");
    expect(body).toContain("v_support_contacts := '[]'::jsonb");
    expect(body).toContain("'support_contacts',");
    expect(body).toContain('WHEN jsonb_array_length(v_support_contacts) = 0 THEN NULL');
    expect(body).toContain('ELSE v_support_contacts');
    expect(body).not.toContain('+12025550123');
  });

  test('keeps task metadata sync route-run scoped and route-stop-execute only', () => {
    const sql = readSql(contactContractPath);
    const body = functionBody(sql, 'public.route_run_sync_stop_task_metadata_v1');

    expect(body).toContain('p_route_run_id UUID');
    expect(body).toContain('WHERE rs.route_run_id = p_route_run_id');
    expect(body).toContain("AND t.resource_type = 'route_stop'");
    expect(body).toContain("AND tt.key = 'route_stop_execute'");
    expect(body).toContain('public.route_stop_task_contact_metadata_v1(rs.id)');
    expect(body).not.toMatch(/UPDATE\s+public\.route_runs\b/i);
    expect(body).not.toMatch(/INSERT\s+INTO\s+public\.route_runs\b/i);
  });

  test('keeps task trigger contact readback scoped to route-stop execution tasks', () => {
    const sql = readSql(contactContractPath);
    const body = functionBody(sql, 'public.tg_tasks_route_stop_contact_metadata_v1');

    expect(body).toContain("lower(COALESCE(NEW.resource_type, '')) <> 'route_stop'");
    expect(body).toContain('NEW.resource_id IS NULL');
    expect(body).toContain('FROM public.task_types tt');
    expect(body).toContain('tt.id = NEW.task_type_id');
    expect(body).toContain("lower(COALESCE(v_task_type_key, '')) <> 'route_stop_execute'");
    expect(body).toContain("NEW.metadata := '{}'::jsonb");
    expect(body).toContain('public.jsonb_deep_merge(');
    expect(body).toContain('public.route_stop_task_contact_metadata_v1(NEW.resource_id)');
    expect(sql).toContain('CREATE TRIGGER tg_tasks_route_stop_contact_metadata_v1');
    expect(sql).toContain('BEFORE INSERT OR UPDATE OF metadata, resource_id, task_type_id');
    expect(sql).toContain('ON public.tasks');
  });

  test('refreshes task-contact metadata from assignment changes without app fallback', () => {
    const sql = readSql(contactContractPath);
    const triggerBody = functionBody(sql, 'public.tg_route_run_assignments_sync_stop_task_metadata_v1');

    expect(triggerBody).toContain('PERFORM public.route_run_sync_stop_task_metadata_v1(NEW.route_run_id, v_assignment_mode)');
    expect(sql).toContain('CREATE TRIGGER tg_route_run_assignments_sync_stop_task_metadata_v1');
    expect(sql).toContain('AFTER INSERT OR UPDATE OF assignment_mode, assignment_status, driver_user_id, vehicle_id, metadata');
    expect(sql).toContain('ON public.route_run_assignments');
    expect(sql).not.toContain('app-side DB');
  });

  test('removes seeded communication policy support-contact examples instead of hardcoding contacts', () => {
    const sql = readSql(noHardcodedContactsPath);

    expect(sql).toContain("WHERE category = 'communication_policy'");
    expect(sql).toContain('version = 1');
    expect(sql).toContain("'support_contacts', jsonb_build_array()");
    expect(sql).toContain("examples::text LIKE '%+12025550123%'");
    expect(sql).toContain("examples #> '{0,support_contacts}' IS DISTINCT FROM '[]'::jsonb");
    expect(sql).not.toContain("'phone_number'");
    expect(sql).not.toContain("'email'");
  });

  test('merges policy-backed support contacts into task-contact readback without fallback contacts', () => {
    const sql = readSql(policySupportReadbackPath);
    const body = functionBody(sql, 'public.route_stop_task_contact_metadata_v1');

    expect(body).toContain('public.route_run_assignment_projection_v1(v_stop.route_run_id)');
    expect(body).toContain("v_assignment_support_contacts := COALESCE(v_assignment #> '{metadata,support_contacts}', '[]'::jsonb)");
    expect(body).toContain('FROM public.resolve_communication_policy(');
    expect(body).toContain("'resource_type', 'route_stop'");
    expect(body).toContain("'resource_id', v_stop.id");
    expect(body).toContain("'route_stop_id', v_stop.id");
    expect(body).toContain("'route_run_id', v_stop.route_run_id");
    expect(body).toContain("'branch_id', v_stop.branch_id");
    expect(body).toContain("'client_id', v_stop.client_id");
    expect(body).toContain("'sender_id', v_stop.sender_id");
    expect(body).toContain("v_policy_support_contacts := COALESCE(v_communication_policy->'support_contacts', '[]'::jsonb)");
    expect(body).toContain('jsonb_array_elements(v_assignment_support_contacts || v_policy_support_contacts)');
    expect(body).toContain('GROUP BY contact_key');
    expect(body).toContain('jsonb_agg(deduped.value ORDER BY deduped.first_ordinal)');
    expect(body).toContain('ELSE v_support_contacts');
    expect(body).not.toContain('+12025550123');
    expect(body).not.toContain('app-side');
    expect(sql).toContain('row-driven communication_policy support contacts');
  });

  test('keeps assignment support contacts ahead of policy contacts during de-dupe readback', () => {
    const sql = readSql(policySupportReadbackPath);
    const body = functionBody(sql, 'public.route_stop_task_contact_metadata_v1');
    const dedupeBlock = sectionBetween(
      body,
      'SELECT COALESCE(jsonb_agg(deduped.value ORDER BY deduped.first_ordinal)',
      "RETURN jsonb_strip_nulls("
    );

    expect(dedupeBlock).toContain('jsonb_array_elements(v_assignment_support_contacts || v_policy_support_contacts)');
    expect(dedupeBlock).toContain('(array_agg(contact_value ORDER BY contact_ordinal))[1] AS value');
    expect(dedupeBlock).toContain('min(contact_ordinal) AS first_ordinal');
    expect(dedupeBlock).toContain('GROUP BY contact_key');
    expect(dedupeBlock.indexOf('(array_agg(contact_value ORDER BY contact_ordinal))[1] AS value')).toBeLessThan(
      dedupeBlock.indexOf('GROUP BY contact_key')
    );
    expect(dedupeBlock).not.toContain('v_policy_support_contacts || v_assignment_support_contacts');
  });
});
