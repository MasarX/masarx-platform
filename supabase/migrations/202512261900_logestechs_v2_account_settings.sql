-- Plan: PLAN-202512-api-gateway-logestechs-per-client-accounts / Step: S04
-- Migration: Logestechs V2 account settings (ladder-driven)
-- Purpose:
--   - Introduce a canonical settings category for per-scope Logestechs V2 upstream account selection.
--   - Keep `company-id` and `auth_config_id` row-driven (no per-client route duplication).
--   - Seed a safe global default for `company_id` (auth_config_id is provisioned via ops scripts).
-- Date: 2025-12-26

BEGIN;

SET search_path TO public, extensions, pg_temp;

-- ---------------------------------------------------------------------------
-- 1) schema_registry entry (documents the settings contract)
-- ---------------------------------------------------------------------------

INSERT INTO public.schema_registry (
  category,
  version,
  schema,
  examples,
  is_active
)
VALUES (
  'logestechs_v2_account',
  1,
  jsonb_build_object(
    'type', 'object',
    'additionalProperties', FALSE,
    'required', jsonb_build_array('company_id'),
    'properties', jsonb_build_object(
      'auth_config_id', jsonb_build_object('type', 'string', 'format', 'uuid'),
      'company_id', jsonb_build_object('type', jsonb_build_array('string', 'integer', 'number')),
      'enabled', jsonb_build_object('type', 'boolean', 'default', TRUE),
      'notes', jsonb_build_object('type', 'string')
    )
  ),
  jsonb_build_array(
    jsonb_build_object('company_id', '362'),
    jsonb_build_object('auth_config_id', '11111111-1111-1111-1111-111111111111', 'company_id', '362', 'enabled', TRUE)
  ),
  TRUE
)
ON CONFLICT (category, version) DO UPDATE
SET schema = EXCLUDED.schema,
    examples = EXCLUDED.examples,
    is_active = EXCLUDED.is_active;

-- ---------------------------------------------------------------------------
-- 2) Seed global default (company-id only; auth_config_id is provisioned later)
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  v_value JSONB := jsonb_build_object('company_id', '362', 'enabled', TRUE);
  v_existing_sv UUID;
  v_sv_id UUID;
  v_existing_settings UUID;
BEGIN
  -- Settings version (global rows use scope_id NULL; scope_hash becomes UUID nil).
  SELECT id
    INTO v_existing_sv
    FROM public.settings_versions_p0
   WHERE category = 'logestechs_v2_account'
     AND scope_type = 'global'
     AND scope_id IS NULL
   ORDER BY effective_from DESC
   LIMIT 1;

  IF v_existing_sv IS NOT NULL THEN
    UPDATE public.settings_versions_p0
       SET value = v_value,
           schema_version = 1,
           change_reason = 'Seed global logestechs_v2_account default (company_id)',
           approved_at = now(),
           effective_until = NULL,
           effective_from = now()
     WHERE id = v_existing_sv;
    v_sv_id := v_existing_sv;
  ELSE
    INSERT INTO public.settings_versions_p0 (
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
      'logestechs_v2_account',
      'global',
      NULL,
      1,
      v_value,
      1,
      'Seed global logestechs_v2_account default (company_id)',
      now(),
      now()
    )
    RETURNING id INTO v_sv_id;
  END IF;

  SELECT id
    INTO v_existing_settings
    FROM public.settings
   WHERE category = 'logestechs_v2_account'
     AND scope_type = 'global'
     AND scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
   LIMIT 1;

  IF v_existing_settings IS NOT NULL THEN
    UPDATE public.settings
       SET settings_version_id = v_sv_id,
           cached_value = v_value,
           last_updated = now()
     WHERE id = v_existing_settings;
  ELSE
    INSERT INTO public.settings (
      category,
      scope_type,
      scope_id,
      scope_hash,
      settings_version_id,
      cached_value,
      last_updated
    ) VALUES (
      'logestechs_v2_account',
      'global',
      NULL,
      '00000000-0000-0000-0000-000000000000'::uuid,
      v_sv_id,
      v_value,
      now()
    );
  END IF;
END;
$$;

COMMIT;
