-- Canonical lookup catalog RPC for Console V2 live metadata hydration.
-- Startup hydration needs a complete category-aware catalog before synchronous
-- shells render, without falling back to the generic UI resource list.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605041120_lookup_values_catalog_rpc_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.list_lookup_values_catalog_v1(
  p_include_inactive BOOLEAN DEFAULT FALSE
)
RETURNS TABLE (
  category TEXT,
  value TEXT,
  label TEXT,
  description TEXT,
  sort_order INT,
  is_default BOOLEAN,
  metadata JSONB
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_has_lookup_read BOOLEAN := FALSE;
BEGIN
  BEGIN
    v_has_lookup_read := public.user_has_resource_capability_v1('lookup_values', 'read');
  EXCEPTION
    WHEN others THEN
      v_has_lookup_read := FALSE;
  END;

  IF NOT v_has_lookup_read THEN
    RAISE EXCEPTION 'list_lookup_values_catalog_v1 requires lookup_values read capability'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    ld.category,
    lv.value,
    lv.label,
    lv.description,
    lv.sort_order,
    lv.is_default,
    COALESCE(lv.metadata, '{}'::jsonb) AS metadata
  FROM public.lookup_definitions ld
  JOIN public.lookup_values lv
    ON lv.lookup_definition_id = ld.id
  WHERE (p_include_inactive IS TRUE OR lv.status = 'active')
    AND (p_include_inactive IS TRUE OR lv.effective_from IS NULL OR lv.effective_from <= now())
    AND (p_include_inactive IS TRUE OR lv.effective_until IS NULL OR lv.effective_until > now())
  ORDER BY ld.category, lv.sort_order NULLS LAST, lv.label, lv.value;
END;
$function$;

COMMENT ON FUNCTION public.list_lookup_values_catalog_v1(BOOLEAN) IS
  'Returns the category-aware active lookup catalog for Console V2 startup hydration. Capability gated by lookup_values.read.';

CREATE OR REPLACE FUNCTION api.list_lookup_values_catalog_v1(
  p_include_inactive BOOLEAN DEFAULT FALSE
)
RETURNS TABLE (
  category TEXT,
  value TEXT,
  label TEXT,
  description TEXT,
  sort_order INT,
  is_default BOOLEAN,
  metadata JSONB
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO api, public, extensions, pg_temp
AS $function$
  SELECT *
  FROM public.list_lookup_values_catalog_v1(p_include_inactive);
$function$;

REVOKE ALL ON FUNCTION public.list_lookup_values_catalog_v1(BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_lookup_values_catalog_v1(BOOLEAN) FROM anon;
GRANT EXECUTE ON FUNCTION public.list_lookup_values_catalog_v1(BOOLEAN) TO authenticated, service_role;

REVOKE ALL ON FUNCTION api.list_lookup_values_catalog_v1(BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.list_lookup_values_catalog_v1(BOOLEAN) FROM anon;
GRANT EXECUTE ON FUNCTION api.list_lookup_values_catalog_v1(BOOLEAN) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202605041120_lookup_values_catalog_rpc_v1'));

COMMIT;
