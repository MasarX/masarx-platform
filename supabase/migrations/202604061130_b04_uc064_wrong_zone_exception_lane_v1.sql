-- Plan: B04 UC064 wrong-zone exception lane / Step: E01
-- Migration: expose a dedicated wrong-zone exception alias lane over mis-sort SSOT
-- Date: 2026-04-06
--
-- Purpose:
--   - Classify zone mismatches explicitly inside the canonical mis-sort sync path.
--   - Expose a dedicated wrong_zone_exceptions resource and resolve command for
--     Portal/Console exception triage without duplicating the underlying truth.
--   - Keep the slice row-driven by shared registry/access/navigation settings.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604061130_b04_uc064_wrong_zone_exception_lane_v1'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE INDEX IF NOT EXISTS idx_mis_sort_exceptions_reason_detected
  ON public.mis_sort_exceptions (organization_id, exception_reason, detected_at DESC);

CREATE OR REPLACE FUNCTION public.sync_mis_sort_exception_v1(
  p_basket_item_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_item RECORD;
  v_profile RECORD;
  v_mismatch BOOLEAN := FALSE;
  v_exception_id UUID := NULL;
  v_exception_reason TEXT := 'basket_assignment_mismatch';
BEGIN
  IF p_basket_item_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT
    bi.id,
    bi.basket_id,
    bi.shipment_id,
    bi.shipment_client_id,
    bi.removed_at,
    b.organization_id,
    b.zone_id AS actual_zone_id,
    b.sort_branch_id AS actual_sort_branch_id,
    b.sort_service_key AS actual_sort_service_key,
    b.sort_route_key AS actual_sort_route_key,
    b.sort_priority_key AS actual_sort_priority_key
  INTO v_item
  FROM public.basket_items bi
  JOIN public.baskets b ON b.id = bi.basket_id
  WHERE bi.id = p_basket_item_id
  LIMIT 1;

  IF v_item.id IS NULL OR v_item.removed_at IS NOT NULL THEN
    DELETE FROM public.mis_sort_exceptions mse
     WHERE mse.basket_item_id = p_basket_item_id;
    RETURN NULL;
  END IF;

  SELECT *
    INTO v_profile
    FROM public.resolve_shipment_basket_profile_v1(v_item.shipment_id, v_item.shipment_client_id)
   LIMIT 1;

  IF v_profile.reason IS NOT NULL THEN
    DELETE FROM public.mis_sort_exceptions mse
     WHERE mse.basket_item_id = p_basket_item_id;
    RETURN NULL;
  END IF;

  v_mismatch :=
    v_item.actual_zone_id IS DISTINCT FROM v_profile.zone_id
    OR v_item.actual_sort_branch_id IS DISTINCT FROM v_profile.sort_branch_id
    OR v_item.actual_sort_service_key IS DISTINCT FROM v_profile.sort_service_key
    OR v_item.actual_sort_route_key IS DISTINCT FROM v_profile.sort_route_key
    OR v_item.actual_sort_priority_key IS DISTINCT FROM v_profile.sort_priority_key;

  IF NOT v_mismatch THEN
    DELETE FROM public.mis_sort_exceptions mse
     WHERE mse.basket_item_id = p_basket_item_id;
    RETURN NULL;
  END IF;

  IF v_item.actual_zone_id IS DISTINCT FROM v_profile.zone_id THEN
    v_exception_reason := 'wrong_zone';
  END IF;

  INSERT INTO public.mis_sort_exceptions (
    organization_id,
    shipment_id,
    shipment_client_id,
    basket_item_id,
    basket_id,
    exception_reason,
    actual_zone_id,
    expected_zone_id,
    actual_sort_branch_id,
    expected_sort_branch_id,
    actual_sort_service_key,
    expected_sort_service_key,
    actual_sort_route_key,
    expected_sort_route_key,
    actual_sort_priority_key,
    expected_sort_priority_key,
    metadata,
    detected_at,
    updated_at
  )
  VALUES (
    v_item.organization_id,
    v_item.shipment_id,
    v_item.shipment_client_id,
    v_item.id,
    v_item.basket_id,
    v_exception_reason,
    v_item.actual_zone_id,
    v_profile.zone_id,
    v_item.actual_sort_branch_id,
    v_profile.sort_branch_id,
    v_item.actual_sort_service_key,
    v_profile.sort_service_key,
    v_item.actual_sort_route_key,
    v_profile.sort_route_key,
    v_item.actual_sort_priority_key,
    v_profile.sort_priority_key,
    jsonb_strip_nulls(jsonb_build_object(
      'basket_type', v_profile.basket_type,
      'open_states', v_profile.open_states
    )),
    now(),
    now()
  )
  ON CONFLICT (basket_item_id) DO UPDATE
     SET basket_id = EXCLUDED.basket_id,
         exception_reason = EXCLUDED.exception_reason,
         actual_zone_id = EXCLUDED.actual_zone_id,
         expected_zone_id = EXCLUDED.expected_zone_id,
         actual_sort_branch_id = EXCLUDED.actual_sort_branch_id,
         expected_sort_branch_id = EXCLUDED.expected_sort_branch_id,
         actual_sort_service_key = EXCLUDED.actual_sort_service_key,
         expected_sort_service_key = EXCLUDED.expected_sort_service_key,
         actual_sort_route_key = EXCLUDED.actual_sort_route_key,
         expected_sort_route_key = EXCLUDED.expected_sort_route_key,
         actual_sort_priority_key = EXCLUDED.actual_sort_priority_key,
         expected_sort_priority_key = EXCLUDED.expected_sort_priority_key,
         metadata = EXCLUDED.metadata,
         detected_at = EXCLUDED.detected_at,
         updated_at = now()
  RETURNING id INTO v_exception_id;

  RETURN v_exception_id;
END;
$function$;

COMMENT ON FUNCTION public.sync_mis_sort_exception_v1(UUID) IS
  'Create, refresh, or clear the active mis-sort exception row for one basket_item, classifying zone mismatches as wrong_zone.';

UPDATE public.mis_sort_exceptions mse
   SET exception_reason = CASE
         WHEN mse.actual_zone_id IS DISTINCT FROM mse.expected_zone_id THEN 'wrong_zone'
         ELSE 'basket_assignment_mismatch'
       END,
       updated_at = now()
 WHERE COALESCE(mse.exception_reason, '') IS DISTINCT FROM CASE
         WHEN mse.actual_zone_id IS DISTINCT FROM mse.expected_zone_id THEN 'wrong_zone'
         ELSE 'basket_assignment_mismatch'
       END;

DO $do$
DECLARE
  v_row RECORD;
  v_current JSONB := NULL;
  v_next JSONB := NULL;
  v_resource_map JSONB := '{}'::jsonb;
BEGIN
  FOR v_row IN
    SELECT
      s.id AS settings_id,
      s.settings_version_id,
      sv.version,
      sv.value
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'access_control_policy'
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    v_resource_map := COALESCE(v_current->'resource_map', '{}'::jsonb);
    IF jsonb_typeof(v_resource_map) IS DISTINCT FROM 'object' THEN
      v_resource_map := '{}'::jsonb;
    END IF;

    v_resource_map := jsonb_set(
      v_resource_map,
      '{wrong_zone_exceptions}',
      jsonb_build_object('read', 'baskets.read', 'write', 'baskets.write'),
      TRUE
    );

    v_next := jsonb_set(v_current, '{resource_map}', v_resource_map, TRUE);

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_row.version + 1,
             change_reason = 'Expose wrong_zone_exceptions through access_control_policy.',
             approved_at = workflow_now(),
             effective_from = workflow_now()
       WHERE id = v_row.settings_version_id;

      UPDATE public.settings
         SET cached_value = v_next,
             last_updated = workflow_now()
       WHERE id = v_row.settings_id;
    END IF;
  END LOOP;
END;
$do$;

DO $do$
DECLARE
  v_row RECORD;
  v_current JSONB := NULL;
  v_next JSONB := NULL;
  v_resources JSONB := '[]'::jsonb;
  v_updated_resources JSONB := '[]'::jsonb;
  v_resource JSONB := NULL;
  v_resource_key TEXT := NULL;
  v_base_filter JSONB := jsonb_build_object(
    'op', 'and',
    'rules', jsonb_build_array(
      jsonb_build_object('key', 'exception_reason', 'op', 'eq', 'value', 'wrong_zone')
    )
  );
  v_canonical_resource JSONB := jsonb_build_object(
    'key', 'wrong_zone_exceptions',
    'label', 'Wrong-zone exceptions',
    'description', 'Shipment basket assignments where the actual zone does not match the canonical basket-policy target zone.',
    'relation', 'public.mis_sort_exceptions',
    'id_column', 'id',
    'scope_columns', jsonb_build_object('tenant', 'organization_id'),
    'capability_read', 'baskets.read',
    'capability_write', 'baskets.write',
    'select', jsonb_build_array(
      'id',
      'organization_id',
      'shipment_id',
      'shipment_client_id',
      'basket_item_id',
      'basket_id',
      'exception_reason',
      'actual_zone_id',
      'expected_zone_id',
      'actual_sort_branch_id',
      'expected_sort_branch_id',
      'actual_sort_service_key',
      'expected_sort_service_key',
      'actual_sort_route_key',
      'expected_sort_route_key',
      'actual_sort_priority_key',
      'expected_sort_priority_key',
      'detected_at',
      'updated_at'
    ),
    'filters', jsonb_build_array(
      jsonb_build_object('key', 'shipment_id', 'column', 'shipment_id', 'op', 'eq'),
      jsonb_build_object('key', 'basket_id', 'column', 'basket_id', 'op', 'eq'),
      jsonb_build_object('key', 'exception_reason', 'column', 'exception_reason', 'op', 'eq'),
      jsonb_build_object('key', 'actual_zone_id', 'column', 'actual_zone_id', 'op', 'eq'),
      jsonb_build_object('key', 'expected_zone_id', 'column', 'expected_zone_id', 'op', 'eq')
    ),
    'columns', jsonb_build_array(
      jsonb_build_object('key', 'shipment_id', 'label', 'Shipment', 'render_type', 'id', 'detail_section', 'Shipment'),
      jsonb_build_object('key', 'exception_reason', 'label', 'Exception reason', 'detail_section', 'Summary'),
      jsonb_build_object('key', 'actual_zone_id', 'label', 'Actual zone', 'render_type', 'id', 'detail_section', 'Actual assignment'),
      jsonb_build_object('key', 'expected_zone_id', 'label', 'Expected zone', 'render_type', 'id', 'detail_section', 'Expected assignment'),
      jsonb_build_object('key', 'actual_sort_branch_id', 'label', 'Actual branch', 'render_type', 'id', 'detail_section', 'Actual assignment'),
      jsonb_build_object('key', 'expected_sort_branch_id', 'label', 'Expected branch', 'render_type', 'id', 'detail_section', 'Expected assignment'),
      jsonb_build_object('key', 'detected_at', 'label', 'Detected at', 'detail_section', 'Summary')
    ),
    'column_labels', jsonb_build_object(
      'shipment_id', 'Shipment',
      'exception_reason', 'Exception reason',
      'actual_zone_id', 'Actual zone',
      'expected_zone_id', 'Expected zone',
      'actual_sort_branch_id', 'Actual branch',
      'expected_sort_branch_id', 'Expected branch',
      'detected_at', 'Detected at'
    ),
    'base_filter', v_base_filter,
    'default_sort', jsonb_build_object('column', 'detected_at', 'direction', 'desc')
  );
  v_mis_sort_resource JSONB := NULL;
BEGIN
  FOR v_row IN
    SELECT
      s.id AS settings_id,
      s.settings_version_id,
      sv.version,
      sv.value
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_read_registry'
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    v_resources := COALESCE(v_current->'resources', '[]'::jsonb);
    IF jsonb_typeof(v_resources) IS DISTINCT FROM 'array' THEN
      v_resources := '[]'::jsonb;
    END IF;

    SELECT value
      INTO v_mis_sort_resource
      FROM jsonb_array_elements(v_resources) AS value
     WHERE value->>'key' = 'mis_sort_exceptions'
     LIMIT 1;

    IF v_mis_sort_resource IS NOT NULL THEN
      v_canonical_resource := public.deep_merge_jsonb(
        v_mis_sort_resource - 'base_filter',
        jsonb_build_object(
          'key', 'wrong_zone_exceptions',
          'label', 'Wrong-zone exceptions',
          'description', 'Shipment basket assignments where the actual zone does not match the canonical basket-policy target zone.',
          'base_filter', v_base_filter,
          'filters', jsonb_build_array(
            jsonb_build_object('key', 'shipment_id', 'column', 'shipment_id', 'op', 'eq'),
            jsonb_build_object('key', 'basket_id', 'column', 'basket_id', 'op', 'eq'),
            jsonb_build_object('key', 'exception_reason', 'column', 'exception_reason', 'op', 'eq'),
            jsonb_build_object('key', 'actual_zone_id', 'column', 'actual_zone_id', 'op', 'eq'),
            jsonb_build_object('key', 'expected_zone_id', 'column', 'expected_zone_id', 'op', 'eq')
          ),
          'columns', jsonb_build_array(
            jsonb_build_object('key', 'shipment_id', 'label', 'Shipment', 'render_type', 'id', 'detail_section', 'Shipment'),
            jsonb_build_object('key', 'exception_reason', 'label', 'Exception reason', 'detail_section', 'Summary'),
            jsonb_build_object('key', 'actual_zone_id', 'label', 'Actual zone', 'render_type', 'id', 'detail_section', 'Actual assignment'),
            jsonb_build_object('key', 'expected_zone_id', 'label', 'Expected zone', 'render_type', 'id', 'detail_section', 'Expected assignment'),
            jsonb_build_object('key', 'actual_sort_branch_id', 'label', 'Actual branch', 'render_type', 'id', 'detail_section', 'Actual assignment'),
            jsonb_build_object('key', 'expected_sort_branch_id', 'label', 'Expected branch', 'render_type', 'id', 'detail_section', 'Expected assignment'),
            jsonb_build_object('key', 'detected_at', 'label', 'Detected at', 'detail_section', 'Summary')
          ),
          'column_labels', jsonb_build_object(
            'shipment_id', 'Shipment',
            'exception_reason', 'Exception reason',
            'actual_zone_id', 'Actual zone',
            'expected_zone_id', 'Expected zone',
            'actual_sort_branch_id', 'Actual branch',
            'expected_sort_branch_id', 'Expected branch',
            'detected_at', 'Detected at'
          )
        )
      );
    END IF;

    v_updated_resources := '[]'::jsonb;
    FOR v_resource IN
      SELECT value
      FROM jsonb_array_elements(v_resources) AS value
    LOOP
      v_resource_key := NULLIF(btrim(COALESCE(v_resource->>'key', '')), '');
      IF v_resource_key = 'wrong_zone_exceptions' THEN
        v_resource := public.deep_merge_jsonb(v_canonical_resource, v_resource);
      END IF;
      v_updated_resources := v_updated_resources || jsonb_build_array(v_resource);
    END LOOP;

    IF NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_updated_resources) AS item
      WHERE item->>'key' = 'wrong_zone_exceptions'
    ) THEN
      v_updated_resources := v_updated_resources || jsonb_build_array(v_canonical_resource);
    END IF;

    v_next := jsonb_set(v_current, '{resources}', v_updated_resources, TRUE);

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_row.version + 1,
             change_reason = 'Expose wrong_zone_exceptions through ui_read_registry.',
             approved_at = workflow_now(),
             effective_from = workflow_now()
       WHERE id = v_row.settings_version_id;

      UPDATE public.settings
         SET cached_value = v_next,
             last_updated = workflow_now()
       WHERE id = v_row.settings_id;
    END IF;
  END LOOP;
END;
$do$;

DO $do$
DECLARE
  v_row RECORD;
  v_current JSONB := NULL;
  v_next JSONB := NULL;
  v_commands JSONB := '[]'::jsonb;
  v_next_commands JSONB := '[]'::jsonb;
  v_command JSONB := NULL;
  v_command_key TEXT := NULL;
  v_mis_sort_command JSONB := NULL;
  v_canonical_command JSONB := jsonb_build_object(
    'key', 'wrong_zone_exceptions.resolve_reassign',
    'label', 'Reassign to expected zone',
    'description', 'Remove the shipment from the wrong-zone basket and reassign it using the current basket policy.',
    'capability', 'baskets.write',
    'schema_category', 'resource:wrong_zone_exceptions',
    'selection', jsonb_build_object('mode', 'single', 'min_count', 1, 'max_count', 1),
    'execution', jsonb_build_object(
      'type', 'rpc',
      'rpc', 'ui_execute_mis_sort_exception_resolve_v1',
      'confirm', jsonb_build_object(
        'title', 'Reassign wrong-zone shipment?',
        'description', 'This removes the shipment from the wrong-zone basket and reassigns it to the expected zone using the current basket policy.',
        'confirm_label', 'Reassign shipment',
        'cancel_label', 'Cancel',
        'tone', 'primary'
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
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    v_commands := COALESCE(v_current->'commands', '[]'::jsonb);
    IF jsonb_typeof(v_commands) IS DISTINCT FROM 'array' THEN
      v_commands := '[]'::jsonb;
    END IF;

    SELECT value
      INTO v_mis_sort_command
      FROM jsonb_array_elements(v_commands) AS value
     WHERE value->>'key' = 'mis_sort_exceptions.resolve_reassign'
     LIMIT 1;

    IF v_mis_sort_command IS NOT NULL THEN
      v_canonical_command := public.deep_merge_jsonb(
        v_mis_sort_command,
        jsonb_build_object(
          'key', 'wrong_zone_exceptions.resolve_reassign',
          'label', 'Reassign to expected zone',
          'description', 'Remove the shipment from the wrong-zone basket and reassign it using the current basket policy.',
          'schema_category', 'resource:wrong_zone_exceptions',
          'execution', jsonb_build_object(
            'type', 'rpc',
            'rpc', 'ui_execute_mis_sort_exception_resolve_v1',
            'confirm', jsonb_build_object(
              'title', 'Reassign wrong-zone shipment?',
              'description', 'This removes the shipment from the wrong-zone basket and reassigns it to the expected zone using the current basket policy.',
              'confirm_label', 'Reassign shipment',
              'cancel_label', 'Cancel',
              'tone', 'primary'
            )
          )
        )
      );
    END IF;

    v_next_commands := '[]'::jsonb;
    FOR v_command IN
      SELECT value
      FROM jsonb_array_elements(v_commands) AS value
    LOOP
      v_command_key := NULLIF(btrim(COALESCE(v_command->>'key', '')), '');
      IF v_command_key = 'wrong_zone_exceptions.resolve_reassign' THEN
        v_command := public.deep_merge_jsonb(v_canonical_command, v_command);
      END IF;
      v_next_commands := v_next_commands || jsonb_build_array(v_command);
    END LOOP;

    IF NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_next_commands) AS item
      WHERE item->>'key' = 'wrong_zone_exceptions.resolve_reassign'
    ) THEN
      v_next_commands := v_next_commands || jsonb_build_array(v_canonical_command);
    END IF;

    v_next := jsonb_set(v_current, '{commands}', v_next_commands, TRUE);

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_row.version + 1,
             change_reason = 'Expose wrong_zone_exceptions resolve command through ui_command_registry.',
             approved_at = workflow_now(),
             effective_from = workflow_now()
       WHERE id = v_row.settings_version_id;

      UPDATE public.settings
         SET cached_value = v_next,
             last_updated = workflow_now()
       WHERE id = v_row.settings_id;
    END IF;
  END LOOP;
END;
$do$;

DO $do$
DECLARE
  v_console_item JSONB := jsonb_build_object(
    'id', 'console-wrong-zone-exceptions',
    'label', 'Wrong-zone exceptions',
    'href', '/console/operations/exceptions/wrong_zone_exceptions',
    'resource', 'wrong_zone_exceptions',
    'capability', 'baskets.read'
  );
  v_portal_item JSONB := jsonb_build_object(
    'id', 'portal-wrong-zone-exceptions',
    'label', 'Wrong-zone exceptions',
    'href', '/portal/operations/exceptions/wrong_zone_exceptions',
    'resource', 'wrong_zone_exceptions',
    'capability', 'baskets.read'
  );
  v_row RECORD;
  v_current JSONB := NULL;
  v_next JSONB := NULL;
  v_app_key TEXT := NULL;
  v_sections JSONB := '[]'::jsonb;
  v_updated_sections JSONB := '[]'::jsonb;
  v_section JSONB := NULL;
  v_items JSONB := '[]'::jsonb;
BEGIN
  FOR v_row IN
    SELECT
      s.id AS settings_id,
      s.settings_version_id,
      sv.version,
      sv.value
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_navigation'
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    v_next := v_current;

    FOREACH v_app_key IN ARRAY ARRAY['console', 'portal']
    LOOP
      v_sections := COALESCE(v_next #> ARRAY['apps', v_app_key, 'sections'], '[]'::jsonb);
      IF jsonb_typeof(v_sections) IS DISTINCT FROM 'array' THEN
        CONTINUE;
      END IF;

      v_updated_sections := '[]'::jsonb;
      FOR v_section IN
        SELECT value
        FROM jsonb_array_elements(v_sections) AS value
      LOOP
        IF v_section->>'id' = 'operations' THEN
          v_items := COALESCE(v_section->'items', '[]'::jsonb);
          IF jsonb_typeof(v_items) IS DISTINCT FROM 'array' THEN
            v_items := '[]'::jsonb;
          END IF;

          v_items := (
            SELECT COALESCE(jsonb_agg(item), '[]'::jsonb)
            FROM jsonb_array_elements(v_items) AS item
            WHERE COALESCE(item->>'resource', '') <> 'wrong_zone_exceptions'
              AND COALESCE(item->>'id', '') <> CASE
                WHEN v_app_key = 'console' THEN 'console-wrong-zone-exceptions'
                ELSE 'portal-wrong-zone-exceptions'
              END
          );

          v_items := v_items || jsonb_build_array(
            CASE
              WHEN v_app_key = 'console' THEN v_console_item
              ELSE v_portal_item
            END
          );

          v_section := jsonb_set(v_section, '{items}', v_items, TRUE);
        END IF;

        v_updated_sections := v_updated_sections || jsonb_build_array(v_section);
      END LOOP;

      v_next := jsonb_set(v_next, ARRAY['apps', v_app_key, 'sections'], v_updated_sections, TRUE);
    END LOOP;

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_row.version + 1,
             change_reason = 'Expose wrong_zone_exceptions through ui_navigation.',
             approved_at = workflow_now(),
             effective_from = workflow_now()
       WHERE id = v_row.settings_version_id;

      UPDATE public.settings
         SET cached_value = v_next,
             last_updated = workflow_now()
       WHERE id = v_row.settings_id;
    END IF;
  END LOOP;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202604061130_b04_uc064_wrong_zone_exception_lane_v1'));
COMMIT;
