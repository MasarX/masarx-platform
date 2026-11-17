-- Migration: Zones + Baskets workflow integration
-- Purpose:
--   - Add workflow handlers for zone assignment + basket assignment.
--   - Register handlers and wire into workflow_geocoding_standard (before finalize_outcome).
--   - Introduce basket_policy (settings_versions) to keep basket behavior row-driven.
-- Alignment: SIMPLE | SCALABLE | DYNAMIC | SSOT | ZERO-HARDCODING | ladder-driven settings
-- Date: 2025-12-26

BEGIN;

SET search_path TO public, workflow_handlers, extensions, pg_temp;

-- ---------------------------------------------------------------------------
-- Handler: zone_assign (derives shipments.zone_id from canonical_district_id)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION workflow_handlers.execute_zone_assign_v1(
    p_step public.workflow_run_steps,
    p_run public.workflow_runs,
    p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
AS $function$
DECLARE
  v_ctx RECORD;
  v_context JSONB := COALESCE(p_run.context, '{}'::jsonb);
  v_success BOOLEAN := FALSE;
  v_canonical_district_text TEXT;
  v_canonical_district_id UUID;
  v_source_district_id BIGINT;
  v_zone_id UUID;
  v_updated INT := 0;
  v_now TIMESTAMPTZ := now();
  v_response public.workflow_handler_response;
BEGIN
  PERFORM set_config('search_path', 'public, workflow_handlers, extensions, pg_temp', false);

  SELECT * INTO v_ctx FROM public.geocoding_extract_context(p_run);

  IF v_ctx.organization_id IS NULL THEN
    v_response.status := 'completed';
    v_response.operation_result := jsonb_build_object('assigned', FALSE, 'reason', 'organization_missing');
    RETURN v_response;
  END IF;

  IF v_ctx.shipment_id IS NULL THEN
    v_response.status := 'completed';
    v_response.operation_result := jsonb_build_object('assigned', FALSE, 'reason', 'shipment_missing');
    RETURN v_response;
  END IF;

  BEGIN
    v_success := COALESCE((v_context->'geocoding'->>'successful')::BOOLEAN, FALSE);
  EXCEPTION
    WHEN others THEN
      v_success := FALSE;
  END;

  IF NOT v_success THEN
    v_response.status := 'completed';
    v_response.operation_result := jsonb_build_object('assigned', FALSE, 'reason', 'geocoding_not_successful');
    RETURN v_response;
  END IF;

  -- Prefer canonical UUID from workflow context; fallback to source_district_id mapping.
  v_canonical_district_text := NULLIF(v_context #>> '{geocoding,local_reverse_match,canonical_district_id}', '');
  IF v_canonical_district_text IS NULL THEN
    v_canonical_district_text := NULLIF(v_context #>> '{geocoding,selected_geocode,metadata,canonical_district_id}', '');
  END IF;
  IF v_canonical_district_text IS NULL THEN
    v_canonical_district_text := NULLIF(v_context #>> '{geocoding,selected_geocode,metadata,district_id}', '');
  END IF;
  IF v_canonical_district_text IS NULL THEN
    v_canonical_district_text := NULLIF(v_context #>> '{geocoding,local_reverse_match,district_id}', '');
  END IF;

  BEGIN
    v_canonical_district_id := NULLIF(v_canonical_district_text, '')::UUID;
  EXCEPTION
    WHEN others THEN
      v_canonical_district_id := NULL;
  END;

  IF v_canonical_district_id IS NULL THEN
    v_source_district_id := NULL;

    BEGIN
      v_source_district_id := NULLIF(v_context #>> '{geocoding,selected_geocode,metadata,source_district_id}', '')::BIGINT;
    EXCEPTION
      WHEN others THEN
        v_source_district_id := NULL;
    END;

    IF v_source_district_id IS NULL THEN
      BEGIN
        v_source_district_id := NULLIF(v_context #>> '{geocoding,local_reverse_match,district_id}', '')::BIGINT;
      EXCEPTION
        WHEN others THEN
          v_source_district_id := NULL;
      END;
    END IF;

    IF v_source_district_id IS NULL THEN
      BEGIN
        v_source_district_id := NULLIF(v_context #>> '{geocoding,selected_geocode,metadata,district_id}', '')::BIGINT;
      EXCEPTION
        WHEN others THEN
          v_source_district_id := NULL;
      END;
    END IF;

    IF v_source_district_id IS NOT NULL THEN
      SELECT cd.id
      INTO v_canonical_district_id
      FROM public.canonical_districts cd
      WHERE cd.organization_id = v_ctx.organization_id
        AND cd.source_district_id = v_source_district_id
        AND cd.is_active = TRUE
      ORDER BY cd.updated_at DESC NULLS LAST, cd.id
      LIMIT 1;
    END IF;
  END IF;

  IF v_canonical_district_id IS NULL THEN
    v_response.status := 'completed';
    v_response.operation_result := jsonb_build_object('assigned', FALSE, 'reason', 'canonical_district_missing');
    RETURN v_response;
  END IF;

  v_zone_id := public.resolve_zone_id_for_canonical_district(v_ctx.organization_id, v_canonical_district_id);

  IF v_zone_id IS NULL THEN
    v_response.status := 'completed';
    v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
      'assigned', FALSE,
      'reason', 'zone_unmapped',
      'canonical_district_id', v_canonical_district_id
    ));
    v_response.context_patch := jsonb_strip_nulls(jsonb_build_object(
      'routing', jsonb_build_object(
        'canonical_district_id', v_canonical_district_id,
        'zone_id', NULL
      )
    ));
    RETURN v_response;
  END IF;

  UPDATE public.shipments s
  SET zone_id = v_zone_id,
      updated_at = v_now,
      version = s.version + 1
  WHERE s.id = v_ctx.shipment_id
    AND (v_ctx.client_id IS NULL OR s.client_id = v_ctx.client_id)
    AND s.zone_id IS DISTINCT FROM v_zone_id;

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated > 0 THEN
    INSERT INTO public.shipment_actions (
      id,
      shipment_id,
      organization_id,
      client_id,
      action_type,
      action_category,
      action_data,
      timestamp,
      created_at,
      performed_by_system
    )
    VALUES (
      gen_random_uuid(),
      v_ctx.shipment_id,
      v_ctx.organization_id,
      v_ctx.client_id,
      'zone_assigned',
      'operational',
      jsonb_strip_nulls(jsonb_build_object(
        'zone_id', v_zone_id,
        'canonical_district_id', v_canonical_district_id,
        'workflow_run_id', p_step.workflow_run_id
      )),
      v_now,
      v_now,
      'workflow_engine'
    );
  END IF;

  v_response.status := 'completed';
  v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
    'assigned', TRUE,
    'zone_id', v_zone_id,
    'canonical_district_id', v_canonical_district_id,
    'shipment_updated', (v_updated > 0)
  ));
  v_response.context_patch := jsonb_strip_nulls(jsonb_build_object(
    'shipment', jsonb_build_object('zone_id', v_zone_id),
    'routing', jsonb_build_object(
      'canonical_district_id', v_canonical_district_id,
      'zone_id', v_zone_id
    )
  ));

  RETURN v_response;
END;
$function$;

ALTER FUNCTION workflow_handlers.execute_zone_assign_v1(public.workflow_run_steps, public.workflow_runs, JSONB)
  SET search_path TO workflow_handlers, public, extensions, pg_temp;

COMMENT ON FUNCTION workflow_handlers.execute_zone_assign_v1(public.workflow_run_steps, public.workflow_runs, JSONB)
  IS 'Resolve shipments.zone_id from canonical_district_id in workflow context (requires geocoding.successful=true).';

INSERT INTO public.operation_handlers AS oh (
  handler_key,
  handler_schema,
  handler_name,
  handler_signature,
  handler_version,
  is_active,
  notes,
  doc_url
)
VALUES (
  'zone_assign',
  'workflow_handlers',
  'execute_zone_assign_v1',
  '(public.workflow_run_steps,public.workflow_runs,jsonb)',
  'v1',
  TRUE,
  'Assign shipment zone_id from canonical district mapping (zones/zone_districts).',
  'docs/ops/plans/PLAN-202512-zones-baskets.md'
)
ON CONFLICT (handler_key) DO UPDATE
SET handler_schema = EXCLUDED.handler_schema,
    handler_name = EXCLUDED.handler_name,
    handler_signature = EXCLUDED.handler_signature,
    handler_version = EXCLUDED.handler_version,
    is_active = EXCLUDED.is_active,
    notes = EXCLUDED.notes,
    doc_url = EXCLUDED.doc_url,
    updated_at = now();

-- ---------------------------------------------------------------------------
-- basket_policy (settings_versions) + handler: basket_assign (zone-based default)
-- ---------------------------------------------------------------------------

INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES (
  'basket_policy',
  1,
  '{
    "$schema": "http://json-schema.org/draft-07/schema#",
    "title": "Basket Policy",
    "type": "object",
    "additionalProperties": true,
    "properties": {
      "version": { "type": "integer", "minimum": 1 },
      "enabled": { "type": ["boolean", "null"] },
      "basket_type": { "type": ["string", "null"] },
      "open_states": { "type": ["array", "null"], "items": { "type": "string" } },
      "create_if_missing": { "type": ["boolean", "null"] },
      "require_zone": { "type": ["boolean", "null"] },
      "expires_in_minutes": { "type": ["integer", "null"], "minimum": 1, "maximum": 10080 },
      "capacity_count": { "type": ["integer", "null"], "minimum": 1 }
    }
  }'::jsonb,
  'Policy-driven rules for grouping shipments into baskets (zone-based default; resolved via settings ladder).',
  '[
    {
      "version": 1,
      "enabled": false,
      "basket_type": "zone_based",
      "open_states": ["forming"],
      "create_if_missing": true,
      "require_zone": true,
      "expires_in_minutes": 240,
      "capacity_count": 50
    }
  ]'::jsonb,
  TRUE
)
ON CONFLICT (category, version)
DO UPDATE SET schema = EXCLUDED.schema,
              description = EXCLUDED.description,
              examples = EXCLUDED.examples,
              is_active = TRUE;

WITH upsert AS (
  SELECT jsonb_build_object(
    'version', 1,
    'enabled', false,
    'basket_type', null,
    'open_states', null,
    'create_if_missing', true,
    'require_zone', true,
    'expires_in_minutes', null,
    'capacity_count', null
  ) AS body
)
INSERT INTO public.settings_versions (category, scope_type, scope_id, version, value, schema_version, approved_at)
SELECT 'basket_policy', 'global', NULL, 1, body, 1, now()
FROM upsert
ON CONFLICT DO NOTHING;

INSERT INTO public.settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
SELECT sv.category, sv.scope_type, sv.scope_id, sv.id, sv.value, now()
FROM public.settings_versions sv
WHERE sv.category = 'basket_policy'
  AND sv.scope_type = 'global'
  AND sv.scope_id IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM public.settings s
    WHERE s.category = sv.category
      AND s.scope_type = sv.scope_type
      AND s.scope_id IS NULL
  );

CREATE OR REPLACE FUNCTION workflow_handlers.execute_basket_assign_v1(
    p_step public.workflow_run_steps,
    p_run public.workflow_runs,
    p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
AS $function$
DECLARE
  v_ctx RECORD;
  v_context JSONB := COALESCE(p_run.context, '{}'::jsonb);
  v_policy_ctx JSONB := '{}'::jsonb;
  v_webhook_id UUID;
  v_webhook_source_id UUID;
  v_policy_row RECORD;
  v_has_policy_row BOOLEAN := FALSE;
  v_policy JSONB := '{}'::jsonb;
  v_enabled BOOLEAN := FALSE;
  v_require_zone BOOLEAN := TRUE;
  v_create_if_missing BOOLEAN := TRUE;
  v_basket_type TEXT;
  v_default_basket_type TEXT;
  v_default_state TEXT;
  v_open_states TEXT[];
  v_zone_id UUID;
  v_existing_basket_id UUID;
  v_basket_id UUID;
  v_capacity_override INT;
  v_expires_minutes INT;
  v_expires_at TIMESTAMPTZ;
  v_assigned BOOLEAN := FALSE;
  v_reason TEXT := NULL;
  v_settings_resolution_id UUID := NULL;
  v_now TIMESTAMPTZ := now();
  v_response public.workflow_handler_response;
  v_step_decision JSONB;
BEGIN
  PERFORM set_config('search_path', 'public, workflow_handlers, extensions, pg_temp', false);

  SELECT * INTO v_ctx FROM public.geocoding_extract_context(p_run);

  IF v_ctx.organization_id IS NULL THEN
    v_response.status := 'completed';
    v_response.operation_result := jsonb_build_object('assigned', FALSE, 'reason', 'organization_missing');
    RETURN v_response;
  END IF;

  IF v_ctx.shipment_id IS NULL OR v_ctx.client_id IS NULL THEN
    v_response.status := 'completed';
    v_response.operation_result := jsonb_build_object('assigned', FALSE, 'reason', 'shipment_missing');
    RETURN v_response;
  END IF;

  -- Best-effort: include webhook_source_id (top of ladder) when available.
  v_webhook_id := NULL;
  BEGIN
    v_webhook_id := NULLIF(v_context->>'webhook_id', '')::UUID;
  EXCEPTION
    WHEN others THEN
      v_webhook_id := NULL;
  END;

  IF v_webhook_id IS NOT NULL THEN
    SELECT wi.webhook_source_id
    INTO v_webhook_source_id
    FROM public.webhook_inbox wi
    WHERE wi.id = v_webhook_id;
  END IF;

  v_policy_ctx := jsonb_strip_nulls(jsonb_build_object(
    'organization_id', v_ctx.organization_id,
    'client_id', v_ctx.client_id,
    'sender_id', v_ctx.sender_id,
    'webhook_source_id', v_webhook_source_id
  ));

  SELECT *
  INTO v_policy_row
  FROM public.resolve_settings_row_from_context('basket_policy', v_policy_ctx)
  LIMIT 1;

  v_has_policy_row := FOUND;

  IF v_has_policy_row AND v_policy_row.value IS NOT NULL THEN
    v_policy := v_policy_row.value;
  END IF;

  BEGIN
    v_enabled := COALESCE((v_policy->>'enabled')::BOOLEAN, FALSE);
  EXCEPTION
    WHEN others THEN
      v_enabled := FALSE;
  END;

  BEGIN
    v_require_zone := COALESCE((v_policy->>'require_zone')::BOOLEAN, TRUE);
  EXCEPTION
    WHEN others THEN
      v_require_zone := TRUE;
  END;

  BEGIN
    v_create_if_missing := COALESCE((v_policy->>'create_if_missing')::BOOLEAN, TRUE);
  EXCEPTION
    WHEN others THEN
      v_create_if_missing := TRUE;
  END;

  BEGIN
    v_expires_minutes := NULLIF(v_policy->>'expires_in_minutes', '')::INT;
  EXCEPTION
    WHEN others THEN
      v_expires_minutes := NULL;
  END;

  BEGIN
    v_capacity_override := NULLIF(v_policy->>'capacity_count', '')::INT;
  EXCEPTION
    WHEN others THEN
      v_capacity_override := NULL;
  END;

  v_basket_type := NULLIF(v_policy->>'basket_type', '');

  -- Default basket_type from lookup when policy doesn't specify.
  IF v_basket_type IS NULL THEN
    SELECT lv.value
    INTO v_default_basket_type
    FROM public.lookup_definitions ld
    JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
    WHERE ld.category = 'basket_type'
      AND lv.status = 'active'
      AND lv.is_default = TRUE
      AND (lv.effective_from IS NULL OR lv.effective_from <= now())
      AND (lv.effective_until IS NULL OR lv.effective_until > now())
    ORDER BY lv.sort_order NULLS LAST, lv.value
    LIMIT 1;

    IF v_default_basket_type IS NOT NULL THEN
      v_basket_type := v_default_basket_type;
    END IF;
  END IF;

  -- Open states (policy array) else default state from lookup.
  IF v_policy ? 'open_states' AND jsonb_typeof(v_policy->'open_states') = 'array' THEN
    SELECT array_agg(btrim(value))
    INTO v_open_states
    FROM jsonb_array_elements_text(v_policy->'open_states') AS value
    WHERE btrim(value) <> '';
  END IF;

  IF v_open_states IS NULL OR array_length(v_open_states, 1) IS NULL THEN
    SELECT lv.value
    INTO v_default_state
    FROM public.lookup_definitions ld
    JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
    WHERE ld.category = 'basket_state'
      AND lv.status = 'active'
      AND lv.is_default = TRUE
      AND (lv.effective_from IS NULL OR lv.effective_from <= now())
      AND (lv.effective_until IS NULL OR lv.effective_until > now())
    ORDER BY lv.sort_order NULLS LAST, lv.value
    LIMIT 1;

    IF v_default_state IS NULL THEN
      SELECT lv.value
      INTO v_default_state
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
      WHERE ld.category = 'basket_state'
        AND lv.status = 'active'
        AND (lv.effective_from IS NULL OR lv.effective_from <= now())
        AND (lv.effective_until IS NULL OR lv.effective_until > now())
      ORDER BY lv.sort_order NULLS LAST, lv.value
      LIMIT 1;
    END IF;

    IF v_default_state IS NOT NULL THEN
      v_open_states := ARRAY[v_default_state];
    END IF;
  END IF;

  -- Determine zone_id: prefer context patch, fallback to shipment row.
  BEGIN
    v_zone_id := NULLIF(v_context #>> '{routing,zone_id}', '')::UUID;
  EXCEPTION
    WHEN others THEN
      v_zone_id := NULL;
  END;

  IF v_zone_id IS NULL THEN
    BEGIN
      v_zone_id := NULLIF(v_context #>> '{shipment,zone_id}', '')::UUID;
    EXCEPTION
      WHEN others THEN
        v_zone_id := NULL;
    END;
  END IF;

  IF v_zone_id IS NULL THEN
    SELECT s.zone_id
    INTO v_zone_id
    FROM public.shipments s
    WHERE s.id = v_ctx.shipment_id
      AND s.client_id = v_ctx.client_id
    LIMIT 1;
  END IF;

  IF NOT v_enabled THEN
    v_reason := 'policy_disabled';
    v_response.status := 'completed';
    v_response.operation_result := jsonb_strip_nulls(jsonb_build_object('assigned', FALSE, 'reason', v_reason));
    RETURN v_response;
  END IF;

  -- Record settings provenance when available.
  IF v_has_policy_row AND v_policy_row.settings_id IS NOT NULL THEN
    v_settings_resolution_id := public.log_settings_resolution(
      p_organization_id := v_ctx.organization_id,
      p_category := 'basket_policy',
      p_winning_scope_type := COALESCE(v_policy_row.scope_type, 'global'),
      p_winning_scope_id := v_policy_row.scope_id,
      p_winning_settings_id := v_policy_row.settings_id,
      p_winning_settings_version_id := v_policy_row.settings_version_id,
      p_winning_version := COALESCE(v_policy_row.version, 1),
      p_scope_path := COALESCE(v_policy_row.scope_path, '[]'::jsonb),
      p_inputs := jsonb_strip_nulls(jsonb_build_object(
        'workflow_run_id', p_step.workflow_run_id,
        'workflow_step_id', p_step.id,
        'shipment_id', v_ctx.shipment_id,
        'shipment_client_id', v_ctx.client_id,
        'zone_id', v_zone_id,
        'policy_context', v_policy_ctx
      )),
      p_merge_notes := NULL
    );
  END IF;

  IF v_require_zone AND v_zone_id IS NULL THEN
    v_reason := 'zone_missing';
    PERFORM public.log_decision(
      p_organization_id := v_ctx.organization_id,
      p_decision_category := 'settings_resolution',
      p_resource_type := 'shipment',
      p_resource_id := v_ctx.shipment_id,
      p_decision_point := 'basket_assign',
      p_decision_outcome := 'skipped',
      p_performed_by_system := 'workflow_engine',
      p_correlation_id := NULL,
      p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
        'reason', v_reason,
        'policy', v_policy,
        'settings_resolution_id', v_settings_resolution_id
      )),
      p_decision_reason := v_reason,
      p_settings_resolution_id := v_settings_resolution_id
    );

    v_response.status := 'completed';
    v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
      'assigned', FALSE,
      'reason', v_reason,
      'settings_resolution_id', v_settings_resolution_id
    ));
    RETURN v_response;
  END IF;

  -- Idempotency: already assigned (active membership).
  SELECT bi.basket_id
  INTO v_existing_basket_id
  FROM public.basket_items bi
  JOIN public.baskets b ON b.id = bi.basket_id
  WHERE bi.shipment_id = v_ctx.shipment_id
    AND bi.shipment_client_id = v_ctx.client_id
    AND bi.removed_at IS NULL
    AND b.organization_id = v_ctx.organization_id
  ORDER BY bi.added_at DESC
  LIMIT 1;

  IF v_existing_basket_id IS NOT NULL THEN
    v_reason := 'already_assigned';
    v_response.status := 'completed';
    v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
      'assigned', TRUE,
      'basket_id', v_existing_basket_id,
      'reason', v_reason,
      'settings_resolution_id', v_settings_resolution_id
    ));
    v_response.context_patch := jsonb_strip_nulls(jsonb_build_object(
      'basket', jsonb_build_object('basket_id', v_existing_basket_id)
    ));
    RETURN v_response;
  END IF;

  v_expires_at := CASE
    WHEN v_expires_minutes IS NOT NULL AND v_expires_minutes > 0 THEN v_now + make_interval(mins => v_expires_minutes)
    ELSE NULL
  END;

  -- Prefer an open basket in the same zone (capacity-aware), otherwise create one.
  SELECT b.id
  INTO v_basket_id
  FROM public.baskets b
  WHERE b.organization_id = v_ctx.organization_id
    AND (v_zone_id IS NULL OR b.zone_id = v_zone_id)
    AND (v_basket_type IS NULL OR b.basket_type = v_basket_type)
    AND (v_open_states IS NULL OR b.state = ANY(v_open_states))
    AND (b.expires_at IS NULL OR b.expires_at > v_now)
    AND (b.capacity_count IS NULL OR b.current_count < b.capacity_count)
  ORDER BY b.updated_at DESC NULLS LAST, b.created_at DESC, b.id
  LIMIT 1;

  IF v_basket_id IS NULL AND v_create_if_missing THEN
    INSERT INTO public.baskets (organization_id, zone_id, basket_type, capacity_count, expires_at)
    VALUES (v_ctx.organization_id, v_zone_id, v_basket_type, v_capacity_override, v_expires_at)
    RETURNING id INTO v_basket_id;
  END IF;

  IF v_basket_id IS NULL THEN
    v_reason := 'no_basket_available';
    v_response.status := 'completed';
    v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
      'assigned', FALSE,
      'reason', v_reason,
      'zone_id', v_zone_id,
      'settings_resolution_id', v_settings_resolution_id
    ));
    RETURN v_response;
  END IF;

  BEGIN
    INSERT INTO public.basket_items (basket_id, shipment_id, shipment_client_id)
    VALUES (v_basket_id, v_ctx.shipment_id, v_ctx.client_id);

    v_assigned := TRUE;
    v_reason := 'assigned';
  EXCEPTION
    WHEN unique_violation THEN
      -- Concurrent insert: resolve to existing assignment.
      SELECT bi.basket_id
      INTO v_existing_basket_id
      FROM public.basket_items bi
      WHERE bi.shipment_id = v_ctx.shipment_id
        AND bi.shipment_client_id = v_ctx.client_id
        AND bi.removed_at IS NULL
      ORDER BY bi.added_at DESC
      LIMIT 1;

      v_basket_id := COALESCE(v_existing_basket_id, v_basket_id);
      v_assigned := v_existing_basket_id IS NOT NULL;
      v_reason := CASE WHEN v_assigned THEN 'already_assigned' ELSE 'unique_violation' END;
    WHEN raise_exception THEN
      v_assigned := FALSE;
      v_reason := SQLERRM;
    WHEN others THEN
      v_assigned := FALSE;
      v_reason := SQLERRM;
  END;

  IF v_assigned THEN
    INSERT INTO public.shipment_actions (
      id,
      shipment_id,
      organization_id,
      client_id,
      action_type,
      action_category,
      action_data,
      timestamp,
      created_at,
      performed_by_system
    )
    VALUES (
      gen_random_uuid(),
      v_ctx.shipment_id,
      v_ctx.organization_id,
      v_ctx.client_id,
      'basket_assigned',
      'operational',
      jsonb_strip_nulls(jsonb_build_object(
        'basket_id', v_basket_id,
        'zone_id', v_zone_id,
        'workflow_run_id', p_step.workflow_run_id
      )),
      v_now,
      v_now,
      'workflow_engine'
    );
  END IF;

  v_step_decision := jsonb_strip_nulls(jsonb_build_object(
    'assigned', v_assigned,
    'basket_id', CASE WHEN v_assigned THEN v_basket_id ELSE NULL END,
    'zone_id', v_zone_id,
    'basket_type', v_basket_type,
    'open_states', v_open_states,
    'reason', v_reason
  ));

  PERFORM public.log_decision(
    p_organization_id := v_ctx.organization_id,
    p_decision_category := 'settings_resolution',
    p_resource_type := 'shipment',
    p_resource_id := v_ctx.shipment_id,
    p_decision_point := 'basket_assign',
    p_decision_outcome := CASE WHEN v_assigned THEN 'assigned' ELSE 'skipped' END,
    p_performed_by_system := 'workflow_engine',
    p_correlation_id := NULL,
    p_decision_inputs := v_step_decision,
    p_decision_reason := v_reason,
    p_settings_resolution_id := v_settings_resolution_id
  );

  v_response.status := 'completed';
  v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
    'assigned', v_assigned,
    'basket_id', CASE WHEN v_assigned THEN v_basket_id ELSE NULL END,
    'zone_id', v_zone_id,
    'reason', v_reason,
    'settings_resolution_id', v_settings_resolution_id
  ));
  v_response.context_patch := CASE
    WHEN v_assigned THEN jsonb_strip_nulls(jsonb_build_object('basket', jsonb_build_object('basket_id', v_basket_id)))
    ELSE NULL
  END;

  RETURN v_response;
END;
$function$;

ALTER FUNCTION workflow_handlers.execute_basket_assign_v1(public.workflow_run_steps, public.workflow_runs, JSONB)
  SET search_path TO workflow_handlers, public, extensions, pg_temp;

COMMENT ON FUNCTION workflow_handlers.execute_basket_assign_v1(public.workflow_run_steps, public.workflow_runs, JSONB)
  IS 'Assign shipment to a basket using basket_policy (settings ladder) and optional zone_id grouping.';

INSERT INTO public.operation_handlers AS oh (
  handler_key,
  handler_schema,
  handler_name,
  handler_signature,
  handler_version,
  is_active,
  notes,
  doc_url
)
VALUES (
  'basket_assign',
  'workflow_handlers',
  'execute_basket_assign_v1',
  '(public.workflow_run_steps,public.workflow_runs,jsonb)',
  'v1',
  TRUE,
  'Assign shipment to basket using basket_policy (settings ladder).',
  'docs/ops/plans/PLAN-202512-zones-baskets.md'
)
ON CONFLICT (handler_key) DO UPDATE
SET handler_schema = EXCLUDED.handler_schema,
    handler_name = EXCLUDED.handler_name,
    handler_signature = EXCLUDED.handler_signature,
    handler_version = EXCLUDED.handler_version,
    is_active = EXCLUDED.is_active,
    notes = EXCLUDED.notes,
    doc_url = EXCLUDED.doc_url,
    updated_at = now();

-- ---------------------------------------------------------------------------
-- Wire steps into workflow_geocoding_standard (before finalize_outcome)
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  v_template_id UUID;
  v_insert_at INT;
  v_shift INT := 0;
  v_has_zone BOOLEAN := FALSE;
  v_has_basket BOOLEAN := FALSE;
  v_zone_step_id UUID := '99990000-0000-0000-0000-000000410020'::uuid;
  v_basket_step_id UUID := '99990000-0000-0000-0000-000000410021'::uuid;
BEGIN
  SELECT id INTO v_template_id
  FROM public.workflow_templates
  WHERE name = 'workflow_geocoding_standard'
  LIMIT 1;

  IF v_template_id IS NULL THEN
    RAISE NOTICE 'workflow_geocoding_standard not found; skipping zone/basket step insertion';
    RETURN;
  END IF;

  SELECT TRUE INTO v_has_zone
  FROM public.workflow_template_steps
  WHERE workflow_template_id = v_template_id
    AND operation_name = 'zone_assign'
  LIMIT 1;

  SELECT TRUE INTO v_has_basket
  FROM public.workflow_template_steps
  WHERE workflow_template_id = v_template_id
    AND operation_name = 'basket_assign'
  LIMIT 1;

  -- Idempotent repair: ensure handler metadata is correct when steps already exist.
  IF v_has_zone THEN
    UPDATE public.workflow_template_steps
    SET handler_key = 'zone_assign',
        handler_version = 'v1',
        operation_settings_category = COALESCE(operation_settings_category, 'routing'),
        transition_condition = 'always',
        enabled = TRUE,
        updated_at = now()
    WHERE workflow_template_id = v_template_id
      AND operation_name = 'zone_assign';
  END IF;

  IF v_has_basket THEN
    UPDATE public.workflow_template_steps
    SET handler_key = 'basket_assign',
        handler_version = 'v1',
        operation_settings_category = COALESCE(operation_settings_category, 'routing'),
        transition_condition = 'always',
        enabled = TRUE,
        updated_at = now()
    WHERE workflow_template_id = v_template_id
      AND operation_name = 'basket_assign';
  END IF;

  IF v_has_zone AND v_has_basket THEN
    PERFORM public.workflow_refresh_steps_checksum(v_template_id);
    RETURN;
  END IF;

  SELECT sequence_order
  INTO v_insert_at
  FROM public.workflow_template_steps
  WHERE workflow_template_id = v_template_id
    AND operation_name = 'finalize_outcome'
  ORDER BY sequence_order
  LIMIT 1;

  IF v_insert_at IS NULL THEN
    SELECT COALESCE(MAX(sequence_order), 0) + 1
    INTO v_insert_at
    FROM public.workflow_template_steps
    WHERE workflow_template_id = v_template_id;
  END IF;

  IF NOT v_has_zone THEN
    v_shift := v_shift + 1;
  END IF;
  IF NOT v_has_basket THEN
    v_shift := v_shift + 1;
  END IF;

  IF v_shift > 0 THEN
    UPDATE public.workflow_template_steps
    SET sequence_order = sequence_order + v_shift
    WHERE workflow_template_id = v_template_id
      AND sequence_order >= v_insert_at;
  END IF;

  IF NOT v_has_zone THEN
    INSERT INTO public.workflow_template_steps (
      id,
      workflow_template_id,
      sequence_order,
      operation_name,
      operation_settings_category,
      transition_condition,
      handler_key,
      handler_version,
      metadata,
      manual_action_required,
      enabled
    )
    VALUES (
      v_zone_step_id,
      v_template_id,
      v_insert_at,
      'zone_assign',
      'routing',
      'always',
      'zone_assign',
      'v1',
      jsonb_build_object('decision_log_event', 'routing.zone_assign'),
      FALSE,
      TRUE
    )
    ON CONFLICT (id) DO UPDATE
    SET workflow_template_id = EXCLUDED.workflow_template_id,
        sequence_order = EXCLUDED.sequence_order,
        operation_name = EXCLUDED.operation_name,
        operation_settings_category = EXCLUDED.operation_settings_category,
        transition_condition = EXCLUDED.transition_condition,
        handler_key = EXCLUDED.handler_key,
        handler_version = EXCLUDED.handler_version,
        metadata = EXCLUDED.metadata,
        manual_action_required = EXCLUDED.manual_action_required,
        enabled = EXCLUDED.enabled,
        updated_at = now();

    v_insert_at := v_insert_at + 1;
  END IF;

  IF NOT v_has_basket THEN
    INSERT INTO public.workflow_template_steps (
      id,
      workflow_template_id,
      sequence_order,
      operation_name,
      operation_settings_category,
      transition_condition,
      handler_key,
      handler_version,
      metadata,
      manual_action_required,
      enabled
    )
    VALUES (
      v_basket_step_id,
      v_template_id,
      v_insert_at,
      'basket_assign',
      'routing',
      'always',
      'basket_assign',
      'v1',
      jsonb_build_object('decision_log_event', 'routing.basket_assign'),
      FALSE,
      TRUE
    )
    ON CONFLICT (id) DO UPDATE
    SET workflow_template_id = EXCLUDED.workflow_template_id,
        sequence_order = EXCLUDED.sequence_order,
        operation_name = EXCLUDED.operation_name,
        operation_settings_category = EXCLUDED.operation_settings_category,
        transition_condition = EXCLUDED.transition_condition,
        handler_key = EXCLUDED.handler_key,
        handler_version = EXCLUDED.handler_version,
        metadata = EXCLUDED.metadata,
        manual_action_required = EXCLUDED.manual_action_required,
        enabled = EXCLUDED.enabled,
        updated_at = now();
  END IF;

  PERFORM public.workflow_refresh_steps_checksum(v_template_id);
END
$$;

COMMIT;
