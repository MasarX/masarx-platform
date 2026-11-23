SET search_path TO public, pgtap, extensions, pg_temp;
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(13);

CREATE FUNCTION pg_temp.check_warehouse_checkpoint_exact_replay()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $test$
DECLARE
  v_org UUID := gen_random_uuid();
  v_user UUID := gen_random_uuid();
  v_from UUID := gen_random_uuid();
  v_to UUID := gen_random_uuid();
  v_marker TEXT := 'checkpoint-' || left(v_org::text, 8);
  v_client UUID;
  v_shipment UUID;
  v_transfer TEXT;
  v_run UUID;
  v_pack_task UUID;
  v_claims JSONB;
  v_progress JSONB;
  v_departure_key TEXT := gen_random_uuid()::text;
  v_departure_params JSONB;
  v_arrival_params JSONB;
  v_departure JSONB;
  v_arrival JSONB;
  v_replay JSONB;
  v_registry RECORD;
  v_other_commands CONSTANT JSONPATH := '$.commands[*] ? (!exists(@.key) ||
    (@.key != "warehouse_transfers.scan_departure" && @.key != "warehouse_transfers.scan_arrival"))';
  v_call TEXT := 'SELECT api.ui_execute_warehouse_transfer_checkpoint_v1(%L, ''warehouse_transfers'', NULL, %L, 1, %L)';
BEGIN
  INSERT INTO public.organizations (id, name, slug, billing_status)
  VALUES (v_org, 'Checkpoint replay tenant', v_marker, 'active');
  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type)
  VALUES (v_user, v_org, v_user::text || chr(64) || concat_ws('.', 'example', 'test'),
          'Checkpoint operator', 'ops_admin', 'active', 'tenant');
  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, assigned_by_user_id)
  SELECT v_org, v_user, role_id, v_user
    FROM public.provision_rbac_roles_from_templates_v1(v_org, ARRAY['ops_admin'], v_user)
  ON CONFLICT DO NOTHING;

  INSERT INTO public.branches (id, organization_id, code, name, timezone, is_active)
  VALUES (v_from, v_org, 'origin', 'Origin', 'UTC', true),
         (v_to, v_org, 'destination', 'Destination', 'UTC', true);
  INSERT INTO public.clients (organization_id, name, slug, sla_tier, status)
  VALUES (v_org, 'Checkpoint client', v_marker, 'standard', 'active')
  RETURNING id INTO v_client;
  INSERT INTO public.shipments (organization_id, client_id, service_type, tracking_number, status)
  VALUES (v_org, v_client, 'delivery', v_marker, 'created')
  RETURNING id INTO v_shipment;
  INSERT INTO public.handling_units (organization_id, branch_id, unit_type, status, code)
  VALUES (v_org, v_from, 'bag', 'open', v_marker);

  v_claims := jsonb_build_object('role', 'authenticated', 'sub', v_user,
                                 'organization_id', v_org, 'access_scope_type', 'tenant');
  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', jsonb_set(v_claims, '{role}', '"service_role"')::text, true);
  v_transfer := public.create_warehouse_transfer_manifest_v1(jsonb_build_object(
    'organization_id', v_org, 'transfer_code', v_marker, 'from_branch_id', v_from,
    'to_branch_id', v_to, 'shipment_ids', jsonb_build_array(v_shipment)
  ))->>'transfer_id';

  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', v_claims::text, true);
  SET LOCAL ROLE authenticated;
  v_run := (api.ui_execute_warehouse_transfer_dispatch_v1(
    'warehouse_transfers.dispatch', 'warehouse_transfers', NULL, v_transfer, 1, '{}'
  )->>'workflow_run_id')::uuid;
  SET LOCAL ROLE postgres;
  SELECT t.id INTO STRICT v_pack_task
    FROM public.tasks t JOIN public.task_types tt ON tt.id = t.task_type_id
   WHERE t.organization_id = v_org AND t.resource_type = 'warehouse_transfer'
     AND t.resource_id = v_transfer::uuid AND tt.key = 'warehouse_transfer_pack';
  SET LOCAL ROLE authenticated;
  PERFORM public.transition_task_v1(v_pack_task, 'completed', NULL, '{}', gen_random_uuid()::text);
  SET LOCAL ROLE postgres;

  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', jsonb_set(v_claims, '{role}', '"service_role"')::text, true);
  FOR v_step IN 1..40 LOOP
    v_progress := public.progress_workflow_run(v_run);
    EXIT WHEN v_progress->>'status' IN ('pending', 'failed');
    IF v_progress->>'status' = 'waiting' THEN
      UPDATE public.workflow_run_steps SET run_at = now() - interval '1 second'
       WHERE id = (SELECT id FROM public.workflow_run_steps
                    WHERE workflow_run_id = v_run AND step_status = 'pending'
                    ORDER BY sequence_order LIMIT 1);
    END IF;
  END LOOP;

  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims', v_claims::text, true);
  SET LOCAL ROLE authenticated;
  v_arrival_params := jsonb_build_object('barcode', v_marker, 'handling_unit_code', v_marker);
  v_departure_params := v_arrival_params || jsonb_build_object(
    'idempotency_key', v_departure_key, 'notes', 'Loaded', 'metadata', jsonb_build_object('station', 'outbound')
  );
  EXECUTE format(v_call, 'warehouse_transfers.scan_departure', v_transfer, v_departure_params) INTO v_departure;
  RETURN NEXT ok(v_departure @> '{"scan_created":true,"transfer_status":"in_transit"}',
                 'the first departure writes a scan and dispatches the transfer');
  EXECUTE format(v_call, 'warehouse_transfers.scan_departure', v_transfer, v_departure_params) INTO v_replay;
  RETURN NEXT ok(v_replay @> jsonb_build_object(
    'scan_created', false, 'transfer_status', 'in_transit', 'task_id', v_departure->'task_id',
    'task_event_id', v_departure->'task_event_id', 'scan_event_id', v_departure->'scan_event_id',
    'workflow_run_id', v_departure->'workflow_run_id'
  ), 'exact departure replay returns the original identifiers');
  RETURN NEXT throws_like(format(v_call, 'warehouse_transfers.scan_departure', v_transfer,
    jsonb_set(v_departure_params, '{metadata,station}', '"inbound"')),
    '%departure only supports draft warehouse_transfers%', 'changed departure metadata cannot replay');
  RETURN NEXT throws_like(format(v_call, 'warehouse_transfers.scan_arrival', v_transfer,
    v_arrival_params || jsonb_build_object('idempotency_key', v_departure_key)),
    '%idempotency key belongs to another scan%', 'arrival cannot consume the departure key');

  EXECUTE format(v_call, 'warehouse_transfers.scan_arrival', v_transfer, v_arrival_params) INTO v_arrival;
  RETURN NEXT ok(v_arrival @> '{"scan_created":true,"transfer_status":"received"}',
                 'the first arrival generates its key and receives the transfer');
  EXECUTE format(v_call, 'warehouse_transfers.scan_arrival', v_transfer, v_arrival_params) INTO v_replay;
  RETURN NEXT ok(v_replay @> jsonb_build_object(
    'scan_created', false, 'transfer_status', 'received', 'task_id', v_arrival->'task_id',
    'task_event_id', v_arrival->'task_event_id', 'scan_event_id', v_arrival->'scan_event_id',
    'workflow_run_id', v_arrival->'workflow_run_id'
  ), 'exact arrival replay works with the generated key and managed scanner');
  SET LOCAL ROLE postgres;
  RETURN NEXT is((SELECT count(*) FROM public.scan_events
    WHERE organization_id = v_org AND warehouse_transfer_id = v_transfer::uuid),
    2::bigint, 'both replays leave exactly two scan events');
  RETURN NEXT is((SELECT count(*) FROM public.task_events WHERE organization_id = v_org
    AND task_id IN ((v_departure->>'task_id')::uuid, (v_arrival->>'task_id')::uuid)
    AND to_status = 'completed'), 2::bigint, 'both replays leave exactly two task completions');
  RETURN NEXT is((
    SELECT count(*) FROM public.settings s
    CROSS JOIN LATERAL jsonb_array_elements(s.cached_value->'commands') command
    WHERE s.category = 'ui_command_registry' AND s.scope_type = 'global'
      AND command->>'key' IN ('warehouse_transfers.scan_departure', 'warehouse_transfers.scan_arrival')
      AND command#>'{execution,input_schema,fields}' @> '[{"key":"ops_session_id"}]'
      AND NOT command#>'{execution,input_schema,fields}' @> '[{"key":"device_id"}]'
  ), 2::bigint, 'both commands keep the ops session field and use the managed scanner');

  SELECT s.cached_value, active.value AS current_value, active.change_reason AS current_reason,
         active.approved_at, active.effective_until AS current_end, active.schema_version,
         prior.value AS prior_value, prior.change_reason AS prior_reason, prior.effective_from AS prior_start,
         prior.effective_until AS prior_end, prior.schema_version AS prior_schema_version
    INTO v_registry
    FROM public.settings s
    JOIN public.settings_versions active ON active.id = s.settings_version_id AND active.scope_hash = s.scope_hash
    LEFT JOIN LATERAL (
      SELECT sv.value, sv.change_reason, sv.effective_from, sv.effective_until, sv.schema_version
        FROM public.settings_versions sv
       WHERE sv.category = s.category AND sv.scope_type = s.scope_type AND sv.scope_hash = s.scope_hash
         AND sv.version < active.version AND sv.approved_at IS NOT NULL
       ORDER BY sv.version DESC
       LIMIT 1
    ) prior ON TRUE
   WHERE s.category = 'ui_command_registry' AND s.scope_type = 'global';

  RETURN NEXT ok(v_registry.prior_end > v_registry.prior_start
    AND v_registry.prior_reason = 'Add provider credential retirement action'
    AND v_registry.prior_schema_version = v_registry.schema_version,
    'the closed registry predecessor retains its original reason and schema version');
  RETURN NEXT ok(v_registry.current_end IS NULL AND v_registry.approved_at IS NOT NULL
    AND v_registry.current_reason = 'Use the managed scanner for warehouse checkpoint commands.',
    'the settings pointer references the approved open managed-scanner version');
  RETURN NEXT ok(v_registry.cached_value = v_registry.current_value,
    'the registry cache equals the current version');
  RETURN NEXT ok(jsonb_path_query_array(v_registry.current_value, v_other_commands)
    = jsonb_path_query_array(v_registry.prior_value, v_other_commands),
    'all other commands retain their content and order');
END;
$test$;

SELECT * FROM pg_temp.check_warehouse_checkpoint_exact_replay();
SELECT * FROM finish();
ROLLBACK;
