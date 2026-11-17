-- Plan: PLAN-202602-landing-api-contract-views-remediation / Step: S04
-- Migration: Reconcile label_design schema + settings schema_version alignment
-- Purpose:
--   - Ensure the active label_design schema accepts template barcode.human_readable
--     as string OR boolean (compatibility with seeded defaults).
--   - Keep settings_versions/schema and settings cached rows aligned to the active
--     label_design schema contract (single source of truth).

BEGIN;

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_active_version INTEGER;
  v_human_readable_union JSONB := jsonb_build_object(
    'oneOf',
    jsonb_build_array(
      jsonb_build_object('type', 'string'),
      jsonb_build_object('type', 'boolean')
    )
  );
BEGIN
  SELECT version
  INTO v_active_version
  FROM public.schema_registry
  WHERE category = 'label_design'
    AND is_active = TRUE
  ORDER BY version DESC
  LIMIT 1;

  IF v_active_version IS NULL THEN
    RAISE EXCEPTION 'Missing active schema_registry version for label_design';
  END IF;

  UPDATE public.schema_registry
  SET
    schema = jsonb_set(
      jsonb_set(
        schema,
        '{properties,templates,additionalProperties,properties,barcode,properties,human_readable}',
        v_human_readable_union,
        TRUE
      ),
      ARRAY['$defs', 'template', 'properties', 'barcode', 'properties', 'human_readable'],
      v_human_readable_union,
      TRUE
    ),
    description = CASE
      WHEN COALESCE(description, '') ILIKE '%human_readable string/boolean compatibility%'
        THEN description
      ELSE trim(BOTH FROM COALESCE(description, 'label_design schema') || ' (human_readable string/boolean compatibility)')
    END
  WHERE category = 'label_design'
    AND version = v_active_version;

  UPDATE public.settings_versions
  SET schema_version = v_active_version
  WHERE category = 'label_design'
    AND schema_version IS DISTINCT FROM v_active_version;

  WITH latest AS (
    SELECT DISTINCT ON (scope_hash)
      scope_hash,
      id AS settings_version_id,
      value AS cached_value
    FROM public.settings_versions
    WHERE category = 'label_design'
    ORDER BY
      scope_hash,
      approved_at DESC NULLS LAST,
      effective_from DESC NULLS LAST,
      created_at DESC NULLS LAST,
      version DESC
  )
  UPDATE public.settings s
  SET
    settings_version_id = latest.settings_version_id,
    cached_value = latest.cached_value,
    last_updated = now()
  FROM latest
  WHERE s.category = 'label_design'
    AND s.scope_hash = latest.scope_hash
    AND (
      s.settings_version_id IS DISTINCT FROM latest.settings_version_id
      OR s.cached_value IS DISTINCT FROM latest.cached_value
    );
END;
$$;

COMMIT;
