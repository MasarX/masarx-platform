const fs = require('fs');
const path = require('path');

const migration = fs.readFileSync(path.resolve(
  __dirname,
  '../../../supabase/migrations/20260918001000_pickup_wave_assignment_ssot_v1.sql',
), 'utf8');
const integration = fs.readFileSync(path.resolve(
  __dirname,
  '../../integration/workflows/pickup-batch2.test.js',
), 'utf8');

describe('pickup wave canonical assignment bridge', () => {
  test('preserves pickup authorization and policy checks before canonical delegation', () => {
    for (const required of [
      "public.user_has_permission_v1('fleet.write', v_org_id)",
      'public.resolve_pickup_policy(',
      'v_allow_partner_assignment',
      'v_enforce_capacity',
      'FROM public.assign_route_run_v1(',
    ]) expect(migration).toContain(required);
    expect(migration).not.toContain("user_has_resource_capability_v1('routes', 'write'");
  });

  test('uses exact actor attribution and restores the narrow service context on success and failure', () => {
    for (const required of [
      "'actor_user_id', v_user_id",
      "'actor_system', 'public.assign_pickup_wave_v1'",
      "set_config('request.jwt.claims', v_prev_claims, true)",
      "set_config('request.jwt.claim.role', v_prev_role, true)",
      "set_config('request.jwt.claim.sub', v_prev_sub, true)",
      "set_config('app.actor_system', v_prev_actor_system, true)",
    ]) expect(migration).toContain(required);
    expect(migration.split("set_config('request.jwt.claims', v_prev_claims, true)").length - 1).toBe(2);
  });

  test('fails closed on canonical ownership and stale replay while preserving metadata-only replay', () => {
    for (const required of [
      "v_assignment_mode = 'unassigned'",
      'cannot clear a canonical route assignment',
      "'assignment_mode', 'unassigned'",
      'INTO v_route_assignment',
      'idempotency replay conflicts with the current canonical route assignment state',
    ]) expect(migration).toContain(required);
  });

  test('keeps CASE operands unambiguous inside the PL/pgSQL distinctness guard', () => {
    const guard = migration.match(
      /IF v_route_assignment\.route_run_id IS NULL[\s\S]*?idempotency replay conflicts[\s\S]*?END IF;/,
    )?.[0];
    expect(guard).toBeTruthy();
    for (const required of [
      "v_route_assignment.assignment_mode IS DISTINCT FROM (CASE WHEN v_assignment_mode = 'partner' THEN 'partner_fleet' ELSE 'internal_driver' END)",
      "v_route_assignment.driver_user_id IS DISTINCT FROM (CASE WHEN v_assignment_mode = 'partner' THEN NULL ELSE v_driver_user_id END)",
      "v_route_assignment.vehicle_id IS DISTINCT FROM (CASE WHEN v_assignment_mode = 'partner' THEN NULL ELSE v_vehicle_id END)",
      "COALESCE(v_route_assignment.partner, '{}'::jsonb) <> COALESCE(CASE WHEN v_assignment_mode = 'partner' THEN v_partner ELSE NULL END, '{}'::jsonb)",
    ]) expect(guard).toContain(required);
    expect(guard).not.toMatch(/IS DISTINCT FROM CASE\b/);
    expect(guard).toContain("USING ERRCODE = '23514'");
  });

  test('covers unassigned replay, ownership guard, stale replay, and successful context restoration', () => {
    for (const required of [
      'unassigned pickup assignment replays without creating canonical ownership',
      'unassigned pickup assignment cannot clear canonical route ownership',
      'stale pickup replay cannot overwrite a later canonical reassignment',
      'sessionContextBeforeAssignment',
      'expect(await readSessionContext()).toEqual(sessionContextBeforeAssignment)',
    ]) expect(integration).toContain(required);
  });

  test('covers canonical internal assignment visibility and unassigned partner tasks', () => {
    for (const required of [
      "assignment_mode: 'internal_driver'",
      "ui_list_resource_v1('tasks'",
      "assignment_mode: 'partner_fleet'",
      'expect(partnerTaskRows[0].assigned_to).toBeNull()',
    ]) expect(integration).toContain(required);
  });
});
