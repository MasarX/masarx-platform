const fs = require('fs');
const path = require('path');

const migration = fs.readFileSync(path.resolve(
  __dirname,
  '../../../supabase/migrations/20260919001000_attempt12_failure_union_repair_v1.sql',
), 'utf8');
const pickupIntegration = fs.readFileSync(path.resolve(
  __dirname,
  '../../integration/workflows/pickup-batch2.test.js',
), 'utf8');

describe('attempt 12 failure-union repair', () => {
  test('keeps migration history append-only and projects the shipment display reference narrowly', () => {
    for (const required of [
      's.client_reference_number',
      ') AS display_reference',
      "'reference', v_stop.display_reference",
      "'client_reference_number', v_stop.client_reference_number",
      "'tracking_number', v_stop.tracking_number",
      "public.route_run_actor_can_read_v1(rs.organization_id, rs.route_run_id, rr.driver_user_id)",
    ]) expect(migration).toContain(required);
  });

  test('recreates the API view before exposing only reference through the task registry', () => {
    const dropIndex = migration.indexOf('DROP VIEW IF EXISTS api.tasks_controls_v1;');
    const createIndex = migration.indexOf('CREATE VIEW api.tasks_controls_v1');
    const registryIndex = migration.indexOf('DO $registry$');
    expect(dropIndex).toBeGreaterThan(-1);
    expect(createIndex).toBeGreaterThan(dropIndex);
    expect(registryIndex).toBeGreaterThan(createIndex);
    expect(migration).toMatch(/AS reference\r?\nFROM classified;/);
    expect(migration).toContain("COALESCE(v_task->'select', '[]'::jsonb) || '[\"reference\"]'::jsonb");
    expect(migration).toContain("v_task->>'read_relation' IS DISTINCT FROM 'api.tasks_controls_v1'");
    expect(migration).toContain('task registry reference promotion lost pointer CAS');
  });

  test('forwards validated nested partner identity into canonical compatibility fields', () => {
    const delegation = migration.match(/FROM public\.assign_route_run_v1\([\s\S]*?'actor_system', 'public\.assign_pickup_wave_v1'[\s\S]*?\)\r?\n        \);/)?.[0];
    expect(delegation).toBeTruthy();
    for (const required of [
      "'partner', CASE WHEN v_assignment_mode = 'partner' THEN v_partner ELSE NULL END",
      "'partner_id', CASE WHEN v_assignment_mode = 'partner'",
      "v_partner->>'partner_id'",
      "'partner_name', CASE WHEN v_assignment_mode = 'partner'",
      "COALESCE(v_partner->>'partner_name', v_partner->>'name', '')",
      "'name', CASE WHEN v_assignment_mode = 'partner'",
      "COALESCE(v_partner->>'name', v_partner->>'partner_name', '')",
    ]) expect(delegation).toContain(required);
    expect(migration).toContain('idempotency replay conflicts with the current canonical route assignment state');
    expect(migration).toContain("public.user_has_permission_v1('fleet.write', v_org_id)");
  });

  test('normalizes partner aliases once before every replay and persistence path', () => {
    const normalization = migration.indexOf("v_partner := jsonb_strip_nulls(");
    const partnerPresence = migration.indexOf('v_has_partner := EXISTS');
    const replayPrecheck = migration.indexOf("IF v_assignment_mode = 'unassigned' THEN");
    const delegation = migration.indexOf('FROM public.assign_route_run_v1(');
    const persistence = migration.indexOf("'pickup_assignment', jsonb_strip_nulls(jsonb_build_object(");
    const postCallComparison = migration.indexOf('IF v_route_assignment.route_run_id IS NULL');
    expect(normalization).toBeGreaterThan(-1);
    expect(normalization).toBeLessThan(partnerPresence);
    expect(partnerPresence).toBeLessThan(replayPrecheck);
    expect(replayPrecheck).toBeLessThan(delegation);
    expect(delegation).toBeLessThan(postCallComparison);
    expect(postCallComparison).toBeLessThan(persistence);
    expect(migration.match(/v_partner := jsonb_strip_nulls\(/g)).toHaveLength(1);
    expect(migration).toContain("'partner_id', NULLIF(btrim(COALESCE(v_partner->>'partner_id', '')), '')");
    expect(migration).toContain("NULLIF(btrim(v_partner->>'partner_name'), '')");
    expect(migration).toContain("NULLIF(btrim(v_partner->>'name'), '')");
    for (const regression of [
      "partner_id: '  partner-001  '",
      "partner_name: '   '",
      "name: '  Partner One  '",
      'expect(duplicateAssignment.created).toBe(false)',
      "expect(duplicateAssignment.partner.partner_id).toBe('partner-001')",
      "expect(duplicateAssignment.partner.partner_name).toBe('Partner One')",
    ]) expect(pickupIntegration).toContain(regression);
  });

  // Browser selector coverage remains unavailable with the provisioning adapter.
});
