-- Plan: PLAN-202604-b08-delivery-completion-core / Step: E01
-- Migration: registry-driven lookup fallback access
-- Purpose:
-- - Keep list_lookup_values_v1 fail-closed without hardcoding a single lookup category.
-- - Allow authenticated task operators to read only the lookup categories exposed by
--   the canonical ui_command_registry commands they are already permitted to execute.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604031245_lookup_values_registry_capability_fallback_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.list_lookup_values_v1(
  p_category TEXT
)
RETURNS TABLE (
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
  v_category TEXT := lower(NULLIF(btrim(COALESCE(p_category, '')), ''));
  v_org UUID := public.current_user_org_id();
  v_has_lookup_read BOOLEAN := FALSE;
  v_has_registry_lookup_access BOOLEAN := FALSE;
BEGIN
  IF v_category IS NULL THEN
    RAISE EXCEPTION 'list_lookup_values_v1 requires category' USING ERRCODE = '23514';
  END IF;

  BEGIN
    v_has_lookup_read := public.user_has_resource_capability_v1('lookup_values', 'read');
  EXCEPTION
    WHEN others THEN
      v_has_lookup_read := FALSE;
  END;

  IF NOT v_has_lookup_read THEN
    IF v_org IS NOT NULL THEN
      SELECT EXISTS (
        SELECT 1
          FROM public.settings s,
               LATERAL jsonb_array_elements(COALESCE(s.cached_value->'commands', '[]'::jsonb)) AS cmd,
               LATERAL jsonb_array_elements(COALESCE(cmd->'execution'->'input_schema'->'fields', '[]'::jsonb)) AS field
         WHERE s.category = 'ui_command_registry'
           AND s.scope_type = 'global'
           AND s.scope_id IS NULL
           AND field->>'type' = 'lookup'
           AND lower(COALESCE(field->>'lookup_category', '')) = v_category
           AND public.user_has_permission_v1(
                 COALESCE(NULLIF(cmd->>'capability', ''), NULLIF(cmd->>'key', '')),
                 v_org
               )
      )
        INTO v_has_registry_lookup_access;
    END IF;

    IF NOT v_has_registry_lookup_access THEN
      RAISE EXCEPTION 'list_lookup_values_v1 category not allowed for current role' USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN QUERY
  SELECT
    lv.value,
    lv.label,
    lv.description,
    lv.sort_order,
    lv.is_default,
    COALESCE(lv.metadata, '{}'::jsonb) AS metadata
  FROM public.lookup_definitions ld
  JOIN public.lookup_values lv
    ON lv.lookup_definition_id = ld.id
  WHERE ld.category = v_category
    AND lv.status = 'active'
    AND (lv.effective_from IS NULL OR lv.effective_from <= now())
    AND (lv.effective_until IS NULL OR lv.effective_until > now())
  ORDER BY lv.sort_order NULLS LAST, lv.label, lv.value;
END;
$function$;

COMMENT ON FUNCTION public.list_lookup_values_v1(TEXT)
  IS 'List active lookup values for a category. Falls back to ui_command_registry capability-scoped lookup access when generic lookup read is absent.';

REVOKE ALL ON FUNCTION public.list_lookup_values_v1(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_lookup_values_v1(TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.list_lookup_values_v1(TEXT) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202604031245_lookup_values_registry_capability_fallback_v1'));
COMMIT;
