-- Migration: FieldOps Mobile V2 cash-drop positive readback
-- Purpose:
--   Make the positive Cash Drop money workflow production-backed for Mobile V2:
--   a dedicated money-driver role can see Wallet/Cash Drop, the cash-drop
--   resolver derives expected COD from canonical route-stop payment truth, and
--   the resolver returns the latest submitted drop for same-screen readback.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605271330_fieldops_mobile_v2_cash_drop_positive_readback_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $lookup_seed$
DECLARE
  v_permission_definition_id UUID;
  v_user_type_definition_id UUID;
BEGIN
  SELECT id
    INTO v_permission_definition_id
    FROM public.lookup_definitions
   WHERE category = 'rbac_permission'
   LIMIT 1;

  IF v_permission_definition_id IS NULL THEN
    RAISE EXCEPTION 'rbac_permission lookup definition missing';
  END IF;

  INSERT INTO public.lookup_values (
    lookup_definition_id,
    value,
    label,
    description,
    sort_order,
    is_default,
    status,
    metadata
  )
  SELECT
    v_permission_definition_id,
    src.value,
    src.label,
    src.description,
    src.sort_order,
    FALSE,
    'active',
    jsonb_build_object(
      'resource', src.resource_key,
      'action', src.action_key,
      'source', 'fieldops_mobile_v2_cash_drop_positive_readback_v1'
    )
  FROM (VALUES
    ('wallet.read', 'Wallet Read', 'Read FieldOps Mobile V2 driver wallet balance and statement.', 9450, 'wallet', 'read'),
    ('cash_drop.write', 'Cash Drop Write', 'Submit and read back FieldOps Mobile V2 COD cash drops.', 9460, 'cash_drop', 'write')
  ) AS src(value, label, description, sort_order, resource_key, action_key)
  ON CONFLICT (lookup_definition_id, value) DO UPDATE
     SET label = EXCLUDED.label,
         description = EXCLUDED.description,
         status = 'active',
         metadata = COALESCE(public.lookup_values.metadata, '{}'::jsonb) || EXCLUDED.metadata,
         updated_at = now();

  SELECT id
    INTO v_user_type_definition_id
    FROM public.lookup_definitions
   WHERE category = 'user_type'
   LIMIT 1;

  IF v_user_type_definition_id IS NULL THEN
    RAISE EXCEPTION 'user_type lookup definition missing';
  END IF;

  INSERT INTO public.lookup_values (
    lookup_definition_id,
    value,
    label,
    description,
    sort_order,
    is_default,
    status,
    metadata
  )
  VALUES (
    v_user_type_definition_id,
    'fieldops_money_driver',
    'FieldOps Money Driver',
    'Driver persona allowed to execute Mobile V2 COD cash-drop and wallet money workflows.',
    8780,
    FALSE,
    'active',
    jsonb_build_object('source', 'fieldops_mobile_v2_cash_drop_positive_readback_v1')
  )
  ON CONFLICT (lookup_definition_id, value) DO UPDATE
     SET label = EXCLUDED.label,
         description = EXCLUDED.description,
         status = 'active',
         metadata = COALESCE(public.lookup_values.metadata, '{}'::jsonb) || EXCLUDED.metadata,
         updated_at = now();
END;
$lookup_seed$;

INSERT INTO public.rbac_role_templates (key, name, description, is_active, metadata)
VALUES (
  'fieldops_money_driver',
  'FieldOps Money Driver',
  'Driver task execution plus Mobile V2 COD cash-drop and wallet money workflows.',
  TRUE,
  jsonb_build_object(
    'seed', TRUE,
    'tier', 'fieldops',
    'source', 'fieldops_mobile_v2_cash_drop_positive_readback_v1'
  )
)
ON CONFLICT (key) DO UPDATE
SET name = EXCLUDED.name,
    description = EXCLUDED.description,
    is_active = TRUE,
    metadata = COALESCE(public.rbac_role_templates.metadata, '{}'::jsonb) || EXCLUDED.metadata,
    updated_at = now();

WITH permission_registry AS (
  SELECT lv.id, lv.value
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld
      ON ld.id = lv.lookup_definition_id
   WHERE ld.category = 'rbac_permission'
     AND lv.value IN (
       'tasks.read',
       'tasks.complete',
       'scan_events.write',
       'location_pings.write',
       'routes.read',
       'wallet.read',
       'cash_drop.write'
     )
),
template_perm_map AS (
  SELECT *
    FROM (VALUES
      ('fieldops_money_driver', 'tasks.read'),
      ('fieldops_money_driver', 'tasks.complete'),
      ('fieldops_money_driver', 'scan_events.write'),
      ('fieldops_money_driver', 'location_pings.write'),
      ('fieldops_money_driver', 'routes.read'),
      ('fieldops_money_driver', 'wallet.read'),
      ('fieldops_money_driver', 'cash_drop.write')
    ) AS v(template_key, permission_value)
)
INSERT INTO public.rbac_role_template_permissions (role_template_id, permission_id, metadata)
SELECT
  t.id,
  p.id,
  jsonb_build_object(
    'seed', TRUE,
    'template_key', t.key,
    'source', 'fieldops_mobile_v2_cash_drop_positive_readback_v1'
  )
FROM template_perm_map m
JOIN public.rbac_role_templates t
  ON t.key = m.template_key
JOIN permission_registry p
  ON p.value = m.permission_value
ON CONFLICT (role_template_id, permission_id) DO NOTHING;

DO $access_policy$
DECLARE
  v_row RECORD;
  v_current JSONB;
  v_next JSONB;
  v_caps JSONB;
  v_roles JSONB;
  v_role JSONB;
  v_role_keys JSONB;
  v_assignments JSONB;
  v_user_type_assignments JSONB;
  v_cap TEXT;
  v_role_idx INTEGER;
  v_found_role BOOLEAN;
  v_target_caps TEXT[] := ARRAY[
    'tasks.read',
    'tasks.complete',
    'scan_events.write',
    'location_pings.write',
    'routes.read',
    'wallet.read',
    'cash_drop.write'
  ];
BEGIN
  FOR v_row IN
    SELECT s.id AS settings_id,
           s.settings_version_id,
           sv.version,
           COALESCE(sv.value, s.cached_value, '{}'::jsonb) AS value
      FROM public.settings s
      JOIN public.settings_versions sv
        ON sv.id = s.settings_version_id
     WHERE s.category = 'access_control_policy'
       AND sv.approved_at IS NOT NULL
       AND sv.effective_until IS NULL
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    v_caps := COALESCE(v_current->'capabilities', '[]'::jsonb);
    IF jsonb_typeof(v_caps) IS DISTINCT FROM 'array' THEN
      v_caps := '[]'::jsonb;
    END IF;

    FOREACH v_cap IN ARRAY v_target_caps LOOP
      IF NOT (v_caps @> jsonb_build_array(jsonb_build_object('key', v_cap))) THEN
        v_caps := v_caps || jsonb_build_array(jsonb_build_object(
          'key', v_cap,
          'label', initcap(replace(replace(v_cap, '.', ' '), '_', ' ')),
          'category', split_part(v_cap, '.', 1)
        ));
      END IF;
    END LOOP;

    v_roles := COALESCE(v_current->'roles', '[]'::jsonb);
    IF jsonb_typeof(v_roles) IS DISTINCT FROM 'array' THEN
      v_roles := '[]'::jsonb;
    END IF;

    v_found_role := FALSE;
    FOR v_role_idx IN 0 .. GREATEST(jsonb_array_length(v_roles) - 1, -1) LOOP
      v_role := v_roles->v_role_idx;
      IF v_role->>'key' = 'fieldops_money_driver' THEN
        v_found_role := TRUE;
        v_role_keys := COALESCE(v_role->'capability_keys', '[]'::jsonb);
        IF jsonb_typeof(v_role_keys) IS DISTINCT FROM 'array' THEN
          v_role_keys := '[]'::jsonb;
        END IF;

        FOREACH v_cap IN ARRAY v_target_caps LOOP
          IF NOT (v_role_keys @> to_jsonb(v_cap)) THEN
            v_role_keys := v_role_keys || to_jsonb(v_cap);
          END IF;
        END LOOP;

        v_role := jsonb_set(v_role, '{label}', to_jsonb('FieldOps Money Driver'::text), TRUE);
        v_role := jsonb_set(v_role, '{capability_keys}', v_role_keys, TRUE);
        v_roles := jsonb_set(v_roles, ARRAY[v_role_idx::text], v_role, TRUE);
      END IF;
    END LOOP;

    IF NOT v_found_role THEN
      v_roles := v_roles || jsonb_build_array(jsonb_build_object(
        'key', 'fieldops_money_driver',
        'label', 'FieldOps Money Driver',
        'capability_keys', to_jsonb(v_target_caps)
      ));
    END IF;

    v_assignments := COALESCE(v_current->'assignments', '{}'::jsonb);
    IF jsonb_typeof(v_assignments) IS DISTINCT FROM 'object' THEN
      v_assignments := '{}'::jsonb;
    END IF;
    v_user_type_assignments := COALESCE(v_assignments->'user_type', '{}'::jsonb);
    IF jsonb_typeof(v_user_type_assignments) IS DISTINCT FROM 'object' THEN
      v_user_type_assignments := '{}'::jsonb;
    END IF;
    v_user_type_assignments := jsonb_set(
      v_user_type_assignments,
      '{fieldops_money_driver}',
      jsonb_build_array('fieldops_money_driver'),
      TRUE
    );
    v_assignments := jsonb_set(v_assignments, '{user_type}', v_user_type_assignments, TRUE);

    v_next := v_current;
    v_next := jsonb_set(v_next, '{capabilities}', v_caps, TRUE);
    v_next := jsonb_set(v_next, '{roles}', v_roles, TRUE);
    v_next := jsonb_set(v_next, '{assignments}', v_assignments, TRUE);

    UPDATE public.settings_versions
       SET value = v_next,
           version = v_row.version + 1,
           change_reason = 'FieldOps Mobile V2 cash drop: add money-driver access policy role',
           approved_at = now(),
           effective_from = now(),
           updated_at = now()
     WHERE id = v_row.settings_version_id
       AND v_next IS DISTINCT FROM v_current;

    UPDATE public.settings
       SET cached_value = v_next,
           last_updated = now()
     WHERE id = v_row.settings_id
       AND v_next IS DISTINCT FROM v_current;
  END LOOP;

  DELETE FROM public.settings_cache
   WHERE cache_key LIKE 'access_control_policy:%';
END;
$access_policy$;

DO $backfill_existing_tenants$
DECLARE
  v_org RECORD;
BEGIN
  FOR v_org IN
    SELECT o.id
      FROM public.organizations o
     WHERE COALESCE(o.slug, '') <> 'global-root'
  LOOP
    PERFORM public.provision_rbac_roles_from_templates_v1(
      v_org.id,
      ARRAY['fieldops_money_driver']::TEXT[],
      NULL
    );
  END LOOP;
END;
$backfill_existing_tenants$;

CREATE OR REPLACE FUNCTION public.resolve_fieldops_cash_drop_v1(
  p_active_role TEXT DEFAULT 'driver',
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org UUID;
  v_policy JSONB;
  v_safe TEXT;
  v_latest_drop JSONB := NULL;
  v_expected_sar INT := 0;
  v_requested_route_run_id UUID;
  v_route_run_id UUID;
  v_route_expected NUMERIC := 0;
  v_tz TEXT := 'Asia/Riyadh';
  v_loc JSONB;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'resolve_fieldops_cash_drop_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  v_org := public.current_user_org_id();
  IF v_org IS NULL THEN
    RETURN jsonb_build_object(
      'expected_sar', 0,
      'safe_location', '-',
      'latest_drop', NULL
    );
  END IF;

  BEGIN
    SELECT policy.value INTO v_policy
    FROM public.resolve_settings_row_from_policy_context_v1(
      'mobile_cash_policy',
      jsonb_build_object('organization_id', v_org)
    ) AS policy;
  EXCEPTION WHEN OTHERS THEN
    v_policy := '{}'::jsonb;
  END;

  v_safe := COALESCE(v_policy->>'safe_location', 'Hub safe');

  IF COALESCE(v_policy->>'default_expected_sar', '') ~ '^[0-9]+$' THEN
    v_expected_sar := (v_policy->>'default_expected_sar')::int;
  END IF;

  BEGIN
    SELECT public.resolve_settings('localization_policy', 'tenant', v_org)
      INTO v_loc;
    IF v_loc IS NULL THEN
      SELECT public.resolve_settings('localization_policy', 'global', NULL)
        INTO v_loc;
    END IF;
    IF v_loc IS NOT NULL AND v_loc ? 'timezone' THEN
      v_tz := COALESCE(NULLIF(v_loc->>'timezone', ''), v_tz);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  BEGIN
    v_requested_route_run_id := NULLIF(p_context->>'route_run_id', '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    v_requested_route_run_id := NULL;
  END;

  IF v_requested_route_run_id IS NOT NULL THEN
    SELECT rr.id
      INTO v_route_run_id
      FROM public.route_runs rr
     WHERE rr.id = v_requested_route_run_id
       AND rr.organization_id = v_org
       AND rr.driver_user_id = v_user_id
     LIMIT 1;
  END IF;

  IF v_route_run_id IS NULL THEN
    SELECT rr.id
      INTO v_route_run_id
      FROM public.route_runs rr
     WHERE rr.organization_id = v_org
       AND rr.driver_user_id = v_user_id
       AND (
         rr.status IN ('in_progress', 'completed', 'planned', 'active')
         OR rr.planned_date = (now() AT TIME ZONE v_tz)::date
         OR rr.created_at::date = (now() AT TIME ZONE v_tz)::date
       )
     ORDER BY
       CASE rr.status
         WHEN 'in_progress' THEN 0
         WHEN 'active' THEN 1
         WHEN 'planned' THEN 2
         WHEN 'completed' THEN 3
         ELSE 4
       END,
       rr.updated_at DESC,
       rr.created_at DESC
     LIMIT 1;
  END IF;

  IF v_route_run_id IS NOT NULL THEN
    WITH stop_base AS (
      SELECT
        CASE
          WHEN latest_action.payment_collected_amount IS NOT NULL THEN latest_action.payment_collected_amount
          WHEN COALESCE(latest_action.action_data #>> '{delivery_completion,payment_collection,collected_amount}', '') ~ '^-?[0-9]+(\.[0-9]+)?$'
            THEN (latest_action.action_data #>> '{delivery_completion,payment_collection,collected_amount}')::numeric
          WHEN COALESCE(latest_action.action_data #>> '{task_event_payload,delivery_completion,payment_collection,collected_amount}', '') ~ '^-?[0-9]+(\.[0-9]+)?$'
            THEN (latest_action.action_data #>> '{task_event_payload,delivery_completion,payment_collection,collected_amount}')::numeric
          ELSE 0
        END AS collected_amount
      FROM public.route_stops rs
      JOIN public.shipments s
        ON s.id = rs.shipment_id
       AND s.organization_id = rs.organization_id
       AND s.client_id = rs.client_id
      LEFT JOIN LATERAL (
        SELECT
          sa.payment_collected_amount,
          sa.action_data
        FROM public.shipment_actions sa
        WHERE sa.organization_id = rs.organization_id
          AND sa.client_id = rs.client_id
          AND sa.shipment_id = rs.shipment_id
          AND sa.action_data->>'route_stop_id' = rs.id::text
        ORDER BY sa.timestamp DESC, sa.created_at DESC, sa.id DESC
        LIMIT 1
      ) latest_action ON TRUE
      WHERE rs.organization_id = v_org
        AND rs.route_run_id = v_route_run_id
    )
    SELECT COALESCE(SUM(collected_amount), 0)
      INTO v_route_expected
      FROM stop_base;

    IF v_route_expected > 0 THEN
      v_expected_sar := round(v_route_expected)::int;
    END IF;
  END IF;

  SELECT jsonb_build_object(
           'decision_log_id', dl.id,
           'state', dl.decision_outcome,
           'expected_sar', CASE
             WHEN COALESCE(dl.decision_inputs->>'expected_sar', '') ~ '^-?[0-9]+(\.[0-9]+)?$'
               THEN round((dl.decision_inputs->>'expected_sar')::numeric)::int
             ELSE 0
           END,
           'actual_sar', CASE
             WHEN COALESCE(dl.decision_inputs->>'actual_sar', '') ~ '^-?[0-9]+(\.[0-9]+)?$'
               THEN round((dl.decision_inputs->>'actual_sar')::numeric)::int
             ELSE 0
           END,
           'variance_sar', CASE
             WHEN COALESCE(dl.decision_inputs->>'variance_sar', '') ~ '^-?[0-9]+(\.[0-9]+)?$'
               THEN round((dl.decision_inputs->>'variance_sar')::numeric)::int
             ELSE 0
           END,
           'supervisor_name', NULLIF(dl.decision_inputs->>'supervisor_name', ''),
           'submitted_at', dl.timestamp
         )
    INTO v_latest_drop
    FROM public.decision_log dl
   WHERE dl.organization_id = v_org
     AND dl.decision_category = 'fieldops_cash_drop'
     AND dl.performed_by_system = 'fieldops_mobile_v2'
     AND dl.decision_inputs->>'actor_user_id' = v_user_id::text
   ORDER BY dl.timestamp DESC, dl.id DESC
   LIMIT 1;

  RETURN jsonb_build_object(
    'expected_sar', v_expected_sar,
    'safe_location', v_safe,
    'latest_drop', v_latest_drop
  );
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_fieldops_cash_drop_v1(TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_fieldops_cash_drop_v1(TEXT, JSONB) TO authenticated, service_role;

COMMENT ON FUNCTION public.resolve_fieldops_cash_drop_v1(TEXT, JSONB) IS
  'Mobile V2 cash drop expected/readback envelope. Resolves expected SAR from canonical route-stop payment collection truth, falls back to mobile_cash_policy default_expected_sar, and returns latest same-driver drop from decision_log.';

CREATE OR REPLACE FUNCTION api.resolve_fieldops_cash_drop_v1(
  p_active_role TEXT DEFAULT 'driver',
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB LANGUAGE sql SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $$ SELECT public.resolve_fieldops_cash_drop_v1(p_active_role, p_context); $$;
REVOKE ALL ON FUNCTION api.resolve_fieldops_cash_drop_v1(TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.resolve_fieldops_cash_drop_v1(TEXT, JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202605271330_fieldops_mobile_v2_cash_drop_positive_readback_v1'));
COMMIT;
