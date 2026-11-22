BEGIN;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.route_assignment_policy_default_v1()
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT jsonb_build_object(
    'version', 1,
    'alternate_capacity', jsonb_build_object(
      'enabled', false,
      'source_type', 'marketplace_private_pool',
      'selection_mode', 'first_private_pool_member',
      'allowed_demand_classes', jsonb_build_array('express', 'overflow'),
      'allowed_request_kind_keys', jsonb_build_array('capacity_block'),
      'route_metadata_demand_class_paths', jsonb_build_array(
        '$.alternate_capacity.demand_class',
        '$.assignment_request.demand_class',
        '$.dispatch.assignment_request.demand_class'
      ),
      'shipment_metadata_demand_class_paths', jsonb_build_array(
        '$.alternate_capacity.demand_class',
        '$.assignment_request.demand_class',
        '$.dispatch.assignment_request.demand_class'
      ),
      'route_metadata_marketplace_request_id_paths', jsonb_build_array(
        '$.alternate_capacity.marketplace_request_id',
        '$.assignment_request.marketplace_request_id',
        '$.dispatch.assignment_request.marketplace_request_id'
      ),
      'shipment_metadata_marketplace_request_id_paths', jsonb_build_array(
        '$.alternate_capacity.marketplace_request_id',
        '$.assignment_request.marketplace_request_id',
        '$.dispatch.assignment_request.marketplace_request_id'
      )
    )
  );
$function$;

CREATE OR REPLACE FUNCTION public.route_assignment_policy_resolve_v1(
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  settings_resolution_id UUID,
  settings_id UUID,
  settings_version_id UUID,
  scope_type TEXT,
  scope_id UUID,
  value JSONB,
  version INT,
  scope_path JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_context JSONB := COALESCE(p_context, '{}'::jsonb);
  v_policy_row RECORD;
  v_org_id UUID := NULL;
BEGIN
  BEGIN
    v_org_id := NULLIF(v_context->>'organization_id', '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_org_id := NULL;
  END;

  SELECT *
    INTO v_policy_row
    FROM public.resolve_settings_row_from_policy_context_v1(
      'route_assignment_policy',
      v_context
    )
   LIMIT 1;

  value := public.jsonb_deep_merge(
    public.route_assignment_policy_default_v1(),
    COALESCE(v_policy_row.value, '{}'::jsonb)
  );
  -- Only a winning scoped setting can opt in to automatic supplier selection.
  IF jsonb_typeof(value->'alternate_capacity') = 'object'
     AND NOT COALESCE(
       v_policy_row.scope_type IN ('tenant', 'client', 'sender', 'resource')
       AND v_policy_row.scope_id IS NOT NULL
       AND v_policy_row.value#>'{alternate_capacity,enabled}' = 'true'::jsonb,
       FALSE
     ) THEN
    value := jsonb_set(value, '{alternate_capacity,enabled}', 'false'::jsonb);
  END IF;

  settings_id := v_policy_row.settings_id;
  settings_version_id := v_policy_row.settings_version_id;
  scope_type := COALESCE(v_policy_row.scope_type, 'global');
  scope_id := v_policy_row.scope_id;
  version := COALESCE(v_policy_row.version, 1);
  scope_path := COALESCE(
    v_policy_row.scope_path,
    jsonb_build_array(jsonb_build_object('scope_type', 'global', 'scope_id', NULL))
  );

  settings_resolution_id := public.log_settings_resolution(
    p_organization_id := v_org_id,
    p_category := 'route_assignment_policy',
    p_winning_scope_type := scope_type,
    p_winning_scope_id := scope_id,
    p_winning_settings_id := settings_id,
    p_winning_settings_version_id := settings_version_id,
    p_winning_version := version,
    p_scope_path := scope_path,
    p_inputs := v_context,
    p_merge_notes := jsonb_build_object('resolver', 'route_assignment_policy_resolve_v1')
  );

  RETURN NEXT;
END;
$function$;

UPDATE public.schema_registry
   SET examples = jsonb_build_array(public.route_assignment_policy_default_v1())
 WHERE category = 'route_assignment_policy' AND version = 1;

DO $migration$
DECLARE
  v_global_value jsonb;
  v_schema_version integer;
BEGIN
  SELECT s.cached_value, sv.schema_version
    INTO v_global_value, v_schema_version
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'route_assignment_policy'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL;

  IF jsonb_typeof(v_global_value->'alternate_capacity') = 'object'
     AND v_global_value#>'{alternate_capacity,enabled}' IS DISTINCT FROM 'false'::jsonb THEN
    PERFORM public.upsert_settings_value_v1(
      'route_assignment_policy', 'global', NULL,
      jsonb_set(v_global_value, '{alternate_capacity,enabled}', 'false'::jsonb),
      v_schema_version, 'Require scoped opt-in for automatic alternate capacity'
    );
  END IF;
END;
$migration$;

COMMIT;
