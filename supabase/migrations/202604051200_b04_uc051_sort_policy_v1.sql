-- Plan: B04 UC051 sort policy closeout / Step: E01
-- Migration: add branch/route/service/priority-aware basket sorting
-- Date: 2026-04-05
--
-- Goals:
--   - Extend baskets with canonical sort discriminator columns.
--   - Keep basket selection row-driven through basket_policy settings.
--   - Resolve branch from existing zone coverage, service from shipment columns,
--     route from policy-configured workflow context paths, and priority from
--     policy-defined score bands.

BEGIN;

SELECT pg_advisory_lock(hashtext('202604051200_b04_uc051_sort_policy_v1'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;

ALTER TABLE public.baskets
  ADD COLUMN IF NOT EXISTS sort_branch_id UUID REFERENCES public.branches(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS sort_service_key TEXT,
  ADD COLUMN IF NOT EXISTS sort_route_key TEXT,
  ADD COLUMN IF NOT EXISTS sort_priority_key TEXT;

COMMENT ON COLUMN public.baskets.sort_branch_id
  IS 'Resolved target branch for this basket when basket_policy groups by branch.';
COMMENT ON COLUMN public.baskets.sort_service_key
  IS 'Resolved service bucket key (for example service_level or service_type) when basket_policy groups by service.';
COMMENT ON COLUMN public.baskets.sort_route_key
  IS 'Resolved route discriminator from workflow context when basket_policy groups by route.';
COMMENT ON COLUMN public.baskets.sort_priority_key
  IS 'Resolved priority bucket key when basket_policy groups by priority.';

CREATE INDEX IF NOT EXISTS idx_baskets_org_zone_sort_dims_state
  ON public.baskets (
    organization_id,
    zone_id,
    sort_branch_id,
    sort_service_key,
    sort_route_key,
    sort_priority_key,
    state
  );

-- Keep FK hygiene explicit: the basket lookup index is optimized for policy
-- reads, while the FK contract still requires a leading sort_branch_id index.
CREATE INDEX IF NOT EXISTS idx_baskets_sort_branch_id
  ON public.baskets (sort_branch_id);

CREATE OR REPLACE FUNCTION public.baskets_enforce_sort_branch_org_match_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_branch_org UUID;
BEGIN
  IF NEW.sort_branch_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT b.organization_id
    INTO v_branch_org
    FROM public.branches b
   WHERE b.id = NEW.sort_branch_id;

  IF v_branch_org IS NULL THEN
    RAISE EXCEPTION 'baskets: branch % not found', NEW.sort_branch_id
      USING ERRCODE = '23503';
  END IF;

  IF v_branch_org IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'baskets: organization mismatch (basket org %, branch org %)', NEW.organization_id, v_branch_org
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.baskets_enforce_sort_branch_org_match_v1()
  IS 'Ensure sort_branch_id stays organization-aligned with the basket organization.';

DROP TRIGGER IF EXISTS trg_baskets_enforce_sort_branch_org_match ON public.baskets;
CREATE TRIGGER trg_baskets_enforce_sort_branch_org_match
  BEFORE INSERT OR UPDATE ON public.baskets
  FOR EACH ROW
  EXECUTE FUNCTION public.baskets_enforce_sort_branch_org_match_v1();

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
      "capacity_count": { "type": ["integer", "null"], "minimum": 1 },
      "group_by_branch": { "type": ["boolean", "null"] },
      "group_by_service": { "type": ["boolean", "null"] },
      "service_match_field": {
        "type": ["string", "null"],
        "enum": ["service_level", "service_type", "service_level_or_type", null]
      },
      "group_by_route": { "type": ["boolean", "null"] },
      "route_key_paths": { "type": ["string", "null"] },
      "group_by_priority": { "type": ["boolean", "null"] },
      "priority_bands": {
        "type": ["array", "null"],
        "items": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "key": { "type": "string" },
            "min_score": { "type": ["number", "null"] },
            "max_score": { "type": ["number", "null"] }
          },
          "required": ["key"]
        }
      }
    }
  }'::jsonb,
  'Policy-driven rules for grouping shipments into baskets (zone/branch/service/route/priority-aware; resolved via settings ladder).',
  '[
    {
      "version": 1,
      "enabled": true,
      "basket_type": "zone_based",
      "open_states": ["forming"],
      "create_if_missing": true,
      "require_zone": true,
      "group_by_branch": true,
      "group_by_service": true,
      "service_match_field": "service_level",
      "group_by_route": true,
      "route_key_paths": "routing.route_key|dispatch.route_key",
      "group_by_priority": true,
      "priority_bands": [
        { "key": "urgent", "min_score": 80 },
        { "key": "standard", "max_score": 79.999 }
      ]
    }
  ]'::jsonb,
  TRUE
)
ON CONFLICT (category, version)
DO UPDATE SET schema = EXCLUDED.schema,
              description = EXCLUDED.description,
              examples = EXCLUDED.examples,
              is_active = TRUE;

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
  v_group_by_branch BOOLEAN := FALSE;
  v_group_by_service BOOLEAN := FALSE;
  v_group_by_route BOOLEAN := FALSE;
  v_group_by_priority BOOLEAN := FALSE;
  v_service_match_field TEXT := 'service_level_or_type';
  v_route_key_paths TEXT := NULL;
  v_priority_bands JSONB := '[]'::jsonb;
  v_basket_type TEXT;
  v_default_basket_type TEXT;
  v_default_state TEXT;
  v_open_states TEXT[];
  v_zone_id UUID;
  v_shipment_zone_id UUID;
  v_sort_branch_id UUID := NULL;
  v_sort_service_key TEXT := NULL;
  v_sort_route_key TEXT := NULL;
  v_sort_priority_key TEXT := NULL;
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
  v_ship_service_type TEXT := NULL;
  v_ship_service_level TEXT := NULL;
  v_ship_priority_score NUMERIC := NULL;
  v_ship_metadata JSONB := '{}'::jsonb;
  v_service_level_id UUID := NULL;
  v_has_service_offering BOOLEAN := FALSE;
  v_priority_band JSONB;
  v_priority_min NUMERIC;
  v_priority_max NUMERIC;
  v_candidate_priority_key TEXT;
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
    v_group_by_branch := COALESCE((v_policy->>'group_by_branch')::BOOLEAN, FALSE);
  EXCEPTION
    WHEN others THEN
      v_group_by_branch := FALSE;
  END;

  BEGIN
    v_group_by_service := COALESCE((v_policy->>'group_by_service')::BOOLEAN, FALSE);
  EXCEPTION
    WHEN others THEN
      v_group_by_service := FALSE;
  END;

  BEGIN
    v_group_by_route := COALESCE((v_policy->>'group_by_route')::BOOLEAN, FALSE);
  EXCEPTION
    WHEN others THEN
      v_group_by_route := FALSE;
  END;

  BEGIN
    v_group_by_priority := COALESCE((v_policy->>'group_by_priority')::BOOLEAN, FALSE);
  EXCEPTION
    WHEN others THEN
      v_group_by_priority := FALSE;
  END;

  v_service_match_field := lower(COALESCE(NULLIF(v_policy->>'service_match_field', ''), 'service_level_or_type'));
  IF v_service_match_field NOT IN ('service_level', 'service_type', 'service_level_or_type') THEN
    v_service_match_field := 'service_level_or_type';
  END IF;

  v_route_key_paths := NULLIF(btrim(COALESCE(v_policy->>'route_key_paths', '')), '');

  IF jsonb_typeof(v_policy->'priority_bands') = 'array' THEN
    v_priority_bands := v_policy->'priority_bands';
  END IF;

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

  SELECT s.zone_id,
         NULLIF(btrim(s.service_type), ''),
         NULLIF(btrim(s.service_level), ''),
         s.priority_score,
         COALESCE(s.metadata, '{}'::jsonb)
    INTO v_shipment_zone_id,
         v_ship_service_type,
         v_ship_service_level,
         v_ship_priority_score,
         v_ship_metadata
    FROM public.shipments s
   WHERE s.id = v_ctx.shipment_id
     AND s.client_id = v_ctx.client_id
   LIMIT 1;

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
    v_zone_id := v_shipment_zone_id;
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
        'service_type', v_ship_service_type,
        'service_level', v_ship_service_level,
        'priority_score', v_ship_priority_score,
        'policy_context', v_policy_ctx
      )),
      p_merge_notes := NULL
    );
  END IF;

  IF v_require_zone AND v_zone_id IS NULL THEN
    v_reason := 'zone_missing';
  END IF;

  IF v_reason IS NULL AND v_group_by_branch THEN
    v_sort_branch_id := public.resolve_branch_id_for_zone(v_zone_id);
    IF v_sort_branch_id IS NULL THEN
      v_reason := 'branch_missing';
    END IF;
  END IF;

  IF v_reason IS NULL AND v_group_by_service THEN
    v_sort_service_key := CASE v_service_match_field
      WHEN 'service_level' THEN v_ship_service_level
      WHEN 'service_type' THEN v_ship_service_type
      ELSE COALESCE(v_ship_service_level, v_ship_service_type)
    END;

    IF v_sort_service_key IS NULL THEN
      v_reason := 'service_missing';
    ELSIF v_sort_branch_id IS NOT NULL AND v_service_match_field <> 'service_type' THEN
      SELECT sl.id
        INTO v_service_level_id
        FROM public.service_levels sl
       WHERE sl.organization_id = v_ctx.organization_id
         AND sl.is_active IS TRUE
         AND sl.key = v_sort_service_key
       ORDER BY sl.created_at DESC, sl.id
       LIMIT 1;

      IF v_service_level_id IS NOT NULL THEN
        SELECT EXISTS (
          SELECT 1
            FROM public.service_offerings so
           WHERE so.branch_id = v_sort_branch_id
             AND so.service_level_id = v_service_level_id
             AND so.is_active IS TRUE
             AND so.effective_from <= v_now
             AND (so.effective_to IS NULL OR so.effective_to > v_now)
             AND (so.zone_id IS NULL OR so.zone_id = v_zone_id)
        )
          INTO v_has_service_offering;

        IF NOT v_has_service_offering THEN
          v_reason := 'branch_service_unavailable';
        END IF;
      END IF;
    END IF;
  END IF;

  IF v_reason IS NULL AND v_group_by_route THEN
    IF v_route_key_paths IS NULL THEN
      v_reason := 'route_policy_missing';
    ELSE
      v_sort_route_key := NULLIF(btrim(COALESCE(workflow_handlers.resolve_path_text(v_context, v_route_key_paths), '')), '');
      IF v_sort_route_key IS NULL THEN
        v_reason := 'route_missing';
      END IF;
    END IF;
  END IF;

  IF v_reason IS NULL AND v_group_by_priority THEN
    IF v_ship_priority_score IS NULL THEN
      v_reason := 'priority_missing';
    ELSIF jsonb_typeof(v_priority_bands) IS DISTINCT FROM 'array'
       OR jsonb_array_length(v_priority_bands) = 0 THEN
      v_reason := 'priority_policy_missing';
    ELSE
      FOR v_priority_band IN
        SELECT value FROM jsonb_array_elements(v_priority_bands)
      LOOP
        v_candidate_priority_key := NULLIF(btrim(COALESCE(v_priority_band->>'key', '')), '');
        IF v_candidate_priority_key IS NULL THEN
          CONTINUE;
        END IF;

        BEGIN
          v_priority_min := NULLIF(v_priority_band->>'min_score', '')::NUMERIC;
        EXCEPTION
          WHEN others THEN
            v_priority_min := NULL;
        END;

        BEGIN
          v_priority_max := NULLIF(v_priority_band->>'max_score', '')::NUMERIC;
        EXCEPTION
          WHEN others THEN
            v_priority_max := NULL;
        END;

        IF (v_priority_min IS NULL OR v_ship_priority_score >= v_priority_min)
           AND (v_priority_max IS NULL OR v_ship_priority_score <= v_priority_max) THEN
          v_sort_priority_key := v_candidate_priority_key;
          EXIT;
        END IF;
      END LOOP;

      IF v_sort_priority_key IS NULL THEN
        v_reason := 'priority_bucket_missing';
      END IF;
    END IF;
  END IF;

  IF v_reason IS NOT NULL THEN
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
        'zone_id', v_zone_id,
        'sort_branch_id', v_sort_branch_id,
        'sort_service_key', v_sort_service_key,
        'sort_route_key', v_sort_route_key,
        'sort_priority_key', v_sort_priority_key,
        'settings_resolution_id', v_settings_resolution_id
      )),
      p_decision_reason := v_reason,
      p_settings_resolution_id := v_settings_resolution_id
    );

    v_response.status := 'completed';
    v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
      'assigned', FALSE,
      'reason', v_reason,
      'zone_id', v_zone_id,
      'sort_branch_id', v_sort_branch_id,
      'sort_service_key', v_sort_service_key,
      'sort_route_key', v_sort_route_key,
      'sort_priority_key', v_sort_priority_key,
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
      'sort_branch_id', v_sort_branch_id,
      'sort_service_key', v_sort_service_key,
      'sort_route_key', v_sort_route_key,
      'sort_priority_key', v_sort_priority_key,
      'settings_resolution_id', v_settings_resolution_id
    ));
    v_response.context_patch := jsonb_strip_nulls(jsonb_build_object(
      'basket', jsonb_strip_nulls(jsonb_build_object(
        'basket_id', v_existing_basket_id,
        'sort_branch_id', v_sort_branch_id,
        'sort_service_key', v_sort_service_key,
        'sort_route_key', v_sort_route_key,
        'sort_priority_key', v_sort_priority_key
      ))
    ));
    RETURN v_response;
  END IF;

  v_expires_at := CASE
    WHEN v_expires_minutes IS NOT NULL AND v_expires_minutes > 0 THEN v_now + make_interval(mins => v_expires_minutes)
    ELSE NULL
  END;

  -- Prefer an open basket with the same resolved sort dimensions, otherwise create one.
  SELECT b.id
  INTO v_basket_id
  FROM public.baskets b
  WHERE b.organization_id = v_ctx.organization_id
    AND (v_zone_id IS NULL OR b.zone_id = v_zone_id)
    AND (v_basket_type IS NULL OR b.basket_type = v_basket_type)
    AND (v_open_states IS NULL OR b.state = ANY(v_open_states))
    AND (b.expires_at IS NULL OR b.expires_at > v_now)
    AND (b.capacity_count IS NULL OR b.current_count < b.capacity_count)
    AND b.sort_branch_id IS NOT DISTINCT FROM v_sort_branch_id
    AND b.sort_service_key IS NOT DISTINCT FROM v_sort_service_key
    AND b.sort_route_key IS NOT DISTINCT FROM v_sort_route_key
    AND b.sort_priority_key IS NOT DISTINCT FROM v_sort_priority_key
  ORDER BY b.updated_at DESC NULLS LAST, b.created_at DESC, b.id
  LIMIT 1;

  IF v_basket_id IS NULL AND v_create_if_missing THEN
    INSERT INTO public.baskets (
      organization_id,
      zone_id,
      basket_type,
      capacity_count,
      expires_at,
      sort_branch_id,
      sort_service_key,
      sort_route_key,
      sort_priority_key
    )
    VALUES (
      v_ctx.organization_id,
      v_zone_id,
      v_basket_type,
      v_capacity_override,
      v_expires_at,
      v_sort_branch_id,
      v_sort_service_key,
      v_sort_route_key,
      v_sort_priority_key
    )
    RETURNING id INTO v_basket_id;
  END IF;

  IF v_basket_id IS NULL THEN
    v_reason := 'no_basket_available';
    v_response.status := 'completed';
    v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
      'assigned', FALSE,
      'reason', v_reason,
      'zone_id', v_zone_id,
      'sort_branch_id', v_sort_branch_id,
      'sort_service_key', v_sort_service_key,
      'sort_route_key', v_sort_route_key,
      'sort_priority_key', v_sort_priority_key,
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
        'sort_branch_id', v_sort_branch_id,
        'sort_service_key', v_sort_service_key,
        'sort_route_key', v_sort_route_key,
        'sort_priority_key', v_sort_priority_key,
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
    'sort_branch_id', v_sort_branch_id,
    'sort_service_key', v_sort_service_key,
    'sort_route_key', v_sort_route_key,
    'sort_priority_key', v_sort_priority_key,
    'reason', v_reason
  ));

  PERFORM public.log_decision(
    p_organization_id := v_ctx.organization_id,
    p_decision_category := 'settings_resolution',
    p_resource_type := 'shipment',
    p_resource_id := v_ctx.shipment_id,
    p_decision_point := 'basket_assign',
    p_decision_outcome := CASE WHEN v_assigned THEN 'assigned' ELSE 'failed' END,
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
    'sort_branch_id', v_sort_branch_id,
    'sort_service_key', v_sort_service_key,
    'sort_route_key', v_sort_route_key,
    'sort_priority_key', v_sort_priority_key,
    'reason', v_reason,
    'settings_resolution_id', v_settings_resolution_id
  ));

  v_response.context_patch := jsonb_strip_nulls(jsonb_build_object(
    'basket', jsonb_strip_nulls(jsonb_build_object(
      'basket_id', CASE WHEN v_assigned THEN v_basket_id ELSE NULL END,
      'zone_id', v_zone_id,
      'sort_branch_id', v_sort_branch_id,
      'sort_service_key', v_sort_service_key,
      'sort_route_key', v_sort_route_key,
      'sort_priority_key', v_sort_priority_key
    ))
  ));

  RETURN v_response;
END;
$function$;

ALTER FUNCTION workflow_handlers.execute_basket_assign_v1(public.workflow_run_steps, public.workflow_runs, JSONB)
  SET search_path TO workflow_handlers, public, extensions, pg_temp;

COMMENT ON FUNCTION workflow_handlers.execute_basket_assign_v1(public.workflow_run_steps, public.workflow_runs, JSONB)
  IS 'Assign shipment to a basket using basket_policy settings ladder and optional zone/branch/service/route/priority grouping.';

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
  'Assign shipment to basket using basket_policy settings ladder and resolved sort dimensions.',
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

SELECT pg_advisory_unlock(hashtext('202604051200_b04_uc051_sort_policy_v1'));
COMMIT;
