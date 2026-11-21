-- Replace vendor connection defaults so environments supply their own account configuration.
-- Function | Live source | Intended delta
-- public.ensure_provider_account_settings_category_v1(text) | 202605291815_console_v2_provider_account_settings_category_registry_v1.sql | Use a synthetic company id in schema examples.

BEGIN;

SET LOCAL lock_timeout = '30s';

DO $repair$
DECLARE
  v_company_id CONSTANT text := '999999';
  v_base_url CONSTANT text := 'https://vendor.example.invalid';
BEGIN
  UPDATE public.providers
     SET metadata = COALESCE(metadata, '{}'::jsonb)
           || jsonb_build_object('company_id', v_company_id, 'base_url', v_base_url),
         updated_at = now()
   WHERE name = 'logestechs_3pl';

  -- The legacy operation may exist on upgrades where its original provider was already seeded.
  UPDATE public.operation_templates
     SET url_template = v_base_url || '/api/v2/shipments',
         updated_at = now()
   WHERE operation_name = 'logestechs_create_shipment_v1';

  -- Match the seeded global version and leave separately configured account versions intact.
  WITH repaired_versions AS (
    UPDATE public.settings_versions_p0
       SET value = value || jsonb_build_object('company_id', v_company_id)
     WHERE category = 'logestechs_v2_account'
       AND scope_type = 'global'
       AND scope_id IS NULL
       AND change_reason = 'Seed global logestechs_v2_account default (company_id)'
    RETURNING id, scope_hash
  )
  UPDATE public.settings AS setting
     SET cached_value = setting.cached_value || jsonb_build_object('company_id', v_company_id),
         last_updated = now()
    FROM repaired_versions AS version
   WHERE setting.category = 'logestechs_v2_account'
     AND setting.scope_type = 'global'
     AND setting.scope_hash = version.scope_hash
     AND setting.settings_version_id = version.id;

  DELETE FROM public.settings_cache
   WHERE starts_with(cache_key, 'logestechs_v2_account:');

  UPDATE public.schema_registry AS registry
     SET examples = (
       SELECT jsonb_agg(
         CASE WHEN example.value ? 'company_id'
           THEN example.value || jsonb_build_object('company_id', v_company_id)
           ELSE example.value
         END ORDER BY example.ordinality
       )
         FROM jsonb_array_elements(registry.examples) WITH ORDINALITY AS example(value, ordinality)
     )
   WHERE registry.version = 1
     AND (registry.category = 'logestechs_v2_account'
       OR registry.description = 'Provider account credential binding settings resolved by API route policy.')
     AND jsonb_typeof(registry.examples) = 'array'
     AND registry.examples <> '[]'::jsonb;
END;
$repair$;

CREATE OR REPLACE FUNCTION public.ensure_provider_account_settings_category_v1(p_category text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_example_company_id CONSTANT text := '999999';
  v_category text := NULLIF(btrim(COALESCE(p_category, '')), '');
BEGIN
  IF v_category IS NULL THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.settings_category_registry (
    category,
    description,
    requires_schema,
    requires_global_default,
    side_effecting,
    safe_missing_behavior,
    allowed_scopes
  )
  VALUES (
    v_category,
    'Route-driven provider account credential binding category.',
    TRUE,
    FALSE,
    FALSE,
    'hard_fail',
    '["global","tenant","source"]'::jsonb
  )
  ON CONFLICT (category) DO UPDATE
     SET description = COALESCE(NULLIF(public.settings_category_registry.description, ''), EXCLUDED.description),
         requires_schema = TRUE,
         side_effecting = FALSE,
         safe_missing_behavior = 'hard_fail',
         allowed_scopes = '["global","tenant","source"]'::jsonb,
         updated_at = now();

  INSERT INTO public.schema_registry (
    category,
    version,
    schema,
    description,
    examples,
    is_active
  )
  VALUES (
    v_category,
    1,
    public.provider_account_settings_schema_v1(),
    'Provider account credential binding settings resolved by API route policy.',
    jsonb_build_array(
      jsonb_build_object('company_id', v_example_company_id, 'enabled', TRUE),
      jsonb_build_object(
        'auth_config_id', '11111111-1111-1111-1111-111111111111',
        'company_id', v_example_company_id,
        'enabled', TRUE
      ),
      jsonb_build_object(
        'auth_config_id', NULL,
        'company_id', v_example_company_id,
        'enabled', FALSE,
        'unbound_at', '2026-05-29T00:00:00Z'
      )
    ),
    TRUE
  )
  ON CONFLICT (category, version) DO UPDATE
     SET schema = EXCLUDED.schema,
         description = EXCLUDED.description,
         examples = EXCLUDED.examples,
         is_active = TRUE;

  RETURN v_category;
END;
$function$;

COMMIT;
