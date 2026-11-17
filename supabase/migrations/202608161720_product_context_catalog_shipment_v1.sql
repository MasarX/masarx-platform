-- Current product contract: tenant service catalog and shipment product context.
-- Keeps service_levels/service_offerings canonical, exposes tenant-safe API
-- contracts, and derives shipment lineage during the existing workflow insert.

BEGIN;
SELECT pg_advisory_lock(hashtext('202608161720_product_context_catalog_shipment_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Canonical service-offering resolver and shipment write projection
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.resolve_service_offering_context_v1(
  p_organization_id UUID,
  p_service_offering_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_context JSONB;
BEGIN
  IF p_organization_id IS NULL OR p_service_offering_id IS NULL THEN
    RAISE EXCEPTION 'resolve_service_offering_context_v1 requires organization_id and service_offering_id'
      USING ERRCODE = '23502';
  END IF;

  SELECT jsonb_strip_nulls(jsonb_build_object(
           'service_offering_id', so.id,
           'service_level_id', sl.id,
           'service_level_key', sl.key,
           'service_level_name', sl.name,
           'service_offering_branch_id', so.branch_id,
           'service_offering_zone_id', so.zone_id,
           'service_offering_display_name', NULLIF(btrim(so.metadata#>>'{display,name}'), '')
         ))
    INTO v_context
    FROM public.service_offerings so
    JOIN public.service_levels sl
      ON sl.id = so.service_level_id
    JOIN public.branches branch
      ON branch.id = so.branch_id
    LEFT JOIN public.zones zone
      ON zone.id = so.zone_id
   WHERE so.id = p_service_offering_id
     AND sl.organization_id = p_organization_id
     AND branch.organization_id = p_organization_id
     AND (zone.id IS NULL OR zone.organization_id = p_organization_id)
     AND sl.is_active IS TRUE
     AND so.is_active IS TRUE
     AND public.workflow_now() >= so.effective_from
     AND (so.effective_to IS NULL OR public.workflow_now() < so.effective_to)
   LIMIT 1;

  IF v_context IS NULL THEN
    RAISE EXCEPTION 'service offering % is unavailable for organization %',
      p_service_offering_id,
      p_organization_id
      USING ERRCODE = '23503';
  END IF;

  RETURN v_context;
END;
$function$;

COMMENT ON FUNCTION public.resolve_service_offering_context_v1(UUID, UUID)
  IS 'Resolve an active, effective, organization-matched canonical service offering into shipment product context.';

REVOKE ALL ON FUNCTION public.resolve_service_offering_context_v1(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_service_offering_context_v1(UUID, UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.shipments_apply_service_offering_context_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_offering_text TEXT := NULLIF(btrim(COALESCE(NEW.metadata->>'service_offering_id', '')), '');
  v_offering_id UUID;
  v_context JSONB;
BEGIN
  IF v_offering_text IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.organization_id IS NOT DISTINCT FROM NEW.organization_id
     AND OLD.metadata->>'service_offering_id' IS NOT DISTINCT FROM NEW.metadata->>'service_offering_id' THEN
    RETURN NEW;
  END IF;

  BEGIN
    v_offering_id := v_offering_text::UUID;
  EXCEPTION
    WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'shipments.metadata.service_offering_id must be a uuid'
        USING ERRCODE = '22P02';
  END;

  v_context := public.resolve_service_offering_context_v1(NEW.organization_id, v_offering_id);

  NEW.service_level := v_context->>'service_level_key';
  NEW.branch_id := NULLIF(v_context->>'service_offering_branch_id', '')::UUID;
  NEW.zone_id := COALESCE(
    NULLIF(v_context->>'service_offering_zone_id', '')::UUID,
    NEW.zone_id
  );
  NEW.metadata := jsonb_strip_nulls(COALESCE(NEW.metadata, '{}'::jsonb) || v_context);
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_shipments_apply_service_offering_context_v1 ON public.shipments;
CREATE TRIGGER trg_shipments_apply_service_offering_context_v1
  BEFORE INSERT OR UPDATE OF organization_id, metadata ON public.shipments
  FOR EACH ROW
  EXECUTE FUNCTION public.shipments_apply_service_offering_context_v1();

COMMENT ON FUNCTION public.shipments_apply_service_offering_context_v1()
  IS 'Validate metadata.service_offering_id and project canonical level/branch/zone lineage on the shipment workflow write.';

-------------------------------------------------------------------------------
-- 2) Tenant-safe canonical catalog create RPCs
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.service_level_create_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_is_service BOOLEAN := public.request_role_is_service_v1();
  v_request_org UUID := public.current_user_org_id();
  v_target_org UUID;
  v_key TEXT;
  v_name TEXT;
  v_description TEXT;
  v_metadata JSONB;
  v_resource_id UUID;
  v_correlation_id UUID := gen_random_uuid();
BEGIN
  IF jsonb_typeof(COALESCE(p_args, '{}'::jsonb)) <> 'object' THEN
    RAISE EXCEPTION 'service_level_create_v1 requires an object payload' USING ERRCODE = '22023';
  END IF;
  IF NOT v_is_service AND auth.uid() IS NULL THEN
    RAISE EXCEPTION 'service_level_create_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('agreements.write');

  v_target_org := NULLIF(p_args->>'organization_id', '')::UUID;
  IF v_target_org IS NULL THEN
    v_target_org := v_request_org;
  ELSIF NOT v_is_service
        AND NOT public.is_platform_user()
        AND v_target_org IS DISTINCT FROM v_request_org THEN
    RAISE EXCEPTION 'service_level_create_v1 organization_id outside tenant scope' USING ERRCODE = '42501';
  END IF;
  IF v_target_org IS NULL THEN
    RAISE EXCEPTION 'service_level_create_v1 cannot resolve target organization' USING ERRCODE = '23502';
  END IF;
  PERFORM 1 FROM public.organizations WHERE id = v_target_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'service_level_create_v1 organization % not found', v_target_org USING ERRCODE = '23503';
  END IF;

  v_key := lower(NULLIF(btrim(COALESCE(p_args->>'key', '')), ''));
  v_name := NULLIF(btrim(COALESCE(p_args->>'name', '')), '');
  v_description := NULLIF(btrim(COALESCE(p_args->>'description', '')), '');
  IF v_key IS NULL OR v_name IS NULL THEN
    RAISE EXCEPTION 'service_level_create_v1 requires key and name' USING ERRCODE = '23502';
  END IF;

  v_metadata := COALESCE(p_args->'metadata', '{}'::jsonb);
  IF jsonb_typeof(v_metadata) <> 'object' THEN
    RAISE EXCEPTION 'service_level_create_v1 metadata must be an object' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.service_levels (
    organization_id, key, name, description, is_active, metadata
  ) VALUES (
    v_target_org, v_key, v_name, v_description, COALESCE((p_args->>'is_active')::BOOLEAN, TRUE), v_metadata
  )
  RETURNING id INTO v_resource_id;

  PERFORM public.log_decision(
    p_organization_id := v_target_org,
    p_decision_category := 'service_catalog',
    p_resource_type := 'service_level',
    p_resource_id := v_resource_id,
    p_decision_point := 'service_level_create_v1',
    p_decision_outcome := 'created',
    p_performed_by_system := 'public.service_level_create_v1',
    p_correlation_id := v_correlation_id,
    p_decision_inputs := jsonb_build_object('key', v_key, 'name', v_name),
    p_decision_reason := 'Canonical tenant service level created',
    p_settings_resolution_id := NULL
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'service_level_id', v_resource_id,
    'organization_id', v_target_org,
    'correlation_id', v_correlation_id
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.service_offering_create_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_is_service BOOLEAN := public.request_role_is_service_v1();
  v_request_org UUID := public.current_user_org_id();
  v_target_org UUID;
  v_service_level_id UUID := NULLIF(p_args->>'service_level_id', '')::UUID;
  v_branch_id UUID := NULLIF(p_args->>'branch_id', '')::UUID;
  v_zone_id UUID := NULLIF(p_args->>'zone_id', '')::UUID;
  v_effective_from TIMESTAMPTZ := COALESCE(NULLIF(p_args->>'effective_from', '')::TIMESTAMPTZ, public.workflow_now());
  v_effective_to TIMESTAMPTZ := NULLIF(p_args->>'effective_to', '')::TIMESTAMPTZ;
  v_priority INTEGER := COALESCE((p_args->>'priority')::INTEGER, 0);
  v_metadata JSONB;
  v_resource_id UUID;
  v_correlation_id UUID := gen_random_uuid();
BEGIN
  IF jsonb_typeof(COALESCE(p_args, '{}'::jsonb)) <> 'object' THEN
    RAISE EXCEPTION 'service_offering_create_v1 requires an object payload' USING ERRCODE = '22023';
  END IF;
  IF NOT v_is_service AND auth.uid() IS NULL THEN
    RAISE EXCEPTION 'service_offering_create_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('agreements.write');

  v_target_org := NULLIF(p_args->>'organization_id', '')::UUID;
  IF v_target_org IS NULL THEN
    v_target_org := v_request_org;
  ELSIF NOT v_is_service
        AND NOT public.is_platform_user()
        AND v_target_org IS DISTINCT FROM v_request_org THEN
    RAISE EXCEPTION 'service_offering_create_v1 organization_id outside tenant scope' USING ERRCODE = '42501';
  END IF;
  IF v_target_org IS NULL THEN
    RAISE EXCEPTION 'service_offering_create_v1 cannot resolve target organization' USING ERRCODE = '23502';
  END IF;
  IF v_service_level_id IS NULL OR v_branch_id IS NULL THEN
    RAISE EXCEPTION 'service_offering_create_v1 requires service_level_id and branch_id' USING ERRCODE = '23502';
  END IF;
  IF v_priority < 0 THEN
    RAISE EXCEPTION 'service_offering_create_v1 priority must be non-negative' USING ERRCODE = '23514';
  END IF;
  IF v_effective_to IS NOT NULL AND v_effective_to <= v_effective_from THEN
    RAISE EXCEPTION 'service_offering_create_v1 effective_to must follow effective_from' USING ERRCODE = '23514';
  END IF;

  PERFORM 1
    FROM public.service_levels sl
   WHERE sl.id = v_service_level_id
     AND sl.organization_id = v_target_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'service_offering_create_v1 service level outside tenant scope' USING ERRCODE = '42501';
  END IF;

  PERFORM 1
    FROM public.branches branch
   WHERE branch.id = v_branch_id
     AND branch.organization_id = v_target_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'service_offering_create_v1 branch outside tenant scope' USING ERRCODE = '42501';
  END IF;

  IF v_zone_id IS NOT NULL THEN
    PERFORM 1
      FROM public.zones zone
     WHERE zone.id = v_zone_id
       AND zone.organization_id = v_target_org;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'service_offering_create_v1 zone outside tenant scope' USING ERRCODE = '42501';
    END IF;
  END IF;

  v_metadata := COALESCE(p_args->'metadata', '{}'::jsonb);
  IF jsonb_typeof(v_metadata) <> 'object' THEN
    RAISE EXCEPTION 'service_offering_create_v1 metadata must be an object' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.service_offerings (
    service_level_id, branch_id, zone_id, effective_from, effective_to,
    priority, is_active, metadata
  ) VALUES (
    v_service_level_id, v_branch_id, v_zone_id, v_effective_from, v_effective_to,
    v_priority, COALESCE((p_args->>'is_active')::BOOLEAN, TRUE), v_metadata
  )
  RETURNING id INTO v_resource_id;

  PERFORM public.log_decision(
    p_organization_id := v_target_org,
    p_decision_category := 'service_catalog',
    p_resource_type := 'service_offering',
    p_resource_id := v_resource_id,
    p_decision_point := 'service_offering_create_v1',
    p_decision_outcome := 'created',
    p_performed_by_system := 'public.service_offering_create_v1',
    p_correlation_id := v_correlation_id,
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'service_level_id', v_service_level_id,
      'branch_id', v_branch_id,
      'zone_id', v_zone_id,
      'effective_from', v_effective_from,
      'effective_to', v_effective_to,
      'priority', v_priority
    )),
    p_decision_reason := 'Canonical tenant service offering created',
    p_settings_resolution_id := NULL
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'service_offering_id', v_resource_id,
    'organization_id', v_target_org,
    'correlation_id', v_correlation_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.service_level_create_v1(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.service_offering_create_v1(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.service_level_create_v1(JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.service_offering_create_v1(JSONB) TO authenticated, service_role;

COMMENT ON FUNCTION public.service_level_create_v1(JSONB)
  IS 'Tenant-safe canonical service-level create contract gated by agreements.write.';
COMMENT ON FUNCTION public.service_offering_create_v1(JSONB)
  IS 'Tenant-safe canonical service-offering create contract gated by agreements.write and organization-matched catalog lineage.';

-------------------------------------------------------------------------------
-- 3) Security-invoker directory projections and api wrappers
-------------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.service_level_directory
  WITH (security_invoker = true)
AS
SELECT
  sl.id,
  sl.organization_id,
  sl.key,
  sl.name,
  sl.description,
  sl.is_active,
  sl.metadata,
  sl.created_at,
  sl.updated_at,
  COUNT(so.id) AS offering_count,
  COUNT(so.id) FILTER (
    WHERE so.is_active IS TRUE
      AND public.workflow_now() >= so.effective_from
      AND (so.effective_to IS NULL OR public.workflow_now() < so.effective_to)
  ) AS available_offering_count
FROM public.service_levels sl
LEFT JOIN public.service_offerings so ON so.service_level_id = sl.id
GROUP BY sl.id;

CREATE OR REPLACE VIEW public.service_offering_directory
  WITH (security_invoker = true)
AS
SELECT
  so.id,
  sl.organization_id,
  so.service_level_id,
  sl.key AS service_level_key,
  sl.name AS service_level_name,
  so.branch_id,
  branch.name AS branch_name,
  so.zone_id,
  zone.name AS zone_name,
  so.effective_from,
  so.effective_to,
  so.priority,
  so.is_active,
  so.metadata,
  COALESCE(
    NULLIF(btrim(so.metadata#>>'{display,name}'), ''),
    concat_ws(' - ', sl.name, branch.name, zone.name)
  ) AS display_name,
  (
    sl.is_active IS TRUE
    AND so.is_active IS TRUE
    AND public.workflow_now() >= so.effective_from
    AND (so.effective_to IS NULL OR public.workflow_now() < so.effective_to)
  ) AS is_available,
  so.created_at,
  so.updated_at
FROM public.service_offerings so
JOIN public.service_levels sl ON sl.id = so.service_level_id
JOIN public.branches branch ON branch.id = so.branch_id
LEFT JOIN public.zones zone ON zone.id = so.zone_id;

REVOKE ALL ON public.service_level_directory FROM PUBLIC, anon;
REVOKE ALL ON public.service_offering_directory FROM PUBLIC, anon;
GRANT SELECT ON public.service_level_directory TO authenticated, service_role;
GRANT SELECT ON public.service_offering_directory TO authenticated, service_role;

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;
GRANT USAGE ON SCHEMA api TO authenticated, service_role;

CREATE OR REPLACE VIEW api.service_level_directory
  WITH (security_invoker = true)
AS SELECT * FROM public.service_level_directory;

CREATE OR REPLACE VIEW api.service_offering_directory
  WITH (security_invoker = true)
AS SELECT * FROM public.service_offering_directory;

REVOKE ALL ON api.service_level_directory FROM PUBLIC, anon;
REVOKE ALL ON api.service_offering_directory FROM PUBLIC, anon;
GRANT SELECT ON api.service_level_directory TO authenticated, service_role;
GRANT SELECT ON api.service_offering_directory TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.service_level_create_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.service_level_create_v1(p_args);
$function$;

CREATE OR REPLACE FUNCTION api.service_offering_create_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.service_offering_create_v1(p_args);
$function$;

REVOKE ALL ON FUNCTION api.service_level_create_v1(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION api.service_offering_create_v1(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.service_level_create_v1(JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.service_offering_create_v1(JSONB) TO authenticated, service_role;

-------------------------------------------------------------------------------
-- 4) Registry and current Console navigation integration
-------------------------------------------------------------------------------

DO $do$
DECLARE
  v_current JSONB;
  v_resources JSONB;
  v_item JSONB;
  v_updated JSONB := '[]'::jsonb;
  v_resource JSONB;
  v_target_key TEXT;
  v_targets JSONB := jsonb_build_array(
    jsonb_build_object(
      'key', 'service_level_directory',
      'label', 'Service levels',
      'relation', 'api.service_level_directory',
      'allow_view_relation', TRUE,
      'id_column', 'id',
      'capability_read', 'agreements.read',
      'capability_write', 'agreements.write',
      'select', jsonb_build_array(
        'id', 'organization_id', 'key', 'name', 'description', 'is_active',
        'metadata', 'offering_count', 'available_offering_count', 'created_at', 'updated_at'
      ),
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'key', 'column', 'key', 'op', 'ilike'),
        jsonb_build_object('key', 'name', 'column', 'name', 'op', 'ilike'),
        jsonb_build_object('key', 'is_active', 'column', 'is_active', 'op', 'eq')
      ),
      'default_sort', jsonb_build_object('column', 'name', 'direction', 'asc')
    ),
    jsonb_build_object(
      'key', 'service_offering_directory',
      'label', 'Service offerings',
      'relation', 'api.service_offering_directory',
      'allow_view_relation', TRUE,
      'id_column', 'id',
      'capability_read', 'agreements.read',
      'capability_write', 'agreements.write',
      'select', jsonb_build_array(
        'id', 'organization_id', 'service_level_id', 'service_level_key',
        'service_level_name', 'branch_id', 'branch_name', 'zone_id', 'zone_name',
        'display_name', 'effective_from', 'effective_to', 'priority', 'is_active',
        'is_available', 'metadata', 'created_at', 'updated_at'
      ),
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'service_level_id', 'column', 'service_level_id', 'op', 'eq'),
        jsonb_build_object('key', 'branch_id', 'column', 'branch_id', 'op', 'eq'),
        jsonb_build_object('key', 'zone_id', 'column', 'zone_id', 'op', 'eq'),
        jsonb_build_object('key', 'display_name', 'column', 'display_name', 'op', 'ilike'),
        jsonb_build_object('key', 'is_available', 'column', 'is_available', 'op', 'eq')
      ),
      'default_sort', jsonb_build_object('column', 'priority', 'direction', 'desc')
    )
  );
BEGIN
  SELECT sv.value
    INTO v_current
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'ui_read_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'ui_read_registry global settings missing';
  END IF;

  v_resources := COALESCE(v_current->'resources', '[]'::jsonb);
  FOR v_item IN SELECT value FROM jsonb_array_elements(v_resources) LOOP
    v_target_key := v_item->>'key';
    SELECT value INTO v_resource
      FROM jsonb_array_elements(v_targets)
     WHERE value->>'key' = v_target_key
     LIMIT 1;
    v_updated := v_updated || jsonb_build_array(COALESCE(v_resource, v_item));
    v_resource := NULL;
  END LOOP;

  FOR v_resource IN SELECT value FROM jsonb_array_elements(v_targets) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_updated) item
       WHERE item->>'key' = v_resource->>'key'
    ) THEN
      v_updated := v_updated || jsonb_build_array(v_resource);
    END IF;
  END LOOP;

  v_current := jsonb_set(v_current, '{resources}', v_updated, TRUE);

  WITH current AS (
    SELECT s.settings_version_id, sv.version, sv.value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
     LIMIT 1
  ), applied AS (
    UPDATE public.settings_versions sv
       SET value = v_current,
           version = current.version + 1,
           change_reason = 'Register canonical tenant service catalog directories',
           approved_at = now(),
           effective_from = now()
      FROM current
     WHERE sv.id = current.settings_version_id
       AND v_current IS DISTINCT FROM current.value
    RETURNING sv.id, sv.value
  )
  UPDATE public.settings s
     SET cached_value = applied.value,
         last_updated = now()
    FROM applied
   WHERE s.category = 'ui_read_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
     AND s.settings_version_id = applied.id;
END;
$do$;

DO $do$
DECLARE
  v_current JSONB;
  v_sections JSONB := '[]'::jsonb;
  v_section JSONB;
  v_items JSONB;
  v_found BOOLEAN := FALSE;
  v_item JSONB := jsonb_build_object(
    'id', 'console-service-catalog',
    'label', 'Service catalog',
    'href', '/console/catalog/service-offerings',
    'resource', 'service_offering_directory',
    'capability', 'agreements.read'
  );
BEGIN
  SELECT sv.value
    INTO v_current
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'ui_navigation'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'ui_navigation global settings missing';
  END IF;

  FOR v_section IN
    SELECT value FROM jsonb_array_elements(COALESCE(v_current#>'{apps,console,sections}', '[]'::jsonb))
  LOOP
    IF v_section->>'id' = 'configuration' THEN
      v_found := TRUE;
      v_items := COALESCE(v_section->'items', '[]'::jsonb);
      IF NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_items) item
         WHERE item->>'id' = 'console-service-catalog'
      ) THEN
        v_items := v_items || jsonb_build_array(v_item);
      END IF;
      v_section := jsonb_set(v_section, '{items}', v_items, TRUE);
    END IF;
    v_sections := v_sections || jsonb_build_array(v_section);
  END LOOP;

  IF NOT v_found THEN
    v_sections := v_sections || jsonb_build_array(
      jsonb_build_object(
        'id', 'configuration',
        'label', 'Configuration',
        'items', jsonb_build_array(v_item)
      )
    );
  END IF;

  v_current := jsonb_set(v_current, '{apps,console,sections}', v_sections, TRUE);

  WITH current AS (
    SELECT s.settings_version_id, sv.version, sv.value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_navigation'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
     LIMIT 1
  ), applied AS (
    UPDATE public.settings_versions sv
       SET value = v_current,
           version = current.version + 1,
           change_reason = 'Add canonical service catalog to current Console navigation',
           approved_at = now(),
           effective_from = now()
      FROM current
     WHERE sv.id = current.settings_version_id
       AND v_current IS DISTINCT FROM current.value
    RETURNING sv.id, sv.value
  )
  UPDATE public.settings s
     SET cached_value = applied.value,
         last_updated = now()
    FROM applied
   WHERE s.category = 'ui_navigation'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
     AND s.settings_version_id = applied.id;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202608161720_product_context_catalog_shipment_v1'));
COMMIT;
