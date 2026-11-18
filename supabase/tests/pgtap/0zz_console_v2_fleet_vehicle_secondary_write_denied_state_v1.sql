-- pgTAP: Console V2 fleet vehicle secondary write actions deny lower-permission users
-- before mutating documents, maintenance windows, or vehicle event ledgers.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(24);

CREATE OR REPLACE FUNCTION test_console_v2_fleet_vehicle_secondary_write_denied_state_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000f861'::UUID;
  v_branch UUID := '00000000-0000-0000-0000-00000000f862'::UUID;
  v_ops UUID := '00000000-0000-0000-0000-00000000f863'::UUID;
  v_limited UUID := '00000000-0000-0000-0000-00000000f864'::UUID;
  v_vehicle_type UUID := '00000000-0000-0000-0000-00000000f865'::UUID;
  v_vehicle UUID := '00000000-0000-0000-0000-00000000f866'::UUID;
  v_artifact UUID := '00000000-0000-0000-0000-00000000f867'::UUID;
  v_complete_window UUID := '00000000-0000-0000-0000-00000000f868'::UUID;
  v_cancel_window UUID := '00000000-0000-0000-0000-00000000f869'::UUID;
  v_ops_result JSONB;
BEGIN
  RETURN NEXT ok(
    to_regprocedure('api.upload_vehicle_document_v1(jsonb)') IS NOT NULL
    AND has_function_privilege('authenticated', 'api.upload_vehicle_document_v1(jsonb)', 'EXECUTE'),
    'api.upload_vehicle_document_v1 wrapper is available to authenticated users'
  );
  RETURN NEXT ok(
    to_regprocedure('api.schedule_maintenance_v1(jsonb)') IS NOT NULL
    AND has_function_privilege('authenticated', 'api.schedule_maintenance_v1(jsonb)', 'EXECUTE'),
    'api.schedule_maintenance_v1 wrapper is available to authenticated users'
  );
  RETURN NEXT ok(
    to_regprocedure('api.complete_maintenance_v1(jsonb)') IS NOT NULL
    AND has_function_privilege('authenticated', 'api.complete_maintenance_v1(jsonb)', 'EXECUTE'),
    'api.complete_maintenance_v1 wrapper is available to authenticated users'
  );
  RETURN NEXT ok(
    to_regprocedure('api.cancel_maintenance_v1(jsonb)') IS NOT NULL
    AND has_function_privilege('authenticated', 'api.cancel_maintenance_v1(jsonb)', 'EXECUTE'),
    'api.cancel_maintenance_v1 wrapper is available to authenticated users'
  );
  RETURN NEXT ok(
    to_regprocedure('api.record_vehicle_event_v1(jsonb)') IS NOT NULL
    AND has_function_privilege('authenticated', 'api.record_vehicle_event_v1(jsonb)', 'EXECUTE'),
    'api.record_vehicle_event_v1 wrapper is available to authenticated users'
  );

  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Console V2 Fleet Secondary Denied Org', 'console-v2-fleet-secondary-denied');

  INSERT INTO public.branches (id, organization_id, code, name, timezone, is_active)
  VALUES (v_branch, v_org, 'fleet-secondary-denied', 'Fleet Secondary Denied Branch', 'UTC', TRUE);

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id, status)
  VALUES
    (v_ops, v_org, 'fleet-secondary-denied-ops@example.com', 'Fleet Secondary Denied Ops', 'fleet_manager', 'tenant', NULL, 'active'),
    (v_limited, v_org, 'fleet-secondary-denied-limited@example.com', 'Fleet Secondary Denied Limited', 'client_admin', 'tenant', NULL, 'active');

  INSERT INTO public.vehicle_types (id, organization_id, key, name, is_active)
  VALUES (v_vehicle_type, v_org, 'fleet-secondary-van', 'Fleet Secondary Van', TRUE);

  INSERT INTO public.vehicles (id, organization_id, branch_id, vehicle_type_id, plate_number, status, is_active)
  VALUES (v_vehicle, v_org, v_branch, v_vehicle_type, 'DENIED-SECONDARY-1', 'active', TRUE);

  INSERT INTO public.artifacts (
    id,
    organization_id,
    storage_bucket,
    storage_key,
    mime_type,
    size_bytes,
    sha256,
    created_by_user_id,
    source_system,
    metadata
  )
  VALUES (
    v_artifact,
    v_org,
    'vehicle-documents-test',
    'vehicles/secondary-denied.pdf',
    'application/pdf',
    1024,
    'fleetsecondarydeniedsha256',
    v_ops,
    'pgtap',
    jsonb_build_object('test', 'fleet_secondary_denied')
  );

  INSERT INTO public.vehicle_maintenance_windows (
    id,
    organization_id,
    vehicle_id,
    window_start_at,
    window_end_at,
    status,
    reason
  )
  VALUES
    (v_complete_window, v_org, v_vehicle, now() - interval '2 hours', now() + interval '1 hour', 'scheduled', 'oil_change'),
    (v_cancel_window, v_org, v_vehicle, now() + interval '1 day', now() + interval '1 day 2 hours', 'scheduled', 'inspection');

  PERFORM public.provision_rbac_roles_from_templates_v1(v_org, ARRAY['fleet_manager'], v_ops);
  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, assigned_by_user_id, metadata)
  SELECT v_org, v_ops, r.id, v_ops, jsonb_build_object('seed', TRUE, 'source', 'pgtap')
    FROM public.rbac_roles r
   WHERE r.organization_id = v_org
     AND r.key = 'fleet_manager'
  ON CONFLICT DO NOTHING;

  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_limited::TEXT, TRUE);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::TEXT, TRUE);

  RETURN NEXT ok(
    NOT public.user_has_capability_v1('fleet.write', 'tenant', v_org),
    'limited fleet user lacks tenant fleet.write'
  );

  PERFORM set_config('request.jwt.claim.sub', v_ops::TEXT, TRUE);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::TEXT, TRUE);
  RETURN NEXT ok(
    public.user_has_capability_v1('fleet.write', 'tenant', v_org),
    'fleet ops user has tenant fleet.write'
  );

  PERFORM set_config('request.jwt.claim.sub', v_limited::TEXT, TRUE);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::TEXT, TRUE);
  RETURN NEXT throws_ok(
    format(
      $q$ SELECT public.upload_vehicle_document_v1(jsonb_build_object('vehicle_id', %L, 'doc_type', 'registration', 'artifact_id', %L, 'issuer', 'Denied Issuer')) $q$,
      v_vehicle,
      v_artifact
    ),
    '42501',
    NULL,
    'limited user denied public upload_vehicle_document_v1'
  );
  RETURN NEXT throws_ok(
    format(
      $q$ SELECT api.upload_vehicle_document_v1(jsonb_build_object('vehicle_id', %L, 'doc_type', 'registration', 'artifact_id', %L, 'issuer', 'Denied Issuer')) $q$,
      v_vehicle,
      v_artifact
    ),
    '42501',
    NULL,
    'limited user denied api upload_vehicle_document_v1'
  );
  RETURN NEXT throws_ok(
    format(
      $q$ SELECT public.schedule_maintenance_v1(jsonb_build_object('vehicle_id', %L, 'window_start_at', (now() + interval '3 days')::TEXT, 'window_end_at', (now() + interval '3 days 2 hours')::TEXT, 'reason', 'inspection')) $q$,
      v_vehicle
    ),
    '42501',
    NULL,
    'limited user denied public schedule_maintenance_v1'
  );
  RETURN NEXT throws_ok(
    format(
      $q$ SELECT api.schedule_maintenance_v1(jsonb_build_object('vehicle_id', %L, 'window_start_at', (now() + interval '3 days')::TEXT, 'window_end_at', (now() + interval '3 days 2 hours')::TEXT, 'reason', 'inspection')) $q$,
      v_vehicle
    ),
    '42501',
    NULL,
    'limited user denied api schedule_maintenance_v1'
  );
  RETURN NEXT throws_ok(
    format(
      $q$ SELECT public.complete_maintenance_v1(jsonb_build_object('vehicle_maintenance_window_id', %L, 'notes', 'denied complete')) $q$,
      v_complete_window
    ),
    '42501',
    NULL,
    'limited user denied public complete_maintenance_v1'
  );
  RETURN NEXT throws_ok(
    format(
      $q$ SELECT api.complete_maintenance_v1(jsonb_build_object('vehicle_maintenance_window_id', %L, 'notes', 'denied complete')) $q$,
      v_complete_window
    ),
    '42501',
    NULL,
    'limited user denied api complete_maintenance_v1'
  );
  RETURN NEXT throws_ok(
    format(
      $q$ SELECT public.cancel_maintenance_v1(jsonb_build_object('vehicle_maintenance_window_id', %L, 'reason', 'operator_cancelled')) $q$,
      v_cancel_window
    ),
    '42501',
    NULL,
    'limited user denied public cancel_maintenance_v1'
  );
  RETURN NEXT throws_ok(
    format(
      $q$ SELECT api.cancel_maintenance_v1(jsonb_build_object('vehicle_maintenance_window_id', %L, 'reason', 'operator_cancelled')) $q$,
      v_cancel_window
    ),
    '42501',
    NULL,
    'limited user denied api cancel_maintenance_v1'
  );
  RETURN NEXT throws_ok(
    format(
      $q$ SELECT public.record_vehicle_event_v1(jsonb_build_object('vehicle_id', %L, 'event_type', 'fuel', 'fuel_liters', '12.5', 'odometer_km', '100')) $q$,
      v_vehicle
    ),
    '42501',
    NULL,
    'limited user denied public record_vehicle_event_v1'
  );
  RETURN NEXT throws_ok(
    format(
      $q$ SELECT api.record_vehicle_event_v1(jsonb_build_object('vehicle_id', %L, 'event_type', 'fuel', 'fuel_liters', '12.5', 'odometer_km', '100')) $q$,
      v_vehicle
    ),
    '42501',
    NULL,
    'limited user denied api record_vehicle_event_v1'
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT is(
    (SELECT COUNT(*)::INT FROM public.vehicle_documents WHERE organization_id = v_org),
    0,
    'denied document upload writes no vehicle_documents rows'
  );
  RETURN NEXT is(
    (SELECT COUNT(*)::INT FROM public.artifact_links WHERE organization_id = v_org AND artifact_id = v_artifact),
    0,
    'denied document upload writes no artifact_links rows'
  );
  RETURN NEXT is(
    (SELECT COUNT(*)::INT FROM public.vehicle_maintenance_windows WHERE organization_id = v_org),
    2,
    'denied schedule attempt writes no extra maintenance windows'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.vehicle_maintenance_windows
       WHERE id = v_complete_window
         AND organization_id = v_org
         AND status = 'scheduled'
         AND completed_at IS NULL
         AND cancelled_at IS NULL
    )
    AND EXISTS (
      SELECT 1
        FROM public.vehicle_maintenance_windows
       WHERE id = v_cancel_window
         AND organization_id = v_org
         AND status = 'scheduled'
         AND completed_at IS NULL
         AND cancelled_at IS NULL
    ),
    'denied maintenance complete/cancel attempts leave windows scheduled'
  );
  RETURN NEXT is(
    (SELECT COUNT(*)::INT FROM public.vehicle_events WHERE organization_id = v_org AND vehicle_id = v_vehicle),
    0,
    'denied maintenance and telemetry attempts write no vehicle_events rows'
  );
  RETURN NEXT ok(
    NOT EXISTS (
      SELECT 1
        FROM public.decision_log
       WHERE organization_id = v_org
         AND performed_by_system IN (
           'upload_vehicle_document_v1',
           'schedule_maintenance_v1',
           'complete_maintenance_v1',
           'cancel_maintenance_v1',
           'record_vehicle_event_v1'
         )
    ),
    'denied secondary write attempts write no decision log rows'
  );

  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_ops::TEXT, TRUE);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::TEXT, TRUE);
  v_ops_result := api.record_vehicle_event_v1(jsonb_build_object(
    'vehicle_id', v_vehicle,
    'event_type', 'fuel',
    'fuel_liters', '37.25',
    'cost_amount', '186.25',
    'cost_currency', 'SAR',
    'odometer_km', '45678'
  ));
  RETURN NEXT ok(
    COALESCE((v_ops_result->>'ok')::BOOLEAN, FALSE)
    AND EXISTS (
      SELECT 1
        FROM public.vehicle_events
       WHERE organization_id = v_org
         AND vehicle_id = v_vehicle
         AND event_type = 'fuel'
         AND fuel_liters = 37.25
         AND cost_currency = 'SAR'
    ),
    'fleet ops user can still record vehicle event through api wrapper'
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN;
END;
$function$;

SELECT * FROM test_console_v2_fleet_vehicle_secondary_write_denied_state_v1();

SELECT * FROM finish();

ROLLBACK;
