const fs = require('fs');
const path = require('path');

const migration = fs.readFileSync(
  path.join(__dirname, '../../../supabase/migrations/20260920004000_label_job_nudge_exact_step_v1.sql'),
  'utf8',
);
const completionMigration = fs.readFileSync(
  path.join(__dirname, '../../../supabase/migrations/202603061820_complete_label_jobs_step_lock_v1.sql'),
  'utf8',
);

test('label-job nudge targets its exact owning step and advances at most one step', () => {
  expect(migration).toContain('RETURN public.progress_workflow_run_step_result_v1(');
  expect(migration).toMatch(
    /progress_workflow_run_step_result_v1\(\s*v_run_id,\s*p_workflow_run_step_id,[\s\S]*?v_budget_ms,\s*1\s*\)/,
  );
  expect(migration).not.toContain('RETURN public.progress_workflow_run_until_wait_v1(');
  expect(migration).not.toContain('prepare_inline_progress_max_steps');
  expect(migration).toContain("'external_step_result', false");
});

test('label-job nudge preserves terminal-job, policy, and least-privilege guards', () => {
  expect(migration).toContain("lj.status NOT IN ('succeeded', 'failed')");
  expect(migration).toContain("lj.status = 'succeeded' AND lj.output_file_url IS NULL");
  expect(migration).toContain("resolve_settings('label_print_policy', 'tenant', v_org_id)");
  expect(migration).toContain("resolve_settings('label_print_policy', 'global', NULL)");
  expect(migration).toContain("v_policy->>'prepare_inline_progress_enabled'");
  expect(migration).toContain("v_policy->>'prepare_inline_progress_budget_ms'");
  expect(migration).toContain(
    'REVOKE ALL ON FUNCTION public.nudge_workflow_run_for_label_jobs_v1(uuid, text) FROM PUBLIC',
  );
  expect(migration).toContain(
    'GRANT EXECUTE ON FUNCTION public.nudge_workflow_run_for_label_jobs_v1(uuid, text) TO service_role',
  );
});

test('batch completion retains serialized per-step nudge evaluation', () => {
  expect(completionMigration).toContain("hashtext('label_jobs_workflow_step_nudge')");
  expect(completionMigration).toContain('hashtext(v_step_id::text)');
  expect(completionMigration).toContain(
    "PERFORM public.nudge_workflow_run_for_label_jobs_v1(v_step_id, 'label_jobs_completed')",
  );
});
