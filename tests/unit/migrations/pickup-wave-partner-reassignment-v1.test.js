const fs = require('fs');
const path = require('path');

const handoffMigration = fs.readFileSync(path.resolve(
  __dirname,
  '../../../supabase/migrations/20260919004000_route_partner_handoff_epoch_v1.sql',
), 'utf8');
const pickupMigration = fs.readFileSync(path.resolve(
  __dirname,
  '../../../supabase/migrations/20260919005000_pickup_wave_partner_reassignment_v1.sql',
), 'utf8');
const pickupIntegration = fs.readFileSync(path.resolve(
  __dirname,
  '../../integration/workflows/pickup-batch2.test.js',
), 'utf8');
describe('pickup wave partner reassignment', () => {
  test('keeps partner handoff service authority JWT-claim-only and scopes replay to one task assignment epoch', () => {
    expect(handoffMigration).toContain("v_is_service := COALESCE(v_role = 'service_role', FALSE);");
    expect(handoffMigration).not.toMatch(/\b(?:session_user|current_user)\b/i);
    expect(handoffMigration).toContain('t.version');
    expect(handoffMigration).toContain('t.assigned_to');
    expect(handoffMigration).toContain("'route-partner-handoff:%s:%s:v%s:%s'");
    expect(handoffMigration).toContain('ORDER BY rs.sequence_order, rs.created_at, rs.id, t.id');
    expect(handoffMigration).toContain('FOR UPDATE OF t');
    expect(handoffMigration).toContain('FROM public.unassign_task_v1(');
  });

  test('requires explicit reason and prepares canonical handoff before route reassignment', () => {
    const replay = pickupMigration.indexOf("COALESCE(v_route_run.metadata #>> '{pickup_assignment,idempotency_key}', '')");
    const reasonGuard = pickupMigration.indexOf('requires reassignment_reason when replacing canonical route ownership');
    const handoff = pickupMigration.indexOf('FROM public.route_run_prepare_partner_handoff_v1(');
    const delegation = pickupMigration.indexOf('FROM public.assign_route_run_v1(');
    expect(replay).toBeGreaterThan(-1);
    expect(reasonGuard).toBeGreaterThan(replay);
    expect(handoff).toBeGreaterThan(reasonGuard);
    expect(delegation).toBeGreaterThan(handoff);
    expect(pickupMigration).toContain("'reassignment_reason', v_reassignment_reason");
    expect(pickupMigration).toContain("'actor_user_id', v_user_id");
    expect(pickupMigration).toContain("'actor_system', 'public.assign_pickup_wave_v1'");
    expect(pickupMigration).toContain("public.user_has_permission_v1('fleet.write', v_org_id)");
    expect(pickupMigration).not.toContain('ui_execute_route_run_assign_v1');
  });

  test('parenthesizes every CASE operand in the PL/pgSQL replay condition', () => {
    const replayGuard = pickupMigration.match(
      /ELSIF v_idempotency_key IS NOT NULL[\s\S]*?RETURN jsonb_strip_nulls\(jsonb_build_object\([\s\S]*?END IF;/,
    )?.[0];
    expect(replayGuard).toBeTruthy();
    for (const required of [
      "v_current_assignment.assignment_mode = (CASE WHEN v_assignment_mode = 'partner' THEN 'partner_fleet' ELSE 'internal_driver' END)",
      "v_current_assignment.driver_user_id IS NOT DISTINCT FROM (CASE WHEN v_assignment_mode = 'partner' THEN NULL ELSE v_driver_user_id END)",
      "v_current_assignment.vehicle_id IS NOT DISTINCT FROM (CASE WHEN v_assignment_mode = 'partner' THEN NULL ELSE v_vehicle_id END)",
    ]) expect(replayGuard).toContain(required);
    expect(replayGuard).not.toMatch(/(?:=|IS(?: NOT)? DISTINCT FROM)\s+CASE\b/);
  });

  test('retains narrow service elevation restoration and canonical partner guard', () => {
    expect(pickupMigration.split("set_config('request.jwt.claims', v_prev_claims, true)").length - 1).toBe(2);
    expect(pickupMigration).toContain("set_config('request.jwt.claim.role', v_prev_role, true)");
    expect(pickupMigration).toContain('idempotency replay conflicts with the current canonical route assignment state');
    expect(pickupMigration).not.toContain('UPDATE public.tasks');
    expect(pickupMigration).not.toContain('DELETE FROM');
  });

  test('covers denied mutation, exact replay, and repeated assignment epochs', () => {
    for (const proof of [
      'requires reassignment_reason',
      'routes\\.write capability',
      'firstPartnerReplay.created',
      'secondPartnerReplay.created',
      'expect(secondPartnerState.counts.unassign_events).toBe(2)',
      'expect(await readAssignmentState()).toEqual(secondPartnerState)',
    ]) expect(pickupIntegration).toContain(proof);
    // Browser reassignment coverage remains unavailable with the provisioning adapter.
  });
});
