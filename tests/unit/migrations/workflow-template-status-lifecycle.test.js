const fs = require('fs');
const path = require('path');
const source = fs.readFileSync(path.resolve(__dirname,
  '../../../supabase/migrations/20260913092000_workflow_template_status_lifecycle_v1.sql'), 'utf8');

describe('workflow template status lifecycle migration', () => {
  test('uses one scoped audited seam and closes direct and generic bypasses', () => {
    for (const required of [
      'public.ui_set_workflow_template_status_v1',
      'api.ui_set_workflow_template_status_v1',
      "v_next_status NOT IN ('draft', 'active', 'archived')",
      "is_active_lookup_value_v1('workflow_status', v_next_status, TRUE)",
      "assert_capability_v1('workflow_runs.write')",
      'workflow_template_scope_allowed',
      "assert_capability_v1('system.write')",
      "p_decision_point := 'workflow_template.status_transition'",
      "'workflow_template.status_changed'",
      "'actor_user_id', v_actor_id",
      "'reason', v_reason",
      'COALESCE(published_at, v_now)',
      "WHEN status = 'archived' THEN NULL",
      "'changed', FALSE",
      "'public.driver_compliance_events'::REGCLASS",
      "'public.workflow_templates'::REGCLASS",
      'REVOKE INSERT, UPDATE, DELETE ON TABLE public.workflow_templates FROM authenticated',
    ]) expect(source).toContain(required);
    expect(source).not.toMatch(/\b(?:inactive|retired)\b/);
  });
});
