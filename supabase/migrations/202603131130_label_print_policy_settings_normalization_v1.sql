-- Migration: Label print policy settings normalization
-- Purpose:
--   - Normalize label_print_policy writes through the shared settings upsert path.
--   - Repair existing scoped rows whose poll_interval_seconds drifted below the active schema minimum.
-- Notes:
--   - Row-driven: reads the minimum directly from the active schema_registry contract.
--   - Append-only: repairs existing rows by writing a new settings version through upsert_settings_value_v1.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603131130_label_print_policy_settings_normalization_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.normalize_label_print_policy_v1(
  p_value JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_value JSONB := COALESCE(p_value, '{}'::jsonb);
  v_minimum INT;
  v_poll_text TEXT;
BEGIN
  IF p_value IS NULL THEN
    RETURN NULL;
  END IF;

  IF jsonb_typeof(v_value) IS DISTINCT FROM 'object' THEN
    RETURN p_value;
  END IF;

  IF NOT (v_value ? 'poll_interval_seconds') THEN
    RETURN v_value;
  END IF;

  SELECT NULLIF(sr.schema#>>'{properties,poll_interval_seconds,minimum}', '')::INT
    INTO v_minimum
    FROM public.schema_registry sr
   WHERE sr.category = 'label_print_policy'
     AND sr.is_active = TRUE
   ORDER BY sr.version DESC
   LIMIT 1;

  IF v_minimum IS NULL THEN
    RAISE EXCEPTION 'normalize_label_print_policy_v1 requires active schema_registry minimum for label_print_policy.poll_interval_seconds';
  END IF;

  v_poll_text := btrim(COALESCE(v_value->>'poll_interval_seconds', ''));

  RETURN jsonb_set(
    v_value,
    '{poll_interval_seconds}',
    to_jsonb(
      CASE
        WHEN v_poll_text ~ '^-?[0-9]+$' THEN GREATEST(v_poll_text::INT, v_minimum)
        ELSE v_minimum
      END
    ),
    true
  );
END;
$function$;

COMMENT ON FUNCTION public.normalize_label_print_policy_v1(JSONB)
  IS 'Normalize label_print_policy writes using the active schema_registry minimum for poll_interval_seconds.';

CREATE OR REPLACE FUNCTION public.normalize_settings_value_v1(
  p_category TEXT,
  p_value JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SET search_path TO public, extensions, pg_temp
AS $function$
BEGIN
  IF p_value IS NULL THEN
    RETURN NULL;
  END IF;

  IF lower(COALESCE(btrim(p_category), '')) = 'ui_read_registry' THEN
    RETURN public.normalize_ui_read_registry_import_v1(p_value);
  END IF;

  IF lower(COALESCE(btrim(p_category), '')) = 'label_print_policy' THEN
    RETURN public.normalize_label_print_policy_v1(p_value);
  END IF;

  RETURN p_value;
END;
$function$;

COMMENT ON FUNCTION public.normalize_settings_value_v1(TEXT, JSONB)
  IS 'Apply category-specific settings normalization before persistence.';

DO $do$
DECLARE
  v_schema_version INT;
  v_row RECORD;
  v_normalized JSONB;
BEGIN
  SELECT sr.version
    INTO v_schema_version
    FROM public.schema_registry sr
   WHERE sr.category = 'label_print_policy'
     AND sr.is_active = TRUE
   ORDER BY sr.version DESC
   LIMIT 1;

  IF v_schema_version IS NULL THEN
    RAISE EXCEPTION 'schema_registry missing active schema for label_print_policy';
  END IF;

  FOR v_row IN
    SELECT s.scope_type, s.scope_id, s.cached_value
      FROM public.settings s
     WHERE s.category = 'label_print_policy'
  LOOP
    v_normalized := public.normalize_settings_value_v1('label_print_policy', v_row.cached_value);

    IF v_normalized IS DISTINCT FROM v_row.cached_value THEN
      PERFORM 1
        FROM public.upsert_settings_value_v1(
          'label_print_policy',
          v_row.scope_type,
          v_row.scope_id,
          v_normalized,
          v_schema_version,
          'Normalize label_print_policy poll_interval_seconds to active schema minimum'
        );
    END IF;
  END LOOP;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202603131130_label_print_policy_settings_normalization_v1'));
COMMIT;
