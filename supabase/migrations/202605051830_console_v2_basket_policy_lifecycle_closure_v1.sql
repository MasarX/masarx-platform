-- Migration: Console V2 basket policy lifecycle closure
-- Purpose:
--   - Add the canonical basket profile update RPC used by Console V2.
--   - Keep basket item membership workflow/policy-owned through shipment resort.
--   - Remove raw basket_items/basket_transitions table pages from live
--     ui_navigation and expose the Basket policy domain workbench instead.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605051830_console_v2_basket_policy_lifecycle_closure_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;
GRANT USAGE ON SCHEMA api TO authenticated, service_role;

DO $lookup$
DECLARE
  v_category_def uuid;
  v_outcome_def uuid;
BEGIN
  SELECT id INTO v_category_def
    FROM public.lookup_definitions
   WHERE category = 'decision_category'
   LIMIT 1;

  IF v_category_def IS NULL THEN
    RAISE EXCEPTION 'decision_category lookup_definition is required';
  END IF;

  INSERT INTO public.lookup_values (lookup_definition_id, value, label, description, status, sort_order)
  VALUES (
    v_category_def,
    'baskets.update',
    'Baskets update',
    'Basket profile update decisions from Console V2.',
    'active',
    1063
  )
  ON CONFLICT (lookup_definition_id, value) DO UPDATE
  SET label = EXCLUDED.label,
      description = EXCLUDED.description,
      status = 'active',
      sort_order = EXCLUDED.sort_order;

  SELECT id INTO v_outcome_def
    FROM public.lookup_definitions
   WHERE category = 'decision_outcome'
   LIMIT 1;

  IF v_outcome_def IS NULL THEN
    RAISE EXCEPTION 'decision_outcome lookup_definition is required';
  END IF;

  INSERT INTO public.lookup_values (lookup_definition_id, value, label, description, status, sort_order)
  VALUES (
    v_outcome_def,
    'updated',
    'Updated',
    'Resource was updated.',
    'active',
    1020
  )
  ON CONFLICT (lookup_definition_id, value) DO UPDATE
  SET label = EXCLUDED.label,
      description = EXCLUDED.description,
      status = 'active',
      sort_order = EXCLUDED.sort_order;
END;
$lookup$;

CREATE OR REPLACE FUNCTION public.basket_update_v1(p_args jsonb)
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
  v_basket_id_text text := NULLIF(btrim(COALESCE(v_args->>'basket_id', v_args->>'id', '')), '');
  v_basket_id uuid;
  v_basket public.baskets%ROWTYPE;
  v_zone_id uuid;
  v_zone_org uuid;
  v_basket_type text;
  v_capacity_count integer;
  v_expires_at timestamptz;
  v_expires_minutes integer;
  v_sort_branch_id uuid;
  v_sort_branch_org uuid;
  v_sort_service_key text;
  v_sort_route_key text;
  v_sort_priority_key text;
  v_unsupported_patch_keys text;
  v_changed jsonb := '{}'::jsonb;
  v_correlation_id uuid := gen_random_uuid();
  v_decision_log_id uuid;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'basket_update_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  IF jsonb_typeof(v_args) IS DISTINCT FROM 'object'
     OR jsonb_typeof(v_patch) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'basket_update_v1 expects { basket_id, patch } jsonb object'
      USING ERRCODE = '22023';
  END IF;

  IF v_basket_id_text IS NULL THEN
    RAISE EXCEPTION 'basket_update_v1 requires basket_id'
      USING ERRCODE = '23502';
  END IF;

  BEGIN
    v_basket_id := v_basket_id_text::uuid;
  EXCEPTION
    WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'basket_update_v1 requires basket_id to be a uuid'
        USING ERRCODE = '22023';
  END;

  IF v_patch = '{}'::jsonb THEN
    RAISE EXCEPTION 'basket_update_v1 requires a non-empty patch'
      USING ERRCODE = '22023';
  END IF;

  IF v_patch ?| ARRAY['id', 'organization_id', 'current_count', 'version', 'state'] THEN
    RAISE EXCEPTION 'basket_update_v1 profile edits cannot patch identity, count, version, or state; use ui_update_basket_state_v1 for state'
      USING ERRCODE = '22023';
  END IF;

  SELECT string_agg(patch_key.key, ', ' ORDER BY patch_key.key)
    INTO v_unsupported_patch_keys
    FROM jsonb_object_keys(v_patch) AS patch_key(key)
   WHERE patch_key.key NOT IN (
     'zone_id',
     'basket_type',
     'capacity_count',
     'expires_at',
     'expires_in_minutes',
     'sort_branch_id',
     'sort_service_key',
     'sort_route_key',
     'sort_priority_key'
   );

  IF v_unsupported_patch_keys IS NOT NULL THEN
    RAISE EXCEPTION 'basket_update_v1 unsupported patch keys: %', v_unsupported_patch_keys
      USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_basket
    FROM public.baskets
   WHERE id = v_basket_id
   FOR UPDATE;

  IF v_basket.id IS NULL THEN
    RAISE EXCEPTION 'basket_update_v1 basket % not found', v_basket_id
      USING ERRCODE = '23503';
  END IF;

  PERFORM public.assert_capability_v1('baskets.write', 'tenant', v_basket.organization_id);

  IF NOT public.is_platform_user() AND v_basket.organization_id <> v_caller_org_id THEN
    RAISE EXCEPTION 'basket_update_v1 basket % outside tenant scope', v_basket_id
      USING ERRCODE = '42501';
  END IF;

  v_zone_id := v_basket.zone_id;
  IF v_patch ? 'zone_id' THEN
    BEGIN
      v_zone_id := NULLIF(v_patch->>'zone_id', '')::uuid;
    EXCEPTION
      WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'basket_update_v1 requires zone_id to be a uuid'
          USING ERRCODE = '22023';
    END;

    IF v_zone_id IS NOT NULL THEN
      SELECT organization_id
        INTO v_zone_org
        FROM public.zones
       WHERE id = v_zone_id;

      IF v_zone_org IS NULL THEN
        RAISE EXCEPTION 'basket_update_v1 zone % not found', v_zone_id
          USING ERRCODE = '23503';
      END IF;

      IF v_zone_org IS DISTINCT FROM v_basket.organization_id THEN
        RAISE EXCEPTION 'basket_update_v1 zone organization mismatch'
          USING ERRCODE = '23514';
      END IF;
    END IF;

    v_changed := v_changed || jsonb_build_object('zone_id', v_zone_id);
  END IF;

  v_basket_type := v_basket.basket_type;
  IF v_patch ? 'basket_type' THEN
    v_basket_type := lower(NULLIF(btrim(COALESCE(v_patch->>'basket_type', '')), ''));
    IF v_basket_type IS NULL THEN
      RAISE EXCEPTION 'basket_update_v1 basket_type cannot be blank'
        USING ERRCODE = '23502';
    END IF;

    IF NOT EXISTS (
      SELECT 1
        FROM public.lookup_definitions ld
        JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
       WHERE ld.category = 'basket_type'
         AND lv.value = v_basket_type
         AND lv.status = 'active'
         AND (lv.effective_from IS NULL OR lv.effective_from <= now())
         AND (lv.effective_until IS NULL OR lv.effective_until > now())
    ) THEN
      RAISE EXCEPTION 'basket_update_v1 invalid basket_type: %', v_basket_type
        USING ERRCODE = '23514';
    END IF;

    v_changed := v_changed || jsonb_build_object('basket_type', v_basket_type);
  END IF;

  v_capacity_count := v_basket.capacity_count;
  IF v_patch ? 'capacity_count' THEN
    BEGIN
      v_capacity_count := NULLIF(v_patch->>'capacity_count', '')::integer;
    EXCEPTION
      WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'basket_update_v1 requires capacity_count to be an integer'
          USING ERRCODE = '22023';
    END;

    IF v_capacity_count IS NOT NULL AND v_capacity_count < 1 THEN
      RAISE EXCEPTION 'basket_update_v1 capacity_count must be positive'
        USING ERRCODE = '23514';
    END IF;

    IF v_capacity_count IS NOT NULL AND v_capacity_count < COALESCE(v_basket.current_count, 0) THEN
      RAISE EXCEPTION 'basket_update_v1 capacity_count cannot be below current_count'
        USING ERRCODE = '23514';
    END IF;

    v_changed := v_changed || jsonb_build_object('capacity_count', v_capacity_count);
  END IF;

  v_expires_at := v_basket.expires_at;
  IF v_patch ? 'expires_at' THEN
    BEGIN
      v_expires_at := NULLIF(v_patch->>'expires_at', '')::timestamptz;
    EXCEPTION
      WHEN invalid_datetime_format THEN
        RAISE EXCEPTION 'basket_update_v1 requires expires_at to be a timestamp'
          USING ERRCODE = '22023';
    END;
    v_changed := v_changed || jsonb_build_object('expires_at', v_expires_at);
  ELSIF v_patch ? 'expires_in_minutes' THEN
    BEGIN
      v_expires_minutes := NULLIF(v_patch->>'expires_in_minutes', '')::integer;
    EXCEPTION
      WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'basket_update_v1 requires expires_in_minutes to be an integer'
          USING ERRCODE = '22023';
    END;

    IF v_expires_minutes IS NULL OR v_expires_minutes < 1 THEN
      RAISE EXCEPTION 'basket_update_v1 expires_in_minutes must be positive'
        USING ERRCODE = '23514';
    END IF;

    v_expires_at := now() + make_interval(mins => v_expires_minutes);
    v_changed := v_changed || jsonb_build_object('expires_at', v_expires_at);
  END IF;

  v_sort_branch_id := v_basket.sort_branch_id;
  IF v_patch ? 'sort_branch_id' THEN
    BEGIN
      v_sort_branch_id := NULLIF(v_patch->>'sort_branch_id', '')::uuid;
    EXCEPTION
      WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'basket_update_v1 requires sort_branch_id to be a uuid'
          USING ERRCODE = '22023';
    END;

    IF v_sort_branch_id IS NOT NULL THEN
      SELECT organization_id
        INTO v_sort_branch_org
        FROM public.branches
       WHERE id = v_sort_branch_id;

      IF v_sort_branch_org IS NULL THEN
        RAISE EXCEPTION 'basket_update_v1 sort branch % not found', v_sort_branch_id
          USING ERRCODE = '23503';
      END IF;

      IF v_sort_branch_org IS DISTINCT FROM v_basket.organization_id THEN
        RAISE EXCEPTION 'basket_update_v1 sort branch organization mismatch'
          USING ERRCODE = '23514';
      END IF;
    END IF;

    v_changed := v_changed || jsonb_build_object('sort_branch_id', v_sort_branch_id);
  END IF;

  v_sort_service_key := v_basket.sort_service_key;
  IF v_patch ? 'sort_service_key' THEN
    v_sort_service_key := NULLIF(btrim(COALESCE(v_patch->>'sort_service_key', '')), '');
    v_changed := v_changed || jsonb_build_object('sort_service_key', v_sort_service_key);
  END IF;

  v_sort_route_key := v_basket.sort_route_key;
  IF v_patch ? 'sort_route_key' THEN
    v_sort_route_key := NULLIF(btrim(COALESCE(v_patch->>'sort_route_key', '')), '');
    v_changed := v_changed || jsonb_build_object('sort_route_key', v_sort_route_key);
  END IF;

  v_sort_priority_key := v_basket.sort_priority_key;
  IF v_patch ? 'sort_priority_key' THEN
    v_sort_priority_key := NULLIF(btrim(COALESCE(v_patch->>'sort_priority_key', '')), '');
    v_changed := v_changed || jsonb_build_object('sort_priority_key', v_sort_priority_key);
  END IF;

  UPDATE public.baskets
     SET zone_id = v_zone_id,
         basket_type = v_basket_type,
         capacity_count = v_capacity_count,
         expires_at = v_expires_at,
         sort_branch_id = v_sort_branch_id,
         sort_service_key = v_sort_service_key,
         sort_route_key = v_sort_route_key,
         sort_priority_key = v_sort_priority_key,
         updated_at = now()
   WHERE id = v_basket_id;

  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, correlation_id, payload, status
  ) VALUES (
    v_basket.organization_id,
    'basket.updated',
    'basket',
    v_basket_id,
    v_correlation_id,
    jsonb_build_object('basket_id', v_basket_id, 'changed', v_changed),
    'pending'
  );

  v_decision_log_id := public.log_decision(
    p_organization_id := v_basket.organization_id,
    p_decision_category := 'baskets.update',
    p_resource_type := 'basket',
    p_resource_id := v_basket_id,
    p_decision_point := 'basket_update_v1',
    p_decision_outcome := 'updated',
    p_performed_by_system := 'basket_update_v1',
    p_correlation_id := v_correlation_id,
    p_decision_inputs := jsonb_build_object('patch', v_patch, 'changed', v_changed)
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'basket_id', v_basket_id,
    'changed', v_changed,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_log_id
  );
END;
$function$;

CREATE OR REPLACE FUNCTION api.basket_update_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.basket_update_v1(COALESCE($1, '{}'::jsonb));
$function$;

REVOKE ALL ON FUNCTION public.basket_update_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.basket_update_v1(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.basket_update_v1(jsonb) TO authenticated, service_role;

REVOKE ALL ON FUNCTION api.basket_update_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.basket_update_v1(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION api.basket_update_v1(jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public.basket_update_v1(jsonb)
  IS 'Console V2 canonical basket profile update RPC. Capability: baskets.write. State changes use ui_update_basket_state_v1; membership changes stay workflow/policy-owned through shipment resort.';
COMMENT ON FUNCTION api.basket_update_v1(jsonb)
  IS 'Browser-safe api-schema wrapper for public.basket_update_v1.';

DO $navigation$
DECLARE
  v_row record;
  v_current jsonb;
  v_next jsonb;
  v_sections jsonb;
  v_updated_sections jsonb;
  v_section jsonb;
  v_items jsonb;
  v_clean_items jsonb;
  v_new_items jsonb;
  v_item jsonb;
  v_section_id text;
  v_has_operate boolean;
  v_inserted boolean;
  v_basket_item jsonb := jsonb_build_object(
    'id', 'operate-baskets',
    'key', 'baskets',
    'label', 'Basket policy',
    'href', '/operate/baskets',
    'route', '/operate/baskets',
    'resource', 'baskets',
    'capability', 'baskets.read',
    'icon', 'layers'
  );
BEGIN
  FOR v_row IN
    SELECT
      s.id AS settings_id,
      s.settings_version_id,
      sv.version,
      COALESCE(sv.value, s.cached_value, '{}'::jsonb) AS value
    FROM public.settings s
    JOIN public.settings_versions sv
      ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_navigation'
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    v_sections := COALESCE(v_current#>'{apps,console,sections}', '[]'::jsonb);
    IF jsonb_typeof(v_sections) IS DISTINCT FROM 'array' THEN
      v_sections := '[]'::jsonb;
    END IF;

    v_updated_sections := '[]'::jsonb;
    v_has_operate := FALSE;

    FOR v_section IN
      SELECT value
      FROM jsonb_array_elements(v_sections) AS value
    LOOP
      v_section_id := lower(COALESCE(v_section->>'id', ''));
      v_items := COALESCE(v_section->'items', '[]'::jsonb);
      IF jsonb_typeof(v_items) IS DISTINCT FROM 'array' THEN
        v_items := '[]'::jsonb;
      END IF;

      SELECT COALESCE(jsonb_agg(item.value ORDER BY item.ordinality), '[]'::jsonb)
        INTO v_clean_items
        FROM jsonb_array_elements(v_items) WITH ORDINALITY AS item(value, ordinality)
       WHERE COALESCE(item.value->>'resource', '') NOT IN ('baskets', 'basket_items', 'basket_transitions')
         AND COALESCE(item.value->>'route', item.value->>'href', '') NOT IN (
           '/console/resources/baskets',
           '/console/resources/basket_items',
           '/console/resources/basket_transitions',
           '/operate/baskets'
         )
         AND COALESCE(item.value->>'key', item.value->>'id', '') NOT IN (
           'console-baskets',
           'console-basket-items',
           'console-basket-transitions',
           'basket-items',
           'basket-transitions',
           'operate-baskets',
           'baskets'
         );

      IF v_section_id IN ('operate', 'operations') THEN
        v_has_operate := TRUE;
        v_new_items := '[]'::jsonb;
        v_inserted := FALSE;

        FOR v_item IN
          SELECT value
          FROM jsonb_array_elements(v_clean_items) AS value
        LOOP
          IF NOT v_inserted
             AND (
               COALESCE(v_item->>'route', v_item->>'href', '') IN ('/operate/amend-cancel', '/operate/exceptions')
               OR COALESCE(v_item->>'key', v_item->>'id', '') IN ('amend-cancel', 'exceptions')
             ) THEN
            v_new_items := v_new_items || jsonb_build_array(v_basket_item);
            v_inserted := TRUE;
          END IF;

          v_new_items := v_new_items || jsonb_build_array(v_item);
        END LOOP;

        IF NOT v_inserted THEN
          v_new_items := v_new_items || jsonb_build_array(v_basket_item);
        END IF;

        v_section := jsonb_set(v_section, '{items}', v_new_items, TRUE);
      ELSE
        v_section := jsonb_set(v_section, '{items}', v_clean_items, TRUE);
      END IF;

      v_updated_sections := v_updated_sections || jsonb_build_array(v_section);
    END LOOP;

    IF NOT v_has_operate THEN
      v_updated_sections := v_updated_sections || jsonb_build_array(
        jsonb_build_object(
          'id', 'operate',
          'label', 'Operate',
          'items', jsonb_build_array(v_basket_item)
        )
      );
    END IF;

    v_next := jsonb_set(v_current, '{apps,console,sections}', v_updated_sections, TRUE);

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_row.version + 1,
             change_reason = 'Expose Console V2 Basket policy and remove raw basket table navigation',
             approved_at = now(),
             effective_from = now(),
             updated_at = now()
       WHERE id = v_row.settings_version_id;

      UPDATE public.settings
         SET cached_value = v_next,
             last_updated = now()
       WHERE id = v_row.settings_id;
    END IF;
  END LOOP;
END;
$navigation$;

SELECT pg_advisory_unlock(hashtext('202605051830_console_v2_basket_policy_lifecycle_closure_v1'));

COMMIT;
