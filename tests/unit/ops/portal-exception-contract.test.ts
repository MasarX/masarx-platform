import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const migration = fs.readFileSync(
  path.join(
    repoRoot,
    'supabase',
    'migrations',
    '202604091530_b09_ndr_resolution_orchestration_v1.sql',
  ),
  'utf8',
);
const commandRepairMigration = fs.readFileSync(
  path.join(
    repoRoot,
    'supabase',
    'migrations',
    '202608161730_portal_dispatch_exception_resolution_command_contract_v1.sql',
  ),
  'utf8',
);
const completionErrorTextMigration = fs.readFileSync(
  path.join(
    repoRoot,
    'supabase',
    'migrations',
    '202608161880_run_task_completion_effects_error_text_v1.sql',
  ),
  'utf8',
);

describe('Portal exception shared action contract', () => {
  test('keeps task completion failure diagnostics text-compatible and service-only', () => {
    expect(completionErrorTextMigration).toMatch(
      /COALESCE\(v_step\.step_last_error, v_step\.last_error::TEXT, 'workflow_failed'\)/,
    );
    expect(completionErrorTextMigration).not.toMatch(
      /COALESCE\(v_step\.step_last_error, v_step\.last_error, 'workflow_failed'\)/,
    );
    expect(completionErrorTextMigration).toContain('SECURITY DEFINER');
    expect(completionErrorTextMigration).toContain(
      'SET search_path TO public, workflow_handlers, extensions, pg_temp',
    );
    expect(completionErrorTextMigration).toContain(
      'REVOKE ALL ON FUNCTION public.run_task_completion_effects_v1(UUID, UUID, TEXT, JSONB) FROM PUBLIC;',
    );
    expect(completionErrorTextMigration).toContain(
      'REVOKE ALL ON FUNCTION public.run_task_completion_effects_v1(UUID, UUID, TEXT, JSONB) FROM anon;',
    );
    expect(completionErrorTextMigration).toContain(
      'REVOKE ALL ON FUNCTION public.run_task_completion_effects_v1(UUID, UUID, TEXT, JSONB) FROM authenticated;',
    );
    expect(completionErrorTextMigration).toContain(
      'GRANT EXECUTE ON FUNCTION public.run_task_completion_effects_v1(UUID, UUID, TEXT, JSONB) TO service_role;',
    );
  });

  test('registers resolution_action as the canonical ndr_action lookup input', () => {
    const commandStart = migration.indexOf("ARRAY['dispatch_exception_review.complete']");
    const commandEnd = migration.indexOf(
      "ARRAY['dispatch_exception_review_mine.complete']",
      commandStart,
    );
    const command = migration.slice(commandStart, commandEnd);

    expect(commandStart).toBeGreaterThan(-1);
    expect(commandEnd).toBeGreaterThan(commandStart);
    expect(command).toContain("'rpc', 'ui_execute_dispatch_exception_resolution_v1'");
    expect(command).toMatch(
      /'key',\s*'resolution_action'[\s\S]*?'type',\s*'lookup'[\s\S]*?'lookup_category',\s*'ndr_action'/,
    );
    expect(command).not.toMatch(/'key',\s*'ndr_action'/);
  });

  test('removes the inherited generic payload wrapper from every dedicated resolution command', () => {
    expect(commandRepairMigration).toContain(
      "'dispatch_exception_review.complete'",
    );
    expect(commandRepairMigration).toContain(
      "'dispatch_exception_review_mine.complete'",
    );
    expect(commandRepairMigration).toContain("'sla_deadline_alerts.complete'");
    expect(commandRepairMigration).toContain(
      "'rpc', 'ui_execute_dispatch_exception_resolution_v1'",
    );
    expect(commandRepairMigration).toMatch(
      /'key',\s*'resolution_action'[\s\S]*?'type',\s*'lookup'[\s\S]*?'lookup_category',\s*'ndr_action'/,
    );
    expect(commandRepairMigration).toContain(
      "jsonb_set(v_command, '{execution}', v_execution, TRUE)",
    );
    expect(commandRepairMigration).not.toContain("'payload_key'");
  });

  test('keeps authenticated submission bound to the current tenant scope and visible task', () => {
    const functionStart = migration.indexOf(
      'CREATE OR REPLACE FUNCTION public.ui_execute_dispatch_exception_resolution_v1(',
    );
    const functionEnd = migration.indexOf(
      'COMMENT ON FUNCTION public.ui_execute_dispatch_exception_resolution_v1(',
      functionStart,
    );
    const fn = migration.slice(functionStart, functionEnd);

    expect(functionStart).toBeGreaterThan(-1);
    expect(functionEnd).toBeGreaterThan(functionStart);
    expect(fn).toContain('v_user_id UUID := auth.uid();');
    expect(fn).toContain('v_scope_type TEXT := public.current_user_scope_type();');
    expect(fn).toContain('v_scope_id UUID := public.current_user_scope_id();');
    expect(fn).toContain(
      "public.resolve_settings_merged('ui_command_registry', v_scope_type, v_scope_id)",
    );
    expect(fn).toContain(
      'PERFORM public.assert_capability_v1(v_capability, v_scope_type, v_scope_id);',
    );
    expect(fn).toContain(
      'v_visible_task := public.ui_get_resource_v1(p_resource_key, v_selection_uuid);',
    );
    expect(fn).toMatch(/v_visible_task IS NULL[\s\S]*?USING ERRCODE = '42501'/);
  });

  test('exposes only the API wrapper to the browser schema and delegates to the scoped public RPC', () => {
    const apiStart = migration.indexOf(
      'CREATE OR REPLACE FUNCTION api.ui_execute_dispatch_exception_resolution_v1(',
    );
    const apiEnd = migration.indexOf('$function$;', apiStart) + '$function$;'.length;
    const apiWrapper = migration.slice(apiStart, apiEnd);

    expect(apiStart).toBeGreaterThan(-1);
    expect(apiEnd).toBeGreaterThan(apiStart);
    expect(apiWrapper).toContain(
      'SELECT public.ui_execute_dispatch_exception_resolution_v1($1, $2, $3, $4, $5, $6);',
    );
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION api.ui_execute_dispatch_exception_resolution_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) TO authenticated, service_role;',
    );
  });

  test('returns canonical completion state after persisting the task and shipment action readback trail', () => {
    const applyStart = migration.indexOf(
      'CREATE OR REPLACE FUNCTION public.apply_dispatch_exception_resolution_v1(',
    );
    const applyEnd = migration.indexOf(
      'COMMENT ON FUNCTION public.apply_dispatch_exception_resolution_v1(',
      applyStart,
    );
    const applyFn = migration.slice(applyStart, applyEnd);
    const executeStart = migration.indexOf(
      'CREATE OR REPLACE FUNCTION public.ui_execute_dispatch_exception_resolution_v1(',
    );
    const executeEnd = migration.indexOf(
      'COMMENT ON FUNCTION public.ui_execute_dispatch_exception_resolution_v1(',
      executeStart,
    );
    const executeFn = migration.slice(executeStart, executeEnd);

    expect(applyStart).toBeGreaterThan(-1);
    expect(applyEnd).toBeGreaterThan(applyStart);
    expect(applyFn).toContain('INSERT INTO public.shipment_actions (');
    expect(applyFn).toContain('UPDATE public.tasks');
    expect(applyFn).toContain("'resolution_status', 'completed'");
    expect(executeFn).toContain(
      'v_apply_result := public.apply_dispatch_exception_resolution_v1(',
    );
    expect(executeFn).toContain("'completed_count', v_completed_count");
    expect(executeFn).toContain("'items', v_results");
  });
});
