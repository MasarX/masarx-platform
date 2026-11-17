-- Plan: PLAN-202603-marketplace-network-product-complete / Step: S05
-- Migration: Marketplace UI command registry + executor handlers for product-complete flows

BEGIN;
SELECT pg_advisory_lock(hashtext('202603081290_marketplace_ui_command_executor_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Rewrite marketplace command registry entries for generic UI/mobile execution
-------------------------------------------------------------------------------

DO $$
DECLARE
  v_row RECORD;
  v_current JSONB;
  v_commands JSONB;
  v_updated JSONB;
  v_candidate JSONB;
  v_item JSONB;
  v_new_commands JSONB := jsonb_build_array(
    jsonb_build_object(
      'key', 'marketplace.release',
      'label', 'Release request',
      'description', 'Update the release posture for the selected marketplace request.',
      'capability', 'marketplace_requests.write',
      'schema_category', 'resource:marketplace_requests',
      'selection', jsonb_build_object('mode', 'single', 'min_count', 1, 'max_count', 1),
      'execution', jsonb_build_object(
        'type', 'rpc',
        'rpc', 'ui_execute_command_v1',
        'payload_key', 'payload',
        'input_schema', jsonb_build_object(
          'version', 'v1',
          'title', 'Release request',
          'description', 'Set private-pool, curated-network, or public release.',
          'fields', jsonb_build_array(
            jsonb_build_object(
              'key', 'release_state',
              'label', 'Release state',
              'type', 'text',
              'required', true,
              'placeholder', 'private_pool | curated_network | public',
              'default_value', 'curated_network'
            )
          )
        ),
        'params', jsonb_build_object('handler', 'marketplace_request_release')
      )
    ),
    jsonb_build_object(
      'key', 'marketplace.reopen',
      'label', 'Reopen request',
      'description', 'Reopen the selected marketplace request.',
      'capability', 'marketplace_requests.write',
      'schema_category', 'resource:marketplace_requests',
      'selection', jsonb_build_object('mode', 'single', 'min_count', 1, 'max_count', 1),
      'execution', jsonb_build_object(
        'type', 'rpc',
        'rpc', 'ui_execute_command_v1',
        'params', jsonb_build_object('handler', 'marketplace_request_reopen')
      )
    ),
    jsonb_build_object(
      'key', 'marketplace.expire',
      'label', 'Expire request',
      'description', 'Expire the selected marketplace request.',
      'capability', 'marketplace_requests.write',
      'schema_category', 'resource:marketplace_requests',
      'selection', jsonb_build_object('mode', 'single', 'min_count', 1, 'max_count', 1),
      'execution', jsonb_build_object(
        'type', 'rpc',
        'rpc', 'ui_execute_command_v1',
        'payload_key', 'payload',
        'confirm', jsonb_build_object('tone', 'danger'),
        'input_schema', jsonb_build_object(
          'version', 'v1',
          'title', 'Expire request',
          'description', 'Optional reason recorded on request, offers, and awards.',
          'fields', jsonb_build_array(
            jsonb_build_object(
              'key', 'reason',
              'label', 'Reason',
              'type', 'textarea',
              'required', false,
              'placeholder', 'Why is this request expiring early?'
            )
          )
        ),
        'params', jsonb_build_object('handler', 'marketplace_request_expire')
      )
    ),
    jsonb_build_object(
      'key', 'marketplace.submit_offer',
      'label', 'Submit offer',
      'description', 'Submit pricing and terms for the selected marketplace request.',
      'capability', 'marketplace_offers.write',
      'schema_category', 'resource:marketplace_requests',
      'selection', jsonb_build_object('mode', 'single', 'min_count', 1, 'max_count', 1),
      'execution', jsonb_build_object(
        'type', 'rpc',
        'rpc', 'ui_execute_command_v1',
        'payload_key', 'payload',
        'input_schema', jsonb_build_object(
          'version', 'v1',
          'title', 'Submit offer',
          'description', 'Enter notes plus JSON for offer terms and pricing.',
          'fields', jsonb_build_array(
            jsonb_build_object('key', 'message', 'label', 'Message', 'type', 'textarea', 'required', false, 'placeholder', 'Coverage, SLA, and operational notes'),
            jsonb_build_object('key', 'terms_json', 'label', 'Terms JSON', 'type', 'textarea', 'required', false, 'placeholder', '{"service_level":"same_day"}', 'default_value', '{"service_level":"same_day"}'),
            jsonb_build_object('key', 'pricing_json', 'label', 'Pricing JSON', 'type', 'textarea', 'required', false, 'placeholder', '{"amount":250,"currency":"SAR"}', 'default_value', '{"amount":250,"currency":"SAR"}')
          )
        ),
        'params', jsonb_build_object('handler', 'marketplace_offer_submit')
      )
    ),
    jsonb_build_object(
      'key', 'marketplace.counter',
      'label', 'Counter offer',
      'description', 'Counter the selected marketplace offer.',
      'capability', 'marketplace_requests.write',
      'schema_category', 'resource:marketplace_offers',
      'selection', jsonb_build_object('mode', 'single', 'min_count', 1, 'max_count', 1),
      'execution', jsonb_build_object(
        'type', 'rpc',
        'rpc', 'ui_execute_command_v1',
        'payload_key', 'payload',
        'input_schema', jsonb_build_object(
          'version', 'v1',
          'title', 'Counter offer',
          'description', 'Send revised commercial terms back to the supplier.',
          'fields', jsonb_build_array(
            jsonb_build_object('key', 'message', 'label', 'Message', 'type', 'textarea', 'required', false, 'placeholder', 'Explain the counter terms'),
            jsonb_build_object('key', 'terms_json', 'label', 'Terms JSON', 'type', 'textarea', 'required', false, 'placeholder', '{"service_level":"same_day"}'),
            jsonb_build_object('key', 'pricing_json', 'label', 'Pricing JSON', 'type', 'textarea', 'required', false, 'placeholder', '{"amount":240,"currency":"SAR"}')
          )
        ),
        'params', jsonb_build_object('handler', 'marketplace_offer_counter')
      )
    ),
    jsonb_build_object(
      'key', 'marketplace.accept_award',
      'label', 'Accept award',
      'description', 'Accept the selected marketplace award and materialize work if policy allows.',
      'capability', 'marketplace_awards.write',
      'schema_category', 'resource:marketplace_awards',
      'selection', jsonb_build_object('mode', 'single', 'min_count', 1, 'max_count', 1),
      'execution', jsonb_build_object(
        'type', 'rpc',
        'rpc', 'ui_execute_command_v1',
        'params', jsonb_build_object('handler', 'marketplace_award_respond', 'decision', 'accepted')
      )
    ),
    jsonb_build_object(
      'key', 'marketplace.reject_award',
      'label', 'Reject award',
      'description', 'Reject the selected marketplace award.',
      'capability', 'marketplace_awards.write',
      'schema_category', 'resource:marketplace_awards',
      'selection', jsonb_build_object('mode', 'single', 'min_count', 1, 'max_count', 1),
      'execution', jsonb_build_object(
        'type', 'rpc',
        'rpc', 'ui_execute_command_v1',
        'payload_key', 'payload',
        'confirm', jsonb_build_object('tone', 'danger'),
        'input_schema', jsonb_build_object(
          'version', 'v1',
          'title', 'Reject award',
          'description', 'Optional note is stored in metadata for operator review.',
          'fields', jsonb_build_array(
            jsonb_build_object('key', 'response_note', 'label', 'Note', 'type', 'textarea', 'required', false, 'placeholder', 'Why is this award being rejected?')
          )
        ),
        'params', jsonb_build_object('handler', 'marketplace_award_respond', 'decision', 'rejected')
      )
    ),
    jsonb_build_object(
      'key', 'marketplace.complete_work',
      'label', 'Complete work package',
      'description', 'Record proof and mark the selected work package complete.',
      'capability', 'marketplace_work_packages.write',
      'schema_category', 'resource:marketplace_work_packages',
      'selection', jsonb_build_object('mode', 'single', 'min_count', 1, 'max_count', 1),
      'execution', jsonb_build_object(
        'type', 'rpc',
        'rpc', 'ui_execute_command_v1',
        'payload_key', 'payload',
        'input_schema', jsonb_build_object(
          'version', 'v1',
          'title', 'Complete work package',
          'description', 'Attach proof scores and completion notes for the executed work.',
          'fields', jsonb_build_array(
            jsonb_build_object('key', 'completion_notes', 'label', 'Completion notes', 'type', 'textarea', 'required', false, 'placeholder', 'Delivery evidence, issue notes, or handoff details'),
            jsonb_build_object('key', 'pod_reference', 'label', 'Proof reference', 'type', 'text', 'required', false, 'placeholder', 'Photo reference or proof id'),
            jsonb_build_object('key', 'proof_quality', 'label', 'Proof quality', 'type', 'text', 'required', false, 'placeholder', '1-5'),
            jsonb_build_object('key', 'feedback_score', 'label', 'Feedback score', 'type', 'text', 'required', false, 'placeholder', '1-5')
          )
        ),
        'params', jsonb_build_object('handler', 'marketplace_work_package_complete')
      )
    ),
    jsonb_build_object(
      'key', 'marketplace.finalize_settlement',
      'label', 'Finalize settlement',
      'description', 'Finalize settlement for the selected work package.',
      'capability', 'marketplace_contracts.write',
      'schema_category', 'resource:marketplace_work_packages',
      'selection', jsonb_build_object('mode', 'single', 'min_count', 1, 'max_count', 1),
      'execution', jsonb_build_object(
        'type', 'rpc',
        'rpc', 'ui_execute_command_v1',
        'params', jsonb_build_object('handler', 'marketplace_settlement_finalize')
      )
    ),
    jsonb_build_object(
      'key', 'marketplace.reverse_settlement',
      'label', 'Reverse settlement',
      'description', 'Reverse settlement for the selected work package.',
      'capability', 'marketplace_contracts.write',
      'schema_category', 'resource:marketplace_work_packages',
      'selection', jsonb_build_object('mode', 'single', 'min_count', 1, 'max_count', 1),
      'execution', jsonb_build_object(
        'type', 'rpc',
        'rpc', 'ui_execute_command_v1',
        'payload_key', 'payload',
        'confirm', jsonb_build_object('tone', 'danger'),
        'input_schema', jsonb_build_object(
          'version', 'v1',
          'title', 'Reverse settlement',
          'description', 'Capture the reason for rolling the work package back to completed.',
          'fields', jsonb_build_array(
            jsonb_build_object('key', 'reason', 'label', 'Reason', 'type', 'textarea', 'required', false, 'placeholder', 'Why should settlement be reversed?')
          )
        ),
        'params', jsonb_build_object('handler', 'marketplace_settlement_reverse')
      )
    ),
    jsonb_build_object(
      'key', 'marketplace.publish_availability',
      'label', 'Publish availability',
      'description', 'Create or update a provider availability window.',
      'capability', 'marketplace_participants.write',
      'schema_category', 'resource:marketplace_availability_windows',
      'selection', jsonb_build_object('mode', 'any', 'min_count', 0, 'max_count', 1),
      'execution', jsonb_build_object(
        'type', 'rpc',
        'rpc', 'ui_execute_command_v1',
        'payload_key', 'payload',
        'input_schema', jsonb_build_object(
          'version', 'v1',
          'title', 'Publish availability',
          'description', 'Use ISO timestamps and JSON capacity data for the published window.',
          'fields', jsonb_build_array(
            jsonb_build_object('key', 'starts_at', 'label', 'Starts at', 'type', 'text', 'required', true, 'placeholder', '2026-03-10T09:00:00Z'),
            jsonb_build_object('key', 'ends_at', 'label', 'Ends at', 'type', 'text', 'required', true, 'placeholder', '2026-03-10T17:00:00Z'),
            jsonb_build_object('key', 'availability_status', 'label', 'Status', 'type', 'text', 'required', true, 'placeholder', 'available | unavailable | reserved', 'default_value', 'available'),
            jsonb_build_object('key', 'capacity_json', 'label', 'Capacity JSON', 'type', 'textarea', 'required', false, 'placeholder', '{"shipments":20}', 'default_value', '{"shipments":20}')
          )
        ),
        'params', jsonb_build_object('handler', 'marketplace_availability_upsert')
      )
    )
  );
BEGIN
  FOR v_row IN
    SELECT
      s.id AS settings_id,
      s.settings_version_id,
      sv.version,
      sv.value
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_command_registry'
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    v_commands := COALESCE(v_current->'commands', '[]'::jsonb);
    IF jsonb_typeof(v_commands) IS DISTINCT FROM 'array' THEN
      v_commands := '[]'::jsonb;
    END IF;

    FOR v_candidate IN SELECT * FROM jsonb_array_elements(v_new_commands)
    LOOP
      IF EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_commands) AS item
        WHERE item->>'key' = v_candidate->>'key'
      ) THEN
        v_updated := '[]'::jsonb;
        FOR v_item IN SELECT * FROM jsonb_array_elements(v_commands)
        LOOP
          IF v_item->>'key' = v_candidate->>'key' THEN
            v_updated := v_updated || jsonb_build_array(v_candidate);
          ELSE
            v_updated := v_updated || jsonb_build_array(v_item);
          END IF;
        END LOOP;
        v_commands := v_updated;
      ELSE
        v_commands := v_commands || jsonb_build_array(v_candidate);
      END IF;
    END LOOP;

    v_current := jsonb_set(v_current, '{commands}', v_commands, TRUE);

    IF v_current IS DISTINCT FROM v_row.value THEN
      UPDATE public.settings_versions
         SET value = v_current,
             version = COALESCE(v_row.version, 0) + 1,
             change_reason = 'Rewrite marketplace command registry entries for product-complete execution',
             approved_at = now(),
             effective_from = now()
       WHERE id = v_row.settings_version_id;

      UPDATE public.settings
         SET cached_value = v_current,
             last_updated = now()
       WHERE id = v_row.settings_id;
    END IF;
  END LOOP;
END $$;

-------------------------------------------------------------------------------
-- 2) Extend ui_execute_command_v1 with marketplace handlers
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ui_execute_command_v1(
  p_action_key TEXT,
  p_resource_key TEXT,
  p_selection_ids TEXT[],
  p_selection_id TEXT,
  p_selection_count INTEGER,
  p_params JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_registry JSONB := public.resolve_settings_merged('ui_command_registry', v_scope_type, v_scope_id);
  v_command JSONB;
  v_execution JSONB;
  v_capability TEXT;
  v_selection JSONB;
  v_mode TEXT;
  v_min INT;
  v_max INT;
  v_count INT := 0;
  v_ids TEXT[] := COALESCE(p_selection_ids, ARRAY[]::TEXT[]);
  v_id TEXT := NULLIF(p_selection_id, '');
  v_handler TEXT;
  v_static_params JSONB := '{}'::jsonb;
  v_params JSONB := '{}'::jsonb;
  v_patch JSONB;
  v_payload_key TEXT;
  v_selection_key TEXT;
  v_payload JSONB;
  v_context JSONB;
  v_template_id UUID;
  v_run_id UUID;
  v_results JSONB := '[]'::jsonb;
  v_item JSONB;

  -- task_transition handler fields
  v_to_status TEXT;
  v_status_reason TEXT;
  v_idempotency_key TEXT;
  v_transition_payload JSONB;
  v_transition_row RECORD;
  v_task RECORD;
  v_policy_row RECORD;
  v_exception_reason TEXT;
  v_reason_required BOOLEAN;

  -- marketplace handler fields
  v_marketplace_payload JSONB := '{}'::jsonb;
  v_marketplace_metadata JSONB := '{}'::jsonb;
  v_marketplace_message TEXT;
  v_marketplace_terms JSONB := '{}'::jsonb;
  v_marketplace_pricing JSONB := '{}'::jsonb;
  v_marketplace_capacity JSONB := '{}'::jsonb;
  v_marketplace_text TEXT;
  v_marketplace_reason TEXT;
  v_marketplace_decision TEXT;
  v_marketplace_starts_at TIMESTAMPTZ;
  v_marketplace_ends_at TIMESTAMPTZ;
BEGIN
  IF p_action_key IS NULL OR btrim(p_action_key) = '' THEN
    RAISE EXCEPTION 'ui_execute_command_v1 requires action key';
  END IF;

  SELECT value INTO v_command
    FROM jsonb_array_elements(v_registry->'commands') AS value
   WHERE value->>'key' = p_action_key
   LIMIT 1;

  IF v_command IS NULL THEN
    RAISE EXCEPTION 'ui_execute_command_v1 unknown command %', p_action_key;
  END IF;

  v_capability := NULLIF(v_command->>'capability', '');
  IF v_capability IS NOT NULL THEN
    PERFORM public.assert_capability_v1(v_capability, v_scope_type, v_scope_id);
  END IF;

  v_selection := v_command->'selection';
  v_mode := lower(COALESCE(v_selection->>'mode', ''));
  v_min := COALESCE(NULLIF(v_selection->>'min_count', '')::INT,
    CASE WHEN v_mode IN ('none', 'any') THEN 0 ELSE 1 END);
  v_max := COALESCE(NULLIF(v_selection->>'max_count', '')::INT,
    CASE WHEN v_mode = 'single' THEN 1 ELSE NULL END);

  IF v_id IS NOT NULL AND array_length(v_ids, 1) IS NULL THEN
    v_ids := ARRAY[v_id];
  END IF;

  IF v_ids IS NOT NULL AND array_length(v_ids, 1) IS NOT NULL THEN
    v_count := array_length(v_ids, 1);
  ELSIF v_id IS NOT NULL THEN
    v_count := 1;
  ELSE
    v_count := COALESCE(p_selection_count, 0);
  END IF;

  IF v_min IS NOT NULL AND v_count < v_min THEN
    RAISE EXCEPTION 'ui_execute_command_v1 selection below minimum %', v_min;
  END IF;
  IF v_max IS NOT NULL AND v_count > v_max THEN
    RAISE EXCEPTION 'ui_execute_command_v1 selection above maximum %', v_max;
  END IF;

  v_execution := COALESCE(v_command->'execution', '{}'::jsonb);
  v_static_params := COALESCE(v_execution->'params', '{}'::jsonb);
  v_params := v_static_params || COALESCE(p_params, '{}'::jsonb);
  v_handler := lower(COALESCE(NULLIF(v_static_params->>'handler', ''), NULLIF(v_params->>'handler', ''), ''));
  v_patch := COALESCE(v_params->'patch', '{}'::jsonb);

  IF COALESCE(v_command->>'workflow_key', '') <> '' OR (v_execution->>'type') = 'workflow' THEN
    IF COALESCE(v_command->>'workflow_key', '') = '' THEN
      RAISE EXCEPTION 'ui_execute_command_v1 workflow key missing for %', p_action_key;
    END IF;

    SELECT id INTO v_template_id
      FROM public.workflow_templates
     WHERE name = v_command->>'workflow_key'
       AND status = 'active'
     ORDER BY version DESC
     LIMIT 1;

    IF v_template_id IS NULL THEN
      RAISE EXCEPTION 'ui_execute_command_v1 workflow template not found %', v_command->>'workflow_key';
    END IF;

    v_payload_key := NULLIF(v_params->>'payload_key', '');
    v_selection_key := NULLIF(v_params->>'selection_id_key', '');
    IF v_payload_key IS NULL THEN
      v_payload_key := 'selections';
    END IF;
    IF v_selection_key IS NULL THEN
      v_selection_key := 'id';
    END IF;

    v_payload := jsonb_build_object(
      v_payload_key,
      COALESCE(
        (SELECT jsonb_agg(jsonb_build_object(v_selection_key, value)) FROM unnest(v_ids) AS value),
        '[]'::jsonb
      ),
      'selection_ids', to_jsonb(v_ids),
      'selection_id', v_id,
      'selection_count', v_count,
      'resource_key', p_resource_key,
      'organization_id', public.current_user_org_id()
    );

    v_context := jsonb_build_object(
      'organization_id', public.current_user_org_id(),
      'requested_by', auth.uid(),
      'payload', v_payload,
      'ui_command', jsonb_build_object(
        'action_key', p_action_key,
        'resource_key', p_resource_key,
        'params', p_params
      )
    );

    v_run_id := public.start_workflow_run(v_template_id, v_context);

    RETURN jsonb_build_object(
      'status', 'workflow_started',
      'action_key', p_action_key,
      'resource_key', p_resource_key,
      'workflow_run_id', v_run_id
    );
  END IF;

  IF v_handler = 'resource_update' THEN
    IF p_resource_key IS NULL OR btrim(p_resource_key) = '' THEN
      RAISE EXCEPTION 'ui_execute_command_v1 requires resource key';
    END IF;
    IF jsonb_typeof(v_patch) <> 'object' THEN
      RAISE EXCEPTION 'ui_execute_command_v1 patch must be object';
    END IF;
    FOREACH v_id IN ARRAY v_ids LOOP
      v_item := public.ui_update_resource_v1(p_resource_key, v_id, v_patch);
      v_results := v_results || jsonb_build_array(v_item);
    END LOOP;
    RETURN jsonb_build_object(
      'status', 'updated',
      'action_key', p_action_key,
      'resource_key', p_resource_key,
      'count', v_count,
      'items', v_results
    );
  END IF;

  IF v_handler = 'resource_delete' THEN
    IF p_resource_key IS NULL OR btrim(p_resource_key) = '' THEN
      RAISE EXCEPTION 'ui_execute_command_v1 requires resource key';
    END IF;
    FOREACH v_id IN ARRAY v_ids LOOP
      v_item := public.ui_delete_resource_v1(p_resource_key, v_id);
      v_results := v_results || jsonb_build_array(v_item);
    END LOOP;
    RETURN jsonb_build_object(
      'status', 'deleted',
      'action_key', p_action_key,
      'resource_key', p_resource_key,
      'count', v_count,
      'items', v_results
    );
  END IF;

  IF v_handler = 'task_transition' THEN
    IF p_resource_key IS NULL OR btrim(p_resource_key) = '' THEN
      RAISE EXCEPTION 'ui_execute_command_v1 requires resource key';
    END IF;

    v_to_status := lower(COALESCE(NULLIF(v_static_params->>'to_status', ''), NULLIF(v_params->>'to_status', ''), ''));
    IF v_to_status = '' THEN
      RAISE EXCEPTION 'ui_execute_command_v1 task_transition requires to_status';
    END IF;

    v_status_reason := NULLIF(COALESCE(v_static_params->>'status_reason', v_params->>'status_reason', ''), '');
    v_transition_payload := COALESCE(v_params->'payload', '{}'::jsonb);

    FOREACH v_id IN ARRAY v_ids LOOP
      IF v_to_status = 'exception' THEN
        SELECT t.id, t.organization_id, t.client_id, t.sender_id, t.resource_type, t.resource_id
          INTO v_task
          FROM public.tasks t
         WHERE t.id = v_id::uuid
         LIMIT 1;

        IF v_task.id IS NULL THEN
          RAISE EXCEPTION 'ui_execute_command_v1 task_transition task not found: %', v_id USING ERRCODE = '23503';
        END IF;

        SELECT *
          INTO v_policy_row
          FROM public.resolve_pod_policy(
            jsonb_strip_nulls(
              jsonb_build_object(
                'organization_id', v_task.organization_id,
                'client_id', v_task.client_id,
                'sender_id', v_task.sender_id,
                'resource_type', v_task.resource_type,
                'resource_id', v_task.resource_id
              )
            )
          )
        LIMIT 1;

        v_reason_required := COALESCE(
          (v_policy_row.value->'requirements'->'exception'->>'exception_reason_required')::boolean,
          TRUE
        );

        v_exception_reason := lower(NULLIF(btrim(COALESCE(v_transition_payload->>'exception_reason', '')), ''));

        IF v_reason_required AND v_exception_reason IS NULL THEN
          RAISE EXCEPTION 'ui_execute_command_v1 exception transition requires payload.exception_reason' USING ERRCODE = '23514';
        END IF;

        IF v_exception_reason IS NOT NULL
           AND public.is_active_lookup_value_v1('dispatch_exception_reason', v_exception_reason, TRUE) IS FALSE THEN
          RAISE EXCEPTION 'ui_execute_command_v1 invalid exception_reason: %', v_exception_reason USING ERRCODE = '23514';
        END IF;

        IF v_exception_reason IS NOT NULL THEN
          v_transition_payload := jsonb_set(v_transition_payload, '{exception_reason}', to_jsonb(v_exception_reason), TRUE);
        END IF;
      END IF;

      v_idempotency_key := encode(
        digest(
          format('%s|%s|%s|%s', p_action_key, v_to_status, v_id, v_transition_payload::text),
          'sha256'
        ),
        'hex'
      );

      SELECT * INTO v_transition_row
      FROM public.transition_task_v1(
        p_task_id := v_id::uuid,
        p_to_status := v_to_status,
        p_status_reason := v_status_reason,
        p_payload := v_transition_payload,
        p_idempotency_key := v_idempotency_key
      )
      LIMIT 1;

      v_results := v_results || jsonb_build_array(
        jsonb_build_object(
          'task_id', v_transition_row.task_id,
          'task_event_id', v_transition_row.task_event_id
        )
      );
    END LOOP;

    RETURN jsonb_build_object(
      'status', 'task_transitioned',
      'action_key', p_action_key,
      'resource_key', p_resource_key,
      'to_status', v_to_status,
      'count', v_count,
      'items', v_results
    );
  END IF;

  IF v_handler LIKE 'marketplace_%' THEN
    v_marketplace_payload := COALESCE(v_params->'payload', '{}'::jsonb);
    v_marketplace_metadata := jsonb_strip_nulls(
      jsonb_build_object(
        'ui_action_key', p_action_key,
        'resource_key', p_resource_key,
        'source', 'ui_execute_command_v1'
      )
      || COALESCE(v_params->'metadata', '{}'::jsonb)
      || CASE
           WHEN NULLIF(btrim(COALESCE(v_marketplace_payload->>'response_note', '')), '') IS NULL THEN '{}'::jsonb
           ELSE jsonb_build_object('response_note', NULLIF(btrim(COALESCE(v_marketplace_payload->>'response_note', '')), ''))
         END
    );
  END IF;

  IF v_handler = 'marketplace_request_release' THEN
    v_marketplace_text := lower(NULLIF(btrim(COALESCE(v_marketplace_payload->>'release_state', '')), ''));
    IF v_marketplace_text IS NULL THEN
      RAISE EXCEPTION 'ui_execute_command_v1 marketplace_request_release requires payload.release_state' USING ERRCODE = '23514';
    END IF;

    FOREACH v_id IN ARRAY v_ids LOOP
      v_item := public.marketplace_request_release_v1(v_id::uuid, v_marketplace_text, v_marketplace_metadata);
      IF lower(COALESCE(v_item->>'ok', 'false')) <> 'true' THEN
        RAISE EXCEPTION 'ui_execute_command_v1 marketplace_request_release failed: %', COALESCE(v_item->'error'->>'code', 'unknown');
      END IF;
      v_results := v_results || jsonb_build_array(v_item);
    END LOOP;

    RETURN jsonb_build_object('status', 'marketplace_request_released', 'action_key', p_action_key, 'resource_key', p_resource_key, 'count', v_count, 'items', v_results);
  END IF;

  IF v_handler = 'marketplace_request_reopen' THEN
    FOREACH v_id IN ARRAY v_ids LOOP
      v_item := public.marketplace_request_reopen_v1(v_id::uuid, v_marketplace_metadata);
      IF lower(COALESCE(v_item->>'ok', 'false')) <> 'true' THEN
        RAISE EXCEPTION 'ui_execute_command_v1 marketplace_request_reopen failed: %', COALESCE(v_item->'error'->>'code', 'unknown');
      END IF;
      v_results := v_results || jsonb_build_array(v_item);
    END LOOP;

    RETURN jsonb_build_object('status', 'marketplace_request_reopened', 'action_key', p_action_key, 'resource_key', p_resource_key, 'count', v_count, 'items', v_results);
  END IF;

  IF v_handler = 'marketplace_request_expire' THEN
    v_marketplace_reason := NULLIF(btrim(COALESCE(v_marketplace_payload->>'reason', '')), '');

    FOREACH v_id IN ARRAY v_ids LOOP
      v_item := public.marketplace_request_expire_v1(v_id::uuid, v_marketplace_reason, v_marketplace_metadata);
      IF lower(COALESCE(v_item->>'ok', 'false')) <> 'true' THEN
        RAISE EXCEPTION 'ui_execute_command_v1 marketplace_request_expire failed: %', COALESCE(v_item->'error'->>'code', 'unknown');
      END IF;
      v_results := v_results || jsonb_build_array(v_item);
    END LOOP;

    RETURN jsonb_build_object('status', 'marketplace_request_expired', 'action_key', p_action_key, 'resource_key', p_resource_key, 'count', v_count, 'items', v_results);
  END IF;

  IF v_handler IN ('marketplace_offer_submit', 'marketplace_offer_counter') THEN
    v_marketplace_message := NULLIF(btrim(COALESCE(v_marketplace_payload->>'message', '')), '');

    BEGIN
      v_marketplace_terms := CASE
        WHEN NULLIF(btrim(COALESCE(v_marketplace_payload->>'terms_json', '')), '') IS NULL THEN '{}'::jsonb
        ELSE (v_marketplace_payload->>'terms_json')::jsonb
      END;
    EXCEPTION
      WHEN others THEN
        RAISE EXCEPTION 'ui_execute_command_v1 invalid terms_json' USING ERRCODE = '22023';
    END;

    BEGIN
      v_marketplace_pricing := CASE
        WHEN NULLIF(btrim(COALESCE(v_marketplace_payload->>'pricing_json', '')), '') IS NULL THEN '{}'::jsonb
        ELSE (v_marketplace_payload->>'pricing_json')::jsonb
      END;
    EXCEPTION
      WHEN others THEN
        RAISE EXCEPTION 'ui_execute_command_v1 invalid pricing_json' USING ERRCODE = '22023';
    END;

    FOREACH v_id IN ARRAY v_ids LOOP
      IF v_handler = 'marketplace_offer_submit' THEN
        v_item := public.marketplace_offer_submit_v1(
          p_request_id := v_id::uuid,
          p_message := v_marketplace_message,
          p_terms := v_marketplace_terms,
          p_pricing := v_marketplace_pricing,
          p_metadata := v_marketplace_metadata
        );
      ELSE
        v_item := public.marketplace_offer_counter_v1(
          p_offer_id := v_id::uuid,
          p_message := v_marketplace_message,
          p_terms := v_marketplace_terms,
          p_pricing := v_marketplace_pricing,
          p_metadata := v_marketplace_metadata
        );
      END IF;

      IF lower(COALESCE(v_item->>'ok', 'false')) <> 'true' THEN
        RAISE EXCEPTION 'ui_execute_command_v1 marketplace offer action failed: %', COALESCE(v_item->'error'->>'code', 'unknown');
      END IF;
      v_results := v_results || jsonb_build_array(v_item);
    END LOOP;

    RETURN jsonb_build_object(
      'status',
      CASE WHEN v_handler = 'marketplace_offer_submit' THEN 'marketplace_offer_submitted' ELSE 'marketplace_offer_countered' END,
      'action_key', p_action_key,
      'resource_key', p_resource_key,
      'count', v_count,
      'items', v_results
    );
  END IF;

  IF v_handler = 'marketplace_award_respond' THEN
    v_marketplace_decision := lower(COALESCE(NULLIF(v_static_params->>'decision', ''), NULLIF(v_params->>'decision', ''), ''));
    IF v_marketplace_decision IS NULL OR v_marketplace_decision = '' THEN
      RAISE EXCEPTION 'ui_execute_command_v1 marketplace_award_respond requires decision' USING ERRCODE = '23514';
    END IF;

    FOREACH v_id IN ARRAY v_ids LOOP
      v_item := public.marketplace_award_respond_v1(v_id::uuid, v_marketplace_decision, v_marketplace_metadata);
      IF lower(COALESCE(v_item->>'ok', 'false')) <> 'true' THEN
        RAISE EXCEPTION 'ui_execute_command_v1 marketplace_award_respond failed: %', COALESCE(v_item->'error'->>'code', 'unknown');
      END IF;
      v_results := v_results || jsonb_build_array(v_item);
    END LOOP;

    RETURN jsonb_build_object('status', 'marketplace_award_responded', 'action_key', p_action_key, 'resource_key', p_resource_key, 'decision', v_marketplace_decision, 'count', v_count, 'items', v_results);
  END IF;

  IF v_handler = 'marketplace_work_package_complete' THEN
    v_marketplace_reason := NULLIF(btrim(COALESCE(v_marketplace_payload->>'completion_notes', '')), '');
    v_marketplace_text := NULLIF(btrim(COALESCE(v_marketplace_payload->>'pod_reference', '')), '');

    BEGIN
      v_marketplace_terms := jsonb_strip_nulls(
        jsonb_build_object(
          'completion_notes', v_marketplace_reason,
          'pod_reference', v_marketplace_text,
          'proof_quality',
            CASE
              WHEN NULLIF(btrim(COALESCE(v_marketplace_payload->>'proof_quality', '')), '') IS NULL THEN NULL
              ELSE (v_marketplace_payload->>'proof_quality')::numeric
            END,
          'feedback_score',
            CASE
              WHEN NULLIF(btrim(COALESCE(v_marketplace_payload->>'feedback_score', '')), '') IS NULL THEN NULL
              ELSE (v_marketplace_payload->>'feedback_score')::numeric
            END
        )
      );
    EXCEPTION
      WHEN others THEN
        RAISE EXCEPTION 'ui_execute_command_v1 invalid marketplace completion proof payload' USING ERRCODE = '22023';
    END;

    FOREACH v_id IN ARRAY v_ids LOOP
      v_item := public.marketplace_work_package_complete_v1(v_id::uuid, v_marketplace_terms, v_marketplace_metadata);
      IF lower(COALESCE(v_item->>'ok', 'false')) <> 'true' THEN
        RAISE EXCEPTION 'ui_execute_command_v1 marketplace_work_package_complete failed: %', COALESCE(v_item->'error'->>'code', 'unknown');
      END IF;
      v_results := v_results || jsonb_build_array(v_item);
    END LOOP;

    RETURN jsonb_build_object('status', 'marketplace_work_package_completed', 'action_key', p_action_key, 'resource_key', p_resource_key, 'count', v_count, 'items', v_results);
  END IF;

  IF v_handler = 'marketplace_settlement_finalize' THEN
    FOREACH v_id IN ARRAY v_ids LOOP
      v_item := public.marketplace_settlement_finalize_v1(p_work_package_id := v_id::uuid, p_metadata := v_marketplace_metadata);
      IF lower(COALESCE(v_item->>'ok', 'false')) <> 'true' THEN
        RAISE EXCEPTION 'ui_execute_command_v1 marketplace_settlement_finalize failed: %', COALESCE(v_item->'error'->>'code', 'unknown');
      END IF;
      v_results := v_results || jsonb_build_array(v_item);
    END LOOP;

    RETURN jsonb_build_object('status', 'marketplace_settlement_finalized', 'action_key', p_action_key, 'resource_key', p_resource_key, 'count', v_count, 'items', v_results);
  END IF;

  IF v_handler = 'marketplace_settlement_reverse' THEN
    v_marketplace_reason := NULLIF(btrim(COALESCE(v_marketplace_payload->>'reason', '')), '');

    FOREACH v_id IN ARRAY v_ids LOOP
      v_item := public.marketplace_settlement_reverse_v1(v_id::uuid, v_marketplace_reason, v_marketplace_metadata);
      IF lower(COALESCE(v_item->>'ok', 'false')) <> 'true' THEN
        RAISE EXCEPTION 'ui_execute_command_v1 marketplace_settlement_reverse failed: %', COALESCE(v_item->'error'->>'code', 'unknown');
      END IF;
      v_results := v_results || jsonb_build_array(v_item);
    END LOOP;

    RETURN jsonb_build_object('status', 'marketplace_settlement_reversed', 'action_key', p_action_key, 'resource_key', p_resource_key, 'count', v_count, 'items', v_results);
  END IF;

  IF v_handler = 'marketplace_availability_upsert' THEN
    BEGIN
      v_marketplace_starts_at := NULLIF(btrim(COALESCE(v_marketplace_payload->>'starts_at', '')), '')::timestamptz;
      v_marketplace_ends_at := NULLIF(btrim(COALESCE(v_marketplace_payload->>'ends_at', '')), '')::timestamptz;
    EXCEPTION
      WHEN others THEN
        RAISE EXCEPTION 'ui_execute_command_v1 invalid marketplace availability timestamps' USING ERRCODE = '22023';
    END;

    v_marketplace_text := lower(NULLIF(btrim(COALESCE(v_marketplace_payload->>'availability_status', '')), ''));
    IF v_marketplace_text IS NULL THEN
      v_marketplace_text := 'available';
    END IF;

    BEGIN
      v_marketplace_capacity := CASE
        WHEN NULLIF(btrim(COALESCE(v_marketplace_payload->>'capacity_json', '')), '') IS NULL THEN '{}'::jsonb
        ELSE (v_marketplace_payload->>'capacity_json')::jsonb
      END;
    EXCEPTION
      WHEN others THEN
        RAISE EXCEPTION 'ui_execute_command_v1 invalid capacity_json' USING ERRCODE = '22023';
    END;

    v_item := public.marketplace_availability_upsert_v1(
      p_availability_id := CASE WHEN v_id IS NULL THEN NULL ELSE v_id::uuid END,
      p_starts_at := v_marketplace_starts_at,
      p_ends_at := v_marketplace_ends_at,
      p_availability_status := v_marketplace_text,
      p_capacity := v_marketplace_capacity,
      p_metadata := v_marketplace_metadata
    );

    IF lower(COALESCE(v_item->>'ok', 'false')) <> 'true' THEN
      RAISE EXCEPTION 'ui_execute_command_v1 marketplace_availability_upsert failed: %', COALESCE(v_item->'error'->>'code', 'unknown');
    END IF;

    RETURN jsonb_build_object('status', 'marketplace_availability_upserted', 'action_key', p_action_key, 'resource_key', p_resource_key, 'count', CASE WHEN v_id IS NULL THEN 0 ELSE 1 END, 'items', jsonb_build_array(v_item));
  END IF;

  RAISE EXCEPTION 'ui_execute_command_v1 missing handler for %', p_action_key;
END;
$function$;

REVOKE ALL ON FUNCTION public.ui_execute_command_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_execute_command_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202603081290_marketplace_ui_command_executor_v1'));
COMMIT;
