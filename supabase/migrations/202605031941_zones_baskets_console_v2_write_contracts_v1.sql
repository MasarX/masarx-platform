-- Console V2 zones/baskets write contracts.
--
-- Adds the missing browser-safe canonical write seams for:
--   - zone profile update
--   - zone soft delete / retire
--   - manual basket creation
--
-- Basket item membership intentionally stays workflow/policy-owned through
-- basket assignment and shipment resort flows. Console V2 may inspect
-- basket_items but must not directly insert/delete item rows.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605031941_zones_baskets_console_v2_write_contracts_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;
GRANT USAGE ON SCHEMA api TO authenticated, service_role;

DO $$
DECLARE
  v_decision_category_def uuid;
  v_decision_outcome_def uuid;
BEGIN
  SELECT id INTO v_decision_category_def
    FROM public.lookup_definitions
   WHERE category = 'decision_category'
   LIMIT 1;

  IF v_decision_category_def IS NULL THEN
    RAISE EXCEPTION 'decision_category lookup_definition is required';
  END IF;

  INSERT INTO public.lookup_values (lookup_definition_id, value, label, description, status, sort_order)
  VALUES
    (
      v_decision_category_def,
      'zones.update',
      'Zones update',
      'Zone profile update decisions from Console V2.',
      'active',
      1061
    ),
    (
      v_decision_category_def,
      'baskets.create',
      'Baskets create',
      'Manual basket creation decisions from Console V2.',
      'active',
      1062
    )
  ON CONFLICT (lookup_definition_id, value) DO UPDATE
  SET label = EXCLUDED.label,
      description = EXCLUDED.description,
      status = 'active',
      sort_order = EXCLUDED.sort_order;

  SELECT id INTO v_decision_outcome_def
    FROM public.lookup_definitions
   WHERE category = 'decision_outcome'
   LIMIT 1;

  IF v_decision_outcome_def IS NULL THEN
    RAISE EXCEPTION 'decision_outcome lookup_definition is required';
  END IF;

  INSERT INTO public.lookup_values (lookup_definition_id, value, label, description, status, sort_order)
  VALUES
    (
      v_decision_outcome_def,
      'created',
      'Created',
      'Resource was created.',
      'active',
      1010
    ),
    (
      v_decision_outcome_def,
      'updated',
      'Updated',
      'Resource was updated.',
      'active',
      1020
    ),
    (
      v_decision_outcome_def,
      'retired',
      'Retired',
      'Resource was retired without deleting history.',
      'active',
      1030
    )
  ON CONFLICT (lookup_definition_id, value) DO UPDATE
  SET label = EXCLUDED.label,
      description = EXCLUDED.description,
      status = 'active',
      sort_order = EXCLUDED.sort_order;
END $$;

COMMENT ON TABLE public.basket_items IS
  'Basket membership rows. Console V2 does not mutate basket_items directly; membership is owned by workflow_handlers.execute_basket_assign_v1, shipment resort, and policy-driven sorting flows.';

CREATE OR REPLACE FUNCTION public.zone_update_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_caller_org_id uuid := public.current_user_org_id();
  v_args jsonb := COALESCE(p_args, '{}'::jsonb);
  v_patch jsonb := COALESCE(v_args->'patch', '{}'::jsonb);
  v_zone_id_text text := NULLIF(btrim(COALESCE(v_args->>'zone_id', v_args->>'id', '')), '');
  v_zone_id uuid;
  v_zone public.zones%ROWTYPE;
  v_name text;
  v_slug text;
  v_description text;
  v_sort_order integer;
  v_metadata_patch jsonb := '{}'::jsonb;
  v_color_token text;
  v_next_metadata jsonb;
  v_changed jsonb := '{}'::jsonb;
  v_correlation_id uuid := gen_random_uuid();
  v_decision_log_id uuid;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'zone_update_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  IF jsonb_typeof(v_args) IS DISTINCT FROM 'object'
     OR jsonb_typeof(v_patch) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'zone_update_v1 expects { zone_id, patch } jsonb object'
      USING ERRCODE = '22023';
  END IF;

  IF v_zone_id_text IS NULL THEN
    RAISE EXCEPTION 'zone_update_v1 requires zone_id'
      USING ERRCODE = '23502';
  END IF;

  BEGIN
    v_zone_id := v_zone_id_text::uuid;
  EXCEPTION
    WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'zone_update_v1 requires zone_id to be a uuid'
        USING ERRCODE = '22023';
  END;

  IF v_patch ? 'is_active'
     OR v_patch ? 'state'
     OR v_patch ? 'status'
     OR COALESCE(v_patch->'metadata', '{}'::jsonb) ? 'lifecycle' THEN
    RAISE EXCEPTION 'zone_update_v1 only patches profile fields; use suspend/restore/zone_delete_v1 for lifecycle'
      USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_zone
    FROM public.zones
   WHERE id = v_zone_id
   FOR UPDATE;

  IF v_zone.id IS NULL THEN
    RAISE EXCEPTION 'zone_update_v1 zone % not found', v_zone_id
      USING ERRCODE = '23503';
  END IF;

  PERFORM public.assert_capability_v1('zones.write', 'tenant', v_zone.organization_id);

  IF NOT public.is_platform_user() AND v_zone.organization_id <> v_caller_org_id THEN
    RAISE EXCEPTION 'zone_update_v1 zone % outside tenant scope', v_zone_id
      USING ERRCODE = '42501';
  END IF;

  v_name := v_zone.name;
  IF v_patch ? 'name' THEN
    v_name := NULLIF(btrim(COALESCE(v_patch->>'name', '')), '');
    IF v_name IS NULL THEN
      RAISE EXCEPTION 'zone_update_v1 name cannot be blank'
        USING ERRCODE = '23502';
    END IF;
    v_changed := v_changed || jsonb_build_object('name', v_name);
  END IF;

  v_slug := v_zone.slug;
  IF v_patch ? 'slug' THEN
    v_slug := lower(NULLIF(btrim(COALESCE(v_patch->>'slug', '')), ''));
    IF v_slug IS NULL OR v_slug !~ '^[a-z0-9-]+$' THEN
      RAISE EXCEPTION 'zone_update_v1 slug must match ^[a-z0-9-]+$'
        USING ERRCODE = '23514';
    END IF;
    v_changed := v_changed || jsonb_build_object('slug', v_slug);
  END IF;

  v_description := v_zone.description;
  IF v_patch ? 'description' THEN
    v_description := NULLIF(btrim(COALESCE(v_patch->>'description', '')), '');
    v_changed := v_changed || jsonb_build_object('description', v_description);
  END IF;

  v_sort_order := v_zone.sort_order;
  IF v_patch ? 'sort_order' THEN
    v_sort_order := NULLIF(v_patch->>'sort_order', '')::integer;
    v_changed := v_changed || jsonb_build_object('sort_order', v_sort_order);
  END IF;

  IF jsonb_typeof(v_patch->'metadata') = 'object' THEN
    v_metadata_patch := v_metadata_patch || (v_patch->'metadata');
  END IF;

  IF v_patch ? 'color_token' THEN
    v_color_token := lower(NULLIF(btrim(COALESCE(v_patch->>'color_token', '')), ''));
    IF v_color_token IS NOT NULL AND NOT EXISTS (
      SELECT 1
        FROM public.lookup_definitions ld
        JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
       WHERE ld.category = 'zone_color_token'
         AND lv.value = v_color_token
         AND lv.status = 'active'
         AND (lv.effective_from IS NULL OR lv.effective_from <= now())
         AND (lv.effective_until IS NULL OR lv.effective_until > now())
    ) THEN
      RAISE EXCEPTION 'zone_update_v1 invalid zone_color_token: %', v_color_token
        USING ERRCODE = '23514';
    END IF;
    v_metadata_patch := v_metadata_patch || jsonb_build_object('color_token', v_color_token);
    v_changed := v_changed || jsonb_build_object('color_token', v_color_token);
  END IF;

  v_next_metadata := COALESCE(v_zone.metadata, '{}'::jsonb) || v_metadata_patch;

  UPDATE public.zones
     SET name = v_name,
         slug = v_slug,
         description = v_description,
         sort_order = v_sort_order,
         metadata = v_next_metadata,
         updated_at = now()
   WHERE id = v_zone_id;

  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, correlation_id, payload, status
  ) VALUES (
    v_zone.organization_id,
    'zone.updated',
    'zone',
    v_zone_id,
    v_correlation_id,
    jsonb_build_object('zone_id', v_zone_id, 'changed', v_changed),
    'pending'
  );

  v_decision_log_id := public.log_decision(
    p_organization_id := v_zone.organization_id,
    p_decision_category := 'zones.update',
    p_resource_type := 'zone',
    p_resource_id := v_zone_id,
    p_decision_point := 'zone_update_v1',
    p_decision_outcome := 'updated',
    p_performed_by_system := 'zone_update_v1',
    p_correlation_id := v_correlation_id,
    p_decision_inputs := jsonb_build_object('patch', v_patch, 'changed', v_changed)
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'zone_id', v_zone_id,
    'changed', v_changed,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_log_id
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.zone_delete_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_caller_org_id uuid := public.current_user_org_id();
  v_args jsonb := COALESCE(p_args, '{}'::jsonb);
  v_zone_id_text text := NULLIF(btrim(COALESCE(v_args->>'zone_id', v_args->>'id', '')), '');
  v_zone_id uuid;
  v_reason text := NULLIF(btrim(COALESCE(v_args->>'reason', '')), '');
  v_zone public.zones%ROWTYPE;
  v_correlation_id uuid := gen_random_uuid();
  v_decision_log_id uuid;
  v_already_processed boolean := FALSE;
  v_metadata_input jsonb := COALESCE(v_args->'metadata', '{}'::jsonb);
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'zone_delete_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  IF jsonb_typeof(v_args) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'zone_delete_v1 expects a jsonb object payload'
      USING ERRCODE = '22023';
  END IF;

  IF v_zone_id_text IS NULL THEN
    RAISE EXCEPTION 'zone_delete_v1 requires zone_id'
      USING ERRCODE = '23502';
  END IF;

  BEGIN
    v_zone_id := v_zone_id_text::uuid;
  EXCEPTION
    WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'zone_delete_v1 requires zone_id to be a uuid'
        USING ERRCODE = '22023';
  END;

  SELECT *
    INTO v_zone
    FROM public.zones
   WHERE id = v_zone_id
   FOR UPDATE;

  IF v_zone.id IS NULL THEN
    RAISE EXCEPTION 'zone_delete_v1 zone % not found', v_zone_id
      USING ERRCODE = '23503';
  END IF;

  PERFORM public.assert_capability_v1('zones.write', 'tenant', v_zone.organization_id);

  IF NOT public.is_platform_user() AND v_zone.organization_id <> v_caller_org_id THEN
    RAISE EXCEPTION 'zone_delete_v1 zone % outside tenant scope', v_zone_id
      USING ERRCODE = '42501';
  END IF;

  IF v_zone.is_active = FALSE
     AND COALESCE(v_zone.metadata, '{}'::jsonb)->>'lifecycle' = 'retired' THEN
    v_already_processed := TRUE;
  ELSE
    UPDATE public.zones
       SET is_active = FALSE,
           metadata = COALESCE(metadata, '{}'::jsonb)
                    || jsonb_strip_nulls(jsonb_build_object(
                         'lifecycle', 'retired',
                         'retired_at', to_jsonb(now()),
                         'retired_by_user_id', to_jsonb(v_user_id),
                         'retired_reason', v_reason,
                         'retired_metadata', v_metadata_input
                       )),
           updated_at = now()
     WHERE id = v_zone_id;

    INSERT INTO public.domain_events (
      organization_id, event_type, resource_type, resource_id, correlation_id, payload, status
    ) VALUES (
      v_zone.organization_id,
      'zone.retired',
      'zone',
      v_zone_id,
      v_correlation_id,
      jsonb_strip_nulls(jsonb_build_object(
        'zone_id', v_zone_id,
        'reason', v_reason,
        'metadata', v_metadata_input
      )),
      'pending'
    );

    v_decision_log_id := public.log_decision(
      p_organization_id := v_zone.organization_id,
      p_decision_category := 'zone_lifecycle',
      p_resource_type := 'zone',
      p_resource_id := v_zone_id,
      p_decision_point := 'zone_delete_v1',
      p_decision_outcome := 'retired',
      p_performed_by_system := 'zone_delete_v1',
      p_correlation_id := v_correlation_id,
      p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
        'zone_id', v_zone_id,
        'reason', v_reason,
        'metadata', v_metadata_input
      )),
      p_decision_reason := COALESCE(v_reason, 'zone_retire_no_reason')
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'zone_id', v_zone_id,
    'is_active', FALSE,
    'lifecycle', 'retired',
    'already_processed', v_already_processed,
    'correlation_id', CASE WHEN v_already_processed THEN NULL ELSE v_correlation_id END,
    'decision_log_id', v_decision_log_id
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.basket_create_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_caller_org_id uuid := public.current_user_org_id();
  v_args jsonb := COALESCE(p_args, '{}'::jsonb);
  v_target_org_text text := NULLIF(btrim(COALESCE(v_args->>'organization_id', '')), '');
  v_zone_id_text text := NULLIF(btrim(COALESCE(v_args->>'zone_id', '')), '');
  v_target_org uuid;
  v_zone_id uuid;
  v_zone_org uuid;
  v_basket_type text := lower(NULLIF(btrim(COALESCE(v_args->>'basket_type', '')), ''));
  v_state text := lower(NULLIF(btrim(COALESCE(v_args->>'state', '')), ''));
  v_capacity_count integer;
  v_expires_at timestamptz;
  v_expires_minutes integer;
  v_sort_branch_id uuid;
  v_sort_branch_id_text text := NULLIF(btrim(COALESCE(v_args->>'sort_branch_id', '')), '');
  v_sort_service_key text := NULLIF(btrim(COALESCE(v_args->>'sort_service_key', '')), '');
  v_sort_route_key text := NULLIF(btrim(COALESCE(v_args->>'sort_route_key', '')), '');
  v_sort_priority_key text := NULLIF(btrim(COALESCE(v_args->>'sort_priority_key', '')), '');
  v_basket_id uuid;
  v_basket public.baskets%ROWTYPE;
  v_correlation_id uuid := gen_random_uuid();
  v_decision_log_id uuid;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'basket_create_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  IF jsonb_typeof(v_args) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'basket_create_v1 expects a jsonb object payload'
      USING ERRCODE = '22023';
  END IF;

  BEGIN
    v_target_org := v_target_org_text::uuid;
  EXCEPTION
    WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'basket_create_v1 requires organization_id to be a uuid'
        USING ERRCODE = '22023';
  END;

  BEGIN
    v_zone_id := v_zone_id_text::uuid;
  EXCEPTION
    WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'basket_create_v1 requires zone_id to be a uuid'
        USING ERRCODE = '22023';
  END;

  BEGIN
    v_sort_branch_id := v_sort_branch_id_text::uuid;
  EXCEPTION
    WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'basket_create_v1 requires sort_branch_id to be a uuid'
        USING ERRCODE = '22023';
  END;

  BEGIN
    v_capacity_count := NULLIF(v_args->>'capacity_count', '')::integer;
  EXCEPTION
    WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'basket_create_v1 requires capacity_count to be an integer'
        USING ERRCODE = '22023';
  END;

  BEGIN
    v_expires_minutes := NULLIF(v_args->>'expires_in_minutes', '')::integer;
  EXCEPTION
    WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'basket_create_v1 requires expires_in_minutes to be an integer'
        USING ERRCODE = '22023';
  END;

  BEGIN
    v_expires_at := NULLIF(v_args->>'expires_at', '')::timestamptz;
  EXCEPTION
    WHEN invalid_datetime_format THEN
      RAISE EXCEPTION 'basket_create_v1 requires expires_at to be a timestamp'
        USING ERRCODE = '22023';
  END;

  IF v_capacity_count IS NOT NULL AND v_capacity_count < 1 THEN
    RAISE EXCEPTION 'basket_create_v1 capacity_count must be positive'
      USING ERRCODE = '23514';
  END IF;

  IF v_expires_minutes IS NOT NULL AND v_expires_minutes < 1 THEN
    RAISE EXCEPTION 'basket_create_v1 expires_in_minutes must be positive'
      USING ERRCODE = '23514';
  END IF;

  IF v_zone_id IS NOT NULL THEN
    SELECT organization_id
      INTO v_zone_org
      FROM public.zones
     WHERE id = v_zone_id;

    IF v_zone_org IS NULL THEN
      RAISE EXCEPTION 'basket_create_v1 zone % not found', v_zone_id
        USING ERRCODE = '23503';
    END IF;

    v_target_org := COALESCE(v_target_org, v_zone_org);
    IF v_target_org IS DISTINCT FROM v_zone_org THEN
      RAISE EXCEPTION 'basket_create_v1 organization % does not match zone organization %', v_target_org, v_zone_org
        USING ERRCODE = '23514';
    END IF;
  END IF;

  v_target_org := COALESCE(v_target_org, v_caller_org_id);

  IF v_target_org IS NULL THEN
    RAISE EXCEPTION 'basket_create_v1 requires organization_id or tenant scope'
      USING ERRCODE = '23502';
  END IF;

  PERFORM public.assert_capability_v1('baskets.write', 'tenant', v_target_org);

  IF NOT public.is_platform_user() AND v_target_org <> v_caller_org_id THEN
    RAISE EXCEPTION 'basket_create_v1 organization % outside tenant scope', v_target_org
      USING ERRCODE = '42501';
  END IF;

  IF v_basket_type IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'basket_type'
       AND lv.value = v_basket_type
       AND lv.status = 'active'
       AND (lv.effective_from IS NULL OR lv.effective_from <= now())
       AND (lv.effective_until IS NULL OR lv.effective_until > now())
  ) THEN
    RAISE EXCEPTION 'basket_create_v1 invalid basket_type: %', v_basket_type
      USING ERRCODE = '23514';
  END IF;

  IF v_state IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'basket_state'
       AND lv.value = v_state
       AND lv.status = 'active'
       AND (lv.effective_from IS NULL OR lv.effective_from <= now())
       AND (lv.effective_until IS NULL OR lv.effective_until > now())
  ) THEN
    RAISE EXCEPTION 'basket_create_v1 invalid basket_state: %', v_state
      USING ERRCODE = '23514';
  END IF;

  IF v_expires_at IS NULL AND v_expires_minutes IS NOT NULL THEN
    v_expires_at := now() + make_interval(mins => v_expires_minutes);
  END IF;

  INSERT INTO public.baskets (
    organization_id,
    zone_id,
    basket_type,
    state,
    capacity_count,
    expires_at,
    sort_branch_id,
    sort_service_key,
    sort_route_key,
    sort_priority_key
  ) VALUES (
    v_target_org,
    v_zone_id,
    v_basket_type,
    v_state,
    v_capacity_count,
    v_expires_at,
    v_sort_branch_id,
    v_sort_service_key,
    v_sort_route_key,
    v_sort_priority_key
  )
  RETURNING *
    INTO v_basket;

  v_basket_id := v_basket.id;

  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, correlation_id, payload, status
  ) VALUES (
    v_target_org,
    'basket.created',
    'basket',
    v_basket_id,
    v_correlation_id,
    jsonb_strip_nulls(jsonb_build_object(
      'basket_id', v_basket_id,
      'zone_id', v_zone_id,
      'basket_type', v_basket.basket_type,
      'state', v_basket.state,
      'capacity_count', v_basket.capacity_count,
      'expires_at', v_basket.expires_at
    )),
    'pending'
  );

  v_decision_log_id := public.log_decision(
    p_organization_id := v_target_org,
    p_decision_category := 'baskets.create',
    p_resource_type := 'basket',
    p_resource_id := v_basket_id,
    p_decision_point := 'basket_create_v1',
    p_decision_outcome := 'created',
    p_performed_by_system := 'basket_create_v1',
    p_correlation_id := v_correlation_id,
    p_decision_inputs := v_args
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'basket_id', v_basket_id,
    'zone_id', v_basket.zone_id,
    'basket_type', v_basket.basket_type,
    'state', v_basket.state,
    'capacity_count', v_basket.capacity_count,
    'expires_at', v_basket.expires_at,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_log_id
  );
END;
$function$;

CREATE OR REPLACE FUNCTION api.zone_update_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.zone_update_v1(COALESCE($1, '{}'::jsonb));
$function$;

CREATE OR REPLACE FUNCTION api.zone_delete_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.zone_delete_v1(COALESCE($1, '{}'::jsonb));
$function$;

CREATE OR REPLACE FUNCTION api.basket_create_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.basket_create_v1(COALESCE($1, '{}'::jsonb));
$function$;

REVOKE ALL ON FUNCTION public.zone_update_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.zone_update_v1(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.zone_update_v1(jsonb) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.zone_delete_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.zone_delete_v1(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.zone_delete_v1(jsonb) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.basket_create_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.basket_create_v1(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.basket_create_v1(jsonb) TO authenticated, service_role;

REVOKE ALL ON FUNCTION api.zone_update_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.zone_update_v1(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION api.zone_update_v1(jsonb) TO authenticated, service_role;

REVOKE ALL ON FUNCTION api.zone_delete_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.zone_delete_v1(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION api.zone_delete_v1(jsonb) TO authenticated, service_role;

REVOKE ALL ON FUNCTION api.basket_create_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.basket_create_v1(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION api.basket_create_v1(jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public.zone_update_v1(jsonb)
  IS 'Console V2 canonical zone profile update RPC. Capability: zones.write. Lifecycle fields are intentionally rejected; use suspend/restore/zone_delete_v1 for lifecycle.';
COMMENT ON FUNCTION public.zone_delete_v1(jsonb)
  IS 'Console V2 canonical zone soft-delete RPC. Retires the zone with metadata.lifecycle=retired; does not physically delete zone history. Capability: zones.write.';
COMMENT ON FUNCTION public.basket_create_v1(jsonb)
  IS 'Console V2 canonical manual basket creation RPC. Capability: baskets.write. Basket item membership remains workflow/policy-owned.';
COMMENT ON FUNCTION api.zone_update_v1(jsonb)
  IS 'Browser-safe api-schema wrapper for public.zone_update_v1.';
COMMENT ON FUNCTION api.zone_delete_v1(jsonb)
  IS 'Browser-safe api-schema wrapper for public.zone_delete_v1.';
COMMENT ON FUNCTION api.basket_create_v1(jsonb)
  IS 'Browser-safe api-schema wrapper for public.basket_create_v1.';

SELECT pg_advisory_unlock(hashtext('202605031941_zones_baskets_console_v2_write_contracts_v1'));

COMMIT;
