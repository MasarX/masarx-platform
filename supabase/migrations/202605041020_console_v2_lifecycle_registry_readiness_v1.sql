-- Plan: Console V2 lifecycle route readiness
-- Step: repair live lookup hydration and register remaining lifecycle resource
--       reads used by the full Console V2 route scan.
--
-- Console V2 live mode hydrates lookups through ui_list_resource_v1('lookup_values')
-- with a category filter. The base lookup_values table does not carry category,
-- so expose a read-only projection that joins lookup_definitions and register it
-- as the lookup_values resource. This same migration registers the route-level
-- resources already used by branches, zones, service catalog, shipments, and
-- route supervision modules.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605041020_console_v2_lifecycle_registry_readiness_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE VIEW public.lookup_values_console_v1
WITH (security_invoker = true) AS
SELECT
  lv.id,
  lv.lookup_definition_id,
  ld.category,
  lv.value,
  lv.label,
  lv.description,
  lv.sort_order,
  lv.is_default,
  lv.status,
  lv.effective_from,
  lv.effective_until,
  lv.metadata,
  lv.metadata->>'tone' AS tone,
  lv.created_at,
  lv.updated_at
FROM public.lookup_values lv
JOIN public.lookup_definitions ld
  ON ld.id = lv.lookup_definition_id;

REVOKE ALL ON public.lookup_values_console_v1 FROM PUBLIC;
REVOKE ALL ON public.lookup_values_console_v1 FROM anon;
GRANT SELECT ON public.lookup_values_console_v1 TO authenticated, service_role;

COMMENT ON VIEW public.lookup_values_console_v1 IS
  'Console V2 category-aware lookup value projection for live lookup hydration. Read-only; SSOT remains lookup_values + lookup_definitions.';

CREATE OR REPLACE VIEW public.zone_override_requests_console_v1
WITH (security_invoker = true) AS
SELECT
  z.id,
  z.organization_id,
  z.shipment_id,
  z.shipment_client_id,
  z.source_exception_id,
  z.current_zone_id,
  z.expected_zone_id,
  z.requested_zone_id,
  COALESCE(z.requested_zone_id, z.current_zone_id, z.expected_zone_id) AS zone_id,
  z.requested_by,
  z.requested_by AS requested_by_user_id,
  z.request_reason,
  COALESCE(z.metadata->>'change_kind', z.request_reason, 'manual_override') AS change_kind,
  z.status,
  z.workflow_run_id,
  z.manual_review_task_id,
  z.reviewed_by,
  z.reviewed_by AS decided_by_user_id,
  z.reviewed_at,
  z.reviewed_at AS decision_at,
  z.resolution_outcome,
  z.resolution_notes,
  z.applied_at,
  z.metadata,
  z.metadata AS payload,
  z.created_at,
  z.updated_at
FROM public.zone_override_requests z;

REVOKE ALL ON public.zone_override_requests_console_v1 FROM PUBLIC;
REVOKE ALL ON public.zone_override_requests_console_v1 FROM anon;
GRANT SELECT ON public.zone_override_requests_console_v1 TO authenticated, service_role;

COMMENT ON VIEW public.zone_override_requests_console_v1 IS
  'Console V2 FE-shaped projection over zone_override_requests. Read-only; SSOT remains public.zone_override_requests.';

DO $do$
DECLARE
  v_settings_version_id UUID;
  v_current JSONB;
  v_resource JSONB;
  v_resources JSONB := '[
    {"key":"lookup_values","relation":"public.lookup_values_console_v1","id_column":"id","capability_read":"lookups.read","capability_write":"lookups.write","default_sort":{"column":"sort_order","direction":"asc"},"filters":[{"key":"category","column":"category","op":"eq"},{"key":"status","column":"status","op":"eq"},{"key":"value","column":"value","op":"eq"},{"key":"label","column":"label","op":"ilike"}]},
    {"key":"branch_summary","relation":"public.v_branch_summary","id_column":"branch_id","capability_read":"branches.read","scope_columns":{"tenant":"organization_id"},"default_sort":{"column":"updated_at","direction":"desc"},"filters":[{"key":"branch_id","column":"branch_id","op":"eq"},{"key":"code","column":"code","op":"ilike"},{"key":"branch_type","column":"branch_type","op":"eq"},{"key":"is_active","column":"is_active","op":"eq"}]},
    {"key":"branch_memberships","relation":"public.branch_memberships","id_column":"id","capability_read":"branches.read","capability_write":"branches.write","default_sort":{"column":"created_at","direction":"desc"},"filters":[{"key":"branch_id","column":"branch_id","op":"eq"},{"key":"user_id","column":"user_id","op":"eq"},{"key":"is_active","column":"is_active","op":"eq"}]},
    {"key":"branch_capacity_heatmap","relation":"public.v_branch_capacity_heatmap","id_column":"id","capability_read":"branches.read","default_sort":{"column":"weekday","direction":"asc"},"filters":[{"key":"branch_id","column":"branch_id","op":"eq"},{"key":"zone_id","column":"zone_id","op":"eq"}]},
    {"key":"branch_coverage_windows","relation":"public.branch_coverage_windows","id_column":"id","capability_read":"branches.read","capability_write":"branches.write","default_sort":{"column":"effective_from","direction":"desc"},"filters":[{"key":"branch_id","column":"branch_id","op":"eq"},{"key":"zone_id","column":"zone_id","op":"eq"},{"key":"is_active","column":"is_active","op":"eq"}]},
    {"key":"route_runs","relation":"public.route_runs","id_column":"id","capability_read":"routes.read","capability_write":"routes.write","scope_columns":{"tenant":"organization_id"},"default_sort":{"column":"planned_date","direction":"desc"},"filters":[{"key":"status","column":"status","op":"eq"},{"key":"branch_id","column":"branch_id","op":"eq"},{"key":"driver_user_id","column":"driver_user_id","op":"eq"},{"key":"route_plan_id","column":"route_plan_id","op":"eq"}]},
    {"key":"zone_summary","relation":"public.v_zone_summary","id_column":"zone_id","capability_read":"zones.read","scope_columns":{"tenant":"organization_id"},"default_sort":{"column":"updated_at","direction":"desc"},"filters":[{"key":"zone_id","column":"zone_id","op":"eq"},{"key":"slug","column":"slug","op":"ilike"},{"key":"is_active","column":"is_active","op":"eq"}]},
    {"key":"zone_override_requests","relation":"public.zone_override_requests_console_v1","id_column":"id","capability_read":"zones.read","capability_write":"zones.write","scope_columns":{"tenant":"organization_id","client":"shipment_client_id"},"default_sort":{"column":"created_at","direction":"desc"},"filters":[{"key":"zone_id","column":"zone_id","op":"eq"},{"key":"status","column":"status","op":"eq"},{"key":"shipment_id","column":"shipment_id","op":"eq"}]},
    {"key":"service_levels","relation":"public.service_levels","id_column":"id","capability_read":"service_offerings.read","capability_write":"service_offerings.write","scope_columns":{"tenant":"organization_id"},"default_sort":{"column":"created_at","direction":"desc"},"filters":[{"key":"key","column":"key","op":"ilike"},{"key":"is_active","column":"is_active","op":"eq"}]},
    {"key":"service_offerings","relation":"public.service_offerings","id_column":"id","capability_read":"service_offerings.read","capability_write":"service_offerings.write","default_sort":{"column":"created_at","direction":"desc"},"filters":[{"key":"service_level_id","column":"service_level_id","op":"eq"},{"key":"branch_id","column":"branch_id","op":"eq"},{"key":"zone_id","column":"zone_id","op":"eq"},{"key":"is_active","column":"is_active","op":"eq"}]},
    {"key":"subscriptions","relation":"public.subscriptions","id_column":"id","capability_read":"billing.read","capability_write":"billing.write","scope_columns":{"tenant":"organization_id","client":"client_id","sender":"sender_id"},"default_sort":{"column":"created_at","direction":"desc"},"filters":[{"key":"status","column":"status","op":"eq"},{"key":"client_id","column":"client_id","op":"eq"},{"key":"sender_id","column":"sender_id","op":"eq"},{"key":"plan_key","column":"plan_key","op":"eq"}]},
    {"key":"shipment_directory","relation":"public.v_shipment_directory","id_column":"id","capability_read":"shipments.read","scope_columns":{"tenant":"organization_id","client":"client_id","sender":"sender_id"},"default_sort":{"column":"created_at","direction":"desc"},"filters":[{"key":"id","column":"id","op":"eq"},{"key":"tracking_number","column":"tracking_number","op":"ilike"},{"key":"client_reference_number","column":"client_reference_number","op":"ilike"},{"key":"carrier_reference_number","column":"carrier_reference_number","op":"ilike"},{"key":"status","column":"status","op":"eq"}]},
    {"key":"tenant_signup_request_summary","relation":"public.v_tenant_signup_request_summary","id_column":"id","capability_read":"tenant_signup_requests.read","default_sort":{"column":"created_at","direction":"desc"},"filters":[{"key":"status","column":"status","op":"eq"},{"key":"email","column":"email","op":"ilike"},{"key":"organization_name","column":"organization_name","op":"ilike"},{"key":"review_decision","column":"review_decision","op":"eq"}]}
  ]'::jsonb;
  v_filtered JSONB;
BEGIN
  SELECT s.settings_version_id, s.cached_value
    INTO v_settings_version_id, v_current
    FROM public.settings s
   WHERE s.category = 'ui_read_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_settings_version_id IS NULL THEN
    RAISE EXCEPTION 'ui_read_registry global settings missing';
  END IF;

  v_current := COALESCE(v_current, '{"resources":[]}'::jsonb);

  FOR v_resource IN
    SELECT value FROM jsonb_array_elements(v_resources) AS value
  LOOP
    SELECT COALESCE(jsonb_agg(value), '[]'::jsonb)
      INTO v_filtered
      FROM jsonb_array_elements(COALESCE(v_current->'resources', '[]'::jsonb)) AS value
     WHERE value->>'key' <> v_resource->>'key';

    v_current := jsonb_set(v_current, '{resources}', v_filtered || jsonb_build_array(v_resource), TRUE);
  END LOOP;

  UPDATE public.settings_versions
     SET value = v_current,
         updated_at = now()
   WHERE id = v_settings_version_id;

  UPDATE public.settings
     SET cached_value = v_current,
         last_updated = now()
   WHERE settings_version_id = v_settings_version_id;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202605041020_console_v2_lifecycle_registry_readiness_v1'));

COMMIT;
