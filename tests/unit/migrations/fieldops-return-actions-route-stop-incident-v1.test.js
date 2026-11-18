const fs = require('fs');
const path = require('path');

const migration = fs.readFileSync(path.resolve(
  __dirname,
  '../../../supabase/migrations/20260913102000_fieldops_return_actions_route_stop_incident_v1.sql',
), 'utf8');
const reviewGuardMigration = fs.readFileSync(path.resolve(
  __dirname,
  '../../../supabase/migrations/20260914003000_fieldops_incident_review_status_guard_v1.sql',
), 'utf8');

describe('F619 FieldOps return actions and route-stop incidents', () => {
  test('keeps return actions on exact scan readback and canonical NDR', () => {
    for (const required of [
      'public.ui_execute_return_to_branch_action_v1',
      'api.ui_execute_return_to_branch_action_v1',
      "p_resource_key IS DISTINCT FROM 'return_to_branch_scan'",
      'public.ui_get_return_to_branch_scan_readback_v1(v_scan_id)',
      "'resolution_action','reattempt'",
      "'fieldops:return-scan:escalate:'||v_scan_id",
      'FROM public.create_task_system_v1(',
    ]) expect(migration).toContain(required);
  });

  test('keeps unsupported custody actions visible but non-executable', () => {
    for (const reason of [
      'otp_issuer_verifier_authority_unavailable',
      'physical_discard_custody_finance_policy_unavailable',
    ]) expect(migration).toContain(reason);
    expect(migration).toMatch(/'return_to_branch\.otp_pickup_release'[\s\S]*?'available',FALSE[\s\S]*?'state','disabled'/);
    expect(migration).toMatch(/'return_to_branch\.discard'[\s\S]*?'available',FALSE[\s\S]*?'state','disabled'/);
    const otp = migration.match(/jsonb_build_object\('key','return_to_branch\.otp_pickup_release'[\s\S]*?\),\n    jsonb_build_object\('key','return_to_branch\.discard'/)?.[0] ?? '';
    const discard = migration.match(/jsonb_build_object\('key','return_to_branch\.discard'[\s\S]*?\),\n    jsonb_build_object\('key','tasks\.report_incident'/)?.[0] ?? '';
    expect(otp).not.toContain("'execution'");
    expect(discard).not.toContain("'execution'");
  });

  test('creates an actor-bound Tasks SSOT incident without terminal domain mutation', () => {
    for (const required of [
      "'task_type_key','route_stop_incident_review'",
      "tt.key='route_stop_execute'",
      'public.route_stops_visible_v1',
      'public.is_active_lookup_value_v1',
      'a.created_by_user_id=v_actor',
      "a.storage_bucket='fieldops-evidence'",
      "'fieldops:route-stop-incident:'||v_actor||':'||v_retry",
      "ev.event_type='incident_reported'",
      "al.relation_type='incident_evidence'",
      'public.resolve_task_assignee_user_v1',
      'public.assign_task_system_v1',
    ]) expect(migration).toContain(required);
    expect(migration).not.toMatch(/INSERT INTO public\.(?:shipment_actions|vehicle_events|incidents)/i);
    expect(migration).not.toContain('tasks.exception');
  });

  test('ships exact readback and append-only registry/catalog updates', () => {
    expect(migration).toContain('public.ui_get_route_stop_incident_readback_v1(');
    expect(migration).toContain('api.ui_get_route_stop_incident_readback_v1(');
    expect(migration).toContain('p_source_task_id UUID,p_incident_task_id UUID,p_incident_task_event_id UUID');
    expect(migration).toContain("'task_type_catalog','global',NULL::uuid");
    expect(migration).toContain("'ui_command_registry',r.scope_type,r.scope_id");
    expect(migration).not.toMatch(/UPDATE\s+public\.settings_versions/i);
  });

  test('enforces driver capability, bounded service elevation, lookup SSOT, and exact reuse', () => {
    expect(migration).toContain("resolve_settings_merged('ui_command_registry'");
    expect(migration).toContain("assert_capability_v1('tasks.complete'");
    expect(migration).not.toContain("'capability','shipments.write'");
    expect(migration).not.toContain("'capability','tasks.write'");
    expect(migration).toContain("'route_stop_incident_type'");
    expect(migration).toContain("('incident','Incident',10,TRUE)");
    expect(migration).toContain("('package_damage','Package damage',20,FALSE)");
    expect(migration).toContain("is_active_lookup_value_v1('route_stop_incident_type'");
    expect(migration).toContain("current_setting('request.jwt.claims',true)");
    expect(migration).toContain("set_config('request.jwt.claims',v_prev_claims,true)");
    expect(migration).toContain("t.metadata->>'return_to_branch_scan_event_id'=v_scan_id::text");
    expect(migration).toContain("lower(t.status) IN ('open','pending','assigned','in_progress')");
    expect(migration).toContain("v_review.completed_at IS NOT NULL OR v_review.canceled_at IS NOT NULL");
    expect(migration).toMatch(/IF v_actor IS NULL[\s\S]*?set_config\('request\.jwt\.claims',v_service_claims::text,true\)/);
  });

  test('keeps incident review status guarded at the task persistence seam', () => {
    for (const required of [
      "NEW.status IN ('open','pending','assigned','in_progress')",
      'NEW.status IS NOT DISTINCT FROM OLD.status',
      'NEW.task_type_id IS NOT DISTINCT FROM OLD.task_type_id',
      'NEW.task_type_id IS DISTINCT FROM OLD.task_type_id',
      "tt.id = OLD.task_type_id AND tt.key = 'route_stop_incident_review'",
      "tt.id = NEW.task_type_id AND tt.key = 'route_stop_incident_review'",
      "RAISE EXCEPTION 'route_stop_incident_resolution_unavailable'",
      'BEFORE INSERT OR UPDATE OF status, task_type_id ON public.tasks',
    ]) expect(reviewGuardMigration).toContain(required);
    expect(reviewGuardMigration).not.toContain('CREATE OR REPLACE FUNCTION public.transition_task_v1');
  });
});
