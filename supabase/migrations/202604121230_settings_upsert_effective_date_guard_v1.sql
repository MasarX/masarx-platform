BEGIN;

SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.upsert_settings_value_v1(
  p_category TEXT,
  p_scope_type TEXT,
  p_scope_id UUID,
  p_value JSONB,
  p_schema_version INT,
  p_change_reason TEXT
)
RETURNS TABLE (
  settings_id UUID,
  settings_version_id UUID,
  settings_version_number INT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_category TEXT := NULLIF(TRIM(p_category), '');
  v_scope_type TEXT;
  v_scope_id UUID := p_scope_id;
  v_value JSONB;
  v_entity_table REGCLASS;
  v_root TEXT := public.get_root_scope_type_key_v1();
  v_allowed_scopes JSONB;
  v_existing settings%ROWTYPE;
  v_next_version INT;
  v_sv_id UUID := gen_random_uuid();
BEGIN
  IF v_category IS NULL THEN
    RAISE EXCEPTION 'upsert_settings_value_v1 requires category';
  END IF;
  IF NULLIF(TRIM(p_scope_type), '') IS NULL THEN
    RAISE EXCEPTION 'upsert_settings_value_v1 requires scope_type';
  END IF;
  IF p_value IS NULL THEN
    RAISE EXCEPTION 'upsert_settings_value_v1 requires value';
  END IF;
  IF p_schema_version IS NULL OR p_schema_version < 1 THEN
    RAISE EXCEPTION 'upsert_settings_value_v1 requires schema_version >= 1';
  END IF;

  v_scope_type := public.normalize_scope_type_v1(p_scope_type, FALSE);
  v_value := public.normalize_settings_value_v1(v_category, p_value);

  SELECT r.entity_table
    INTO v_entity_table
    FROM public.scope_type_registry r
   WHERE r.scope_type = v_scope_type
     AND r.is_enabled = TRUE
   LIMIT 1;

  IF v_scope_type = v_root OR v_entity_table IS NULL THEN
    IF v_scope_id IS NOT NULL THEN
      RAISE EXCEPTION 'upsert_settings_value_v1 scope_type=% requires NULL scope_id', v_scope_type;
    END IF;
  ELSE
    IF v_scope_id IS NULL THEN
      RAISE EXCEPTION 'upsert_settings_value_v1 scope_type=% requires non-NULL scope_id', v_scope_type;
    END IF;
  END IF;

  SELECT scr.allowed_scopes
    INTO v_allowed_scopes
    FROM public.settings_category_registry scr
   WHERE scr.category = v_category
   LIMIT 1;

  IF v_allowed_scopes IS NOT NULL AND jsonb_typeof(v_allowed_scopes) = 'array' THEN
    IF NOT (v_allowed_scopes ? v_scope_type) THEN
      RAISE EXCEPTION 'Scope "%" is not allowed for category "%"', v_scope_type, v_category
        USING ERRCODE = '23514';
    END IF;
  END IF;

  UPDATE public.settings_versions
     SET effective_until = GREATEST(
           clock_timestamp(),
           effective_from + INTERVAL '1 microsecond'
         )
   WHERE category = v_category
     AND scope_type = v_scope_type
     AND (scope_id IS NOT DISTINCT FROM v_scope_id)
     AND effective_until IS NULL
     AND approved_at IS NOT NULL;

  SELECT COALESCE(MAX(version) + 1, 1)
    INTO v_next_version
    FROM public.settings_versions
   WHERE category = v_category
     AND scope_type = v_scope_type
     AND (scope_id IS NOT DISTINCT FROM v_scope_id);

  INSERT INTO public.settings_versions (
    id,
    category,
    scope_type,
    scope_id,
    version,
    value,
    schema_version,
    change_reason,
    approved_at,
    effective_from
  ) VALUES (
    v_sv_id,
    v_category,
    v_scope_type,
    v_scope_id,
    v_next_version,
    v_value,
    p_schema_version,
    COALESCE(NULLIF(TRIM(p_change_reason), ''), 'upsert via upsert_settings_value_v1'),
    clock_timestamp(),
    clock_timestamp()
  );

  SELECT *
    INTO v_existing
    FROM public.settings s
   WHERE s.category = v_category
     AND s.scope_type = v_scope_type
     AND (s.scope_id IS NOT DISTINCT FROM v_scope_id)
   LIMIT 1;

  IF v_existing.id IS NULL THEN
    settings_id := gen_random_uuid();
    INSERT INTO public.settings (
      id,
      category,
      scope_type,
      scope_id,
      settings_version_id,
      cached_value,
      last_updated
    ) VALUES (
      settings_id,
      v_category,
      v_scope_type,
      v_scope_id,
      v_sv_id,
      v_value,
      clock_timestamp()
    );
  ELSE
    settings_id := v_existing.id;
    UPDATE public.settings
       SET settings_version_id = v_sv_id,
           cached_value = v_value,
           last_updated = clock_timestamp()
     WHERE id = v_existing.id;
  END IF;

  settings_version_id := v_sv_id;
  settings_version_number := v_next_version;
  RETURN NEXT;
END;
$function$;

REVOKE ALL ON FUNCTION public.upsert_settings_value_v1(TEXT, TEXT, UUID, JSONB, INT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_settings_value_v1(TEXT, TEXT, UUID, JSONB, INT, TEXT) TO service_role;

COMMIT;
