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
  v_departure_action CONSTANT TEXT := 'warehouse_transfers.scan_departure';
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
  EXECUTE format(v_call, v_departure_action, v_transfer, v_departure_params) INTO v_departure;

  DECLARE
    v_resource CONSTANT TEXT := 'warehouse_transfers';
    v_system_scan_fields CONSTANT TEXT[] := ARRAY[
      'source', 'action_key', 'phase', 'warehouse_transfer_id', 'task_id', 'notes',
      'checkpoint_key', 'checkpoint_sequence', 'checkpoint_scope', 'decision_log_id'
    ];
    v_actor UUID := auth.uid();
    v_claim_sub TEXT := NULLIF(current_setting('request.jwt.claims', true), '')::jsonb->>'sub';
    v_transfer_row public.warehouse_transfers%ROWTYPE;
    v_visible_transfer JSONB;
    v_command JSONB;
    v_api_params JSONB := v_departure_params;
    v_params JSONB;
    v_meta JSONB;
    v_scanner_hash TEXT;
    v_managed_device UUID;
    v_barcode TEXT;
    v_handling_unit_code TEXT;
    v_notes TEXT;
    v_branch_id UUID;
    v_device_id UUID;
    v_ops_session_id UUID;
    v_uuid_params_valid BOOLEAN := true;
    v_evidence JSONB;
    v_item RECORD;
  BEGIN
    SET LOCAL ROLE postgres;
    SET LOCAL client_min_messages TO notice;
    SELECT * INTO v_transfer_row FROM public.warehouse_transfers WHERE id = v_transfer::uuid;
    v_visible_transfer := public.ui_get_resource_v1(v_resource, v_transfer::uuid);
    SELECT command INTO v_command
      FROM jsonb_array_elements(COALESCE(public.resolve_settings_merged(
        'ui_command_registry', public.current_user_scope_type(), public.current_user_scope_id()
      )->'commands', '[]'::jsonb)) AS commands(command)
     WHERE command->>'key' = v_departure_action
     LIMIT 1;

    -- The API wrapper looks up its scanner again on replay. Resolve it without writing.
    v_scanner_hash := encode(digest(format('console-v2-browser-scanner:%s:%s',
      COALESCE(v_transfer_row.organization_id, public.current_user_org_id()), v_actor), 'sha256'), 'hex');
    SELECT d.id INTO v_managed_device
      FROM public.user_devices d
     WHERE d.organization_id = COALESCE(v_transfer_row.organization_id, public.current_user_org_id())
       AND d.user_id = v_actor
       AND (d.device_identifier_sha256 = v_scanner_hash OR (
         lower(COALESCE(d.metadata->>'managed', 'false')) IN ('true', 't', '1', 'yes')
         AND d.metadata->>'console_scanner_base_identifier_sha256' = v_scanner_hash
       ))
       AND d.revoked_at IS NULL
     ORDER BY d.last_seen_at DESC NULLS LAST, d.created_at DESC
     LIMIT 1;
    IF v_managed_device IS NOT NULL THEN
      v_api_params := jsonb_set(v_api_params, '{device_id}', to_jsonb(v_managed_device::text), true);
    END IF;

    v_params := COALESCE(v_command#>'{execution,params}', '{}'::jsonb) || v_api_params;
    IF jsonb_typeof(v_params) IS DISTINCT FROM 'object' THEN
      v_params := '{}'::jsonb;
    END IF;
    v_meta := COALESCE(v_params->'metadata', '{}'::jsonb);
    IF jsonb_typeof(v_meta) IS DISTINCT FROM 'object' THEN
      v_meta := '{}'::jsonb;
    END IF;
    v_barcode := NULLIF(btrim(v_params->>'barcode'), '');
    v_handling_unit_code := NULLIF(btrim(v_params->>'handling_unit_code'), '');
    v_notes := NULLIF(btrim(v_params->>'notes'), '');
    BEGIN
      v_branch_id := COALESCE(NULLIF(btrim(v_params->>'branch_id'), '')::uuid, v_transfer_row.from_branch_id);
      v_device_id := NULLIF(btrim(v_params->>'device_id'), '')::uuid;
      v_ops_session_id := NULLIF(btrim(v_params->>'ops_session_id'), '')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      v_uuid_params_valid := false;
    END;

    -- Anchor the first call's output rows independently so one failed join cannot hide the others.
    SELECT jsonb_build_object(
      'resource_key_equal', v_resource = 'warehouse_transfers',
      'visible_transfer_id_equal', v_visible_transfer->>'id' IS NOT DISTINCT FROM v_transfer_row.id::text,
      'capability_present', NULLIF(v_command->>'capability', '') IS NOT NULL,
      'action_allowed', v_departure_action IN ('warehouse_transfers.scan_departure', 'warehouse_transfers.scan_arrival'),
      'barcode_present', v_barcode IS NOT NULL,
      'uuid_params_valid', v_uuid_params_valid,
      'managed_device_found', v_managed_device IS NOT NULL,
      'auth_uid_matches_fixture', v_actor = v_user,
      'auth_uid_matches_postgres', v_actor = auth.uid(),
      'claim_sub_matches_fixture', v_claim_sub = v_user::text,
      'auth_uid_matches_claim_sub', v_actor::text = v_claim_sub,
      'task_found_by_org_resource_type', t.organization_id = v_transfer_row.organization_id
        AND t.resource_type = 'warehouse_transfer' AND t.resource_id = v_transfer_row.id
        AND tt.key = 'warehouse_transfer_dispatch',
      'task_org_equal', t.organization_id = v_transfer_row.organization_id,
      'task_resource_type_equal', t.resource_type = 'warehouse_transfer',
      'task_resource_id_equal', t.resource_id = v_transfer_row.id,
      'task_type_row_equal', tt.id = t.task_type_id,
      'task_type_key_equal', tt.key = 'warehouse_transfer_dispatch',
      'task_status', COALESCE(t.status::text, 'missing'),
      'parent_workflow_present', t.metadata->>'parent_workflow_run_id' IS NOT NULL,
      'parent_workflow_row_equal', wr.id::text = t.metadata->>'parent_workflow_run_id',
      'parent_matches_first_workflow', wr.id::text = v_departure->>'workflow_run_id',
      'workflow_template_id_equal', wt.id = wr.workflow_template_id,
      'workflow_template_name_equal', wt.name = 'warehouse_transfer_execute_v1',
      'workflow_transfer_context_equal', wr.context->>'warehouse_transfer_id' = v_transfer_row.id::text,
      'workflow_org_context_equal', COALESCE(wr.context->>'organization_id', t.organization_id::text) = t.organization_id::text
    ) || jsonb_build_object(
      'task_event_task_equal', te.task_id = t.id,
      'task_event_org_equal', te.organization_id = t.organization_id,
      'task_event_to_status', COALESCE(te.to_status::text, 'missing'),
      'task_event_to_status_completed', te.to_status = 'completed',
      'task_event_actor_equal', te.actor_user_id = v_actor,
      'task_event_actor_matches_claim_sub', te.actor_user_id::text = v_claim_sub,
      'task_event_key_equal', te.idempotency_key = COALESCE(
        NULLIF(btrim(v_params->>'idempotency_key'), ''),
        concat_ws(':', 'warehouse_transfer_checkpoint_ui_v1', v_departure_action, v_transfer_row.id::text, t.id::text,
          lower(v_barcode), COALESCE(lower(v_handling_unit_code), ''),
          COALESCE(v_branch_id::text, ''), COALESCE(v_device_id::text, ''), COALESCE(v_ops_session_id::text, ''))
      ),
      'payload_scan_created_equal', te.payload->>'scan_created' = 'true',
      'payload_phase_equal', te.payload->>'phase' = 'dispatch',
      'payload_checkpoint_equal', te.payload->>'checkpoint_key' = 'load',
      'payload_barcode_equal', te.payload->>'barcode' = v_barcode,
      'payload_handling_unit_equal', te.payload->>'handling_unit_code' IS NOT DISTINCT FROM v_handling_unit_code,
      'payload_notes_equal', te.payload->>'notes' IS NOT DISTINCT FROM v_notes,
      'payload_branch_equal', te.payload->>'branch_id' IS NOT DISTINCT FROM v_branch_id::text,
      'payload_device_equal', te.payload->>'device_id' IS NOT DISTINCT FROM v_device_id::text,
      'task_event_ops_session_equal', te.ops_session_id IS NOT DISTINCT FROM v_ops_session_id,
      'dedupe_org_equal', dedupe.organization_id = te.organization_id,
      'dedupe_key_equal', dedupe.idempotency_key = te.idempotency_key,
      'scan_event_dedupe_id_equal', se.id = dedupe.scan_event_id,
      'scan_event_payload_id_equal', se.id::text = te.payload->>'scan_event_id',
      'scan_event_org_equal', se.organization_id = t.organization_id,
      'scan_event_transfer_equal', se.warehouse_transfer_id = t.resource_id,
      'scan_event_actor_equal', se.actor_user_id = v_actor,
      'scan_event_actor_matches_claim_sub', se.actor_user_id::text = v_claim_sub,
      'scan_event_key_equal', se.idempotency_key = te.idempotency_key,
      'scan_event_type_equal', se.scan_type = 'warehouse_checkpoint',
      'scan_event_checkpoint_equal', se.checkpoint_key = 'load',
      'scan_event_barcode_equal', se.barcode = v_barcode,
      'scan_event_branch_equal', se.branch_id IS NOT DISTINCT FROM v_branch_id,
      'scan_event_device_equal', se.device_id IS NOT DISTINCT FROM v_device_id,
      'scan_event_ops_session_equal', se.ops_session_id IS NOT DISTINCT FROM te.ops_session_id,
      'scan_metadata_action_equal', se.metadata->>'action_key' = v_departure_action,
      'scan_metadata_task_id_equal', se.metadata->>'task_id' = t.id::text,
      'scan_metadata_equal', (se.metadata - v_system_scan_fields) = (jsonb_strip_nulls(v_meta) - v_system_scan_fields),
      'scan_metadata_notes_match_or_overridden',
        v_notes IS NOT NULL OR se.metadata->'notes' IS NOT DISTINCT FROM jsonb_strip_nulls(v_meta)->'notes',
      'scan_device_row_found', device.id = se.device_id,
      'scan_device_org_equal', device.organization_id = se.organization_id,
      'scan_device_actor_equal', device.user_id = v_actor,
      'scan_device_not_revoked', device.id IS NOT NULL AND device.revoked_at IS NULL,
      'scan_device_allowed', se.device_id IS NULL OR (device.id IS NOT NULL
        AND device.organization_id = se.organization_id AND device.user_id = v_actor AND device.revoked_at IS NULL)
    ) || jsonb_build_object(
      'scan_metadata_keys', ARRAY(SELECT key FROM jsonb_object_keys(
        COALESCE(se.metadata - v_system_scan_fields, '{}'::jsonb)) AS keys(key) ORDER BY key),
      'expected_metadata_keys', ARRAY(SELECT key FROM jsonb_object_keys(
        jsonb_strip_nulls(v_meta) - v_system_scan_fields) AS keys(key) ORDER BY key)
    ) INTO v_evidence
      FROM (SELECT v_departure AS ids) first_call
      LEFT JOIN public.tasks t ON t.id = (first_call.ids->>'task_id')::uuid
      LEFT JOIN public.task_types tt ON tt.id = t.task_type_id
      LEFT JOIN public.task_events te ON te.id = (first_call.ids->>'task_event_id')::uuid
      LEFT JOIN public.scan_events se ON se.id = (first_call.ids->>'scan_event_id')::uuid
      LEFT JOIN public.user_devices device ON device.id = se.device_id
      LEFT JOIN LATERAL (
        SELECT d.* FROM public.scan_event_dedupe d
         WHERE (d.organization_id = te.organization_id AND d.idempotency_key = te.idempotency_key)
            OR d.scan_event_id = se.id
         ORDER BY (d.organization_id = te.organization_id AND d.idempotency_key = te.idempotency_key) DESC NULLS LAST,
                  d.organization_id, d.idempotency_key
         LIMIT 1
      ) dedupe ON TRUE
      LEFT JOIN public.workflow_runs wr ON wr.id::text = t.metadata->>'parent_workflow_run_id'
      LEFT JOIN public.workflow_templates wt ON wt.id = wr.workflow_template_id;

    FOR v_item IN SELECT key, value FROM jsonb_each_text(v_evidence) LOOP
      RAISE NOTICE 'B04DIAG %=%', v_item.key, COALESCE(v_item.value, 'false');
    END LOOP;
    SET LOCAL ROLE authenticated;
  END;

  RETURN NEXT ok(v_departure @> '{"scan_created":true,"transfer_status":"in_transit"}',
                 'the first departure writes a scan and dispatches the transfer');
  BEGIN
    EXECUTE format(v_call, v_departure_action, v_transfer, v_departure_params) INTO v_replay;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'B04DIAG replay_error=%', SQLSTATE;
    v_replay := NULL;
  END;
  RETURN NEXT ok(v_replay @> jsonb_build_object(
    'scan_created', false, 'transfer_status', 'in_transit', 'task_id', v_departure->'task_id',
    'task_event_id', v_departure->'task_event_id', 'scan_event_id', v_departure->'scan_event_id',
    'workflow_run_id', v_departure->'workflow_run_id'
  ), 'exact departure replay returns the original identifiers');
  RETURN NEXT throws_like(format(v_call, 'warehouse_transfers.scan_departure', v_transfer,
    jsonb_set(v_departure_params, '{metadata,station}', '"inbound"')),
    '%departure only supports draft warehouse_transfers%', 'changed departure metadata cannot replay');
  RETURN NEXT throws_ok(format(v_call, 'warehouse_transfers.scan_arrival', v_transfer,
    v_arrival_params || jsonb_build_object('idempotency_key', v_departure_key)),
    '23514', 'Warehouse checkpoint idempotency key belongs to another scan', 'arrival cannot consume the departure key');

  EXECUTE format(v_call, 'warehouse_transfers.scan_arrival', v_transfer, v_arrival_params) INTO v_arrival;
  RETURN NEXT ok(v_arrival @> '{"scan_created":true,"transfer_status":"received"}',
                 'the first arrival generates its key and receives the transfer');
  BEGIN
    EXECUTE format(v_call, 'warehouse_transfers.scan_arrival', v_transfer, v_arrival_params) INTO v_replay;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'B04DIAG arrival_replay_error=%', SQLSTATE;
    v_replay := NULL;
  END;
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
