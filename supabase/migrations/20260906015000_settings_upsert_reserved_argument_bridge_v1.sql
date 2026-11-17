-- Immutable 202609060200/202609060400 callers pass a reserved seventh NULL.
-- This dependency must precede those callers; 20260906045000 removes the bridge.
BEGIN;
SET LOCAL lock_timeout = '30s';
CREATE FUNCTION public.upsert_settings_value_v1(
  p_category TEXT,
  p_scope_type TEXT,
  p_scope_id UUID,
  p_value JSONB,
  p_schema_version INT,
  p_change_reason TEXT,
  p_reserved_null TEXT
)
RETURNS TABLE (
  settings_id UUID,
  settings_version_id UUID,
  settings_version_number INT
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $bridge$
BEGIN
  IF p_reserved_null IS NOT NULL THEN
    RAISE EXCEPTION 'settings_upsert_reserved_argument_must_be_null'
      USING ERRCODE = '22023';
  END IF;
  RETURN QUERY SELECT * FROM public.upsert_settings_value_v1(
    p_category, p_scope_type, p_scope_id, p_value, p_schema_version, p_change_reason
  );
END;
$bridge$;
REVOKE ALL ON FUNCTION public.upsert_settings_value_v1(TEXT,TEXT,UUID,JSONB,INT,TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_settings_value_v1(TEXT,TEXT,UUID,JSONB,INT,TEXT,TEXT) TO service_role;

-- Exercise both guards before the temporary overload leaves migration scope.
-- Invalid arguments reach validation only; neither check writes settings rows.
DO $contract$
BEGIN
  BEGIN
    PERFORM public.upsert_settings_value_v1(NULL::TEXT,NULL::TEXT,NULL::UUID,NULL::JSONB,1,NULL::TEXT,'not-null'::TEXT);
    RAISE EXCEPTION 'settings_upsert_bridge_reserved_argument_not_rejected';
  EXCEPTION WHEN invalid_parameter_value THEN
    IF SQLERRM <> 'settings_upsert_reserved_argument_must_be_null' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.upsert_settings_value_v1(NULL::TEXT,NULL::TEXT,NULL::UUID,NULL::JSONB,1,NULL::TEXT,NULL::TEXT);
    RAISE EXCEPTION 'settings_upsert_bridge_canonical_validation_not_reached';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'upsert_settings_value_v1 requires category' THEN RAISE; END IF;
  END;
END;
$contract$;
COMMENT ON FUNCTION public.upsert_settings_value_v1(TEXT,TEXT,UUID,JSONB,INT,TEXT,TEXT)
  IS 'Temporary immutable-migration compatibility only; reserved argument must be NULL; removed by 20260906045000.';
COMMIT;
