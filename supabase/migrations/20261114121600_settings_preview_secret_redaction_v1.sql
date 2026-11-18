-- Preview is a scoped presence projection, never an executable settings baseline.
BEGIN;
SET LOCAL lock_timeout = '10s';

CREATE FUNCTION public.settings_preview_redact_v1(p_value JSONB, p_key TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $redact$
DECLARE
  result JSONB;
BEGIN
  IF p_value IS NULL OR p_value IN ('null'::jsonb, '""'::jsonb) THEN RETURN p_value; END IF;
  IF public.plugin_studio_sensitive_key_v1(p_key)
     OR (jsonb_typeof(p_value) = 'object' AND p_value->>'type' = 'SecretRef') THEN
    RETURN to_jsonb('REDACTED'::text);
  END IF;
  IF jsonb_typeof(p_value) = 'object' THEN
    SELECT COALESCE(jsonb_object_agg(key, public.settings_preview_redact_v1(value, key)), '{}'::jsonb)
      INTO result FROM jsonb_each(p_value);
    RETURN result;
  ELSIF jsonb_typeof(p_value) = 'array' THEN
    SELECT COALESCE(jsonb_agg(public.settings_preview_redact_v1(value) ORDER BY n), '[]'::jsonb)
      INTO result FROM jsonb_array_elements(p_value) WITH ORDINALITY a(value, n);
    RETURN result;
  ELSIF jsonb_typeof(p_value) = 'string'
        AND public.plugin_studio_redact_json_v1(p_value) IS DISTINCT FROM p_value THEN
    RETURN to_jsonb('REDACTED'::text);
  END IF;
  RETURN p_value;
END;
$redact$;
REVOKE ALL ON FUNCTION public.settings_preview_redact_v1(JSONB,TEXT) FROM PUBLIC, anon, authenticated;

DO $preview_guard$
DECLARE
  definition TEXT;
  prior TEXT;
BEGIN
  definition := pg_get_functiondef('public.ui_settings_preview_v1(text,text,uuid)'::regprocedure);
  prior := '''value'', v_value';
  IF (length(definition) - length(replace(definition, prior, ''))) / length(prior) <> 1 THEN
    RAISE EXCEPTION 'Expected one settings preview value projection';
  END IF;
  EXECUTE replace(definition, prior, '''value'', public.settings_preview_redact_v1(v_value)');

  -- Reject round-trip placeholders after authorization, before any request write.
  definition := pg_get_functiondef('public.request_settings_change_v1(text,text,uuid,jsonb,text,timestamptz)'::regprocedure);
  prior := '  SELECT sr.version INTO v_schema_version';
  IF (length(definition) - length(replace(definition, prior, ''))) / length(prior) <> 1 THEN
    RAISE EXCEPTION 'Expected one authorized settings request schema lookup';
  END IF;
  EXECUTE replace(definition, prior, $guard$  IF jsonb_path_exists(p_value, '$.** ? (@ == "REDACTED")') THEN
    RAISE EXCEPTION 'Settings preview markers cannot be saved; submit explicit values' USING ERRCODE = '23514';
  END IF;

$guard$ || prior);
END;
$preview_guard$;
COMMIT;
