-- Console V2 provider-account route category registry guard.
--
-- Purpose:
--   API route provider_account.category values are row-driven settings
--   categories. Keep those categories registered in the settings governance
--   tables and schema_registry so binding/unbinding cannot fail later with a
--   low-level settings_category_fk error.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605291815_console_v2_provider_account_settings_category_registry_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.provider_account_settings_schema_v1()
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT jsonb_build_object(
    'type', 'object',
    'additionalProperties', TRUE,
    'properties', jsonb_build_object(
      'auth_config_id', jsonb_build_object(
        'anyOf', jsonb_build_array(
          jsonb_build_object('type', 'string', 'format', 'uuid'),
          jsonb_build_object('type', 'null')
        )
      ),
      'company_id', jsonb_build_object('type', jsonb_build_array('string', 'integer', 'number')),
      'enabled', jsonb_build_object('type', 'boolean'),
      'notes', jsonb_build_object('type', 'string'),
      'unbound_at', jsonb_build_object('type', 'string', 'format', 'date-time')
    )
  );
$function$;

COMMENT ON FUNCTION public.provider_account_settings_schema_v1()
  IS 'Canonical JSON schema for route-policy provider_account settings categories.';

CREATE OR REPLACE FUNCTION public.ensure_provider_account_settings_category_v1(p_category text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
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
      jsonb_build_object('company_id', '362', 'enabled', TRUE),
      jsonb_build_object(
        'auth_config_id', '11111111-1111-1111-1111-111111111111',
        'company_id', '362',
        'enabled', TRUE
      ),
      jsonb_build_object(
        'auth_config_id', NULL,
        'company_id', '362',
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

REVOKE ALL ON FUNCTION public.ensure_provider_account_settings_category_v1(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ensure_provider_account_settings_category_v1(text) TO service_role;

COMMENT ON FUNCTION public.ensure_provider_account_settings_category_v1(text)
  IS 'Registers API route provider_account settings categories in settings_category_registry and schema_registry.';

CREATE OR REPLACE FUNCTION public.api_routes_provider_account_category_registry_guard_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_category text := NULLIF(btrim(NEW.policy #>> '{provider_account,category}'), '');
BEGIN
  IF v_category IS NOT NULL THEN
    PERFORM public.ensure_provider_account_settings_category_v1(v_category);
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS api_routes_provider_account_category_registry_guard_v1 ON public.api_routes;
CREATE TRIGGER api_routes_provider_account_category_registry_guard_v1
BEFORE INSERT OR UPDATE OF policy ON public.api_routes
FOR EACH ROW EXECUTE FUNCTION public.api_routes_provider_account_category_registry_guard_v1();

WITH provider_account_categories AS (
  SELECT DISTINCT NULLIF(btrim(r.policy #>> '{provider_account,category}'), '') AS category
    FROM public.api_routes r
   WHERE r.policy ? 'provider_account'
)
SELECT public.ensure_provider_account_settings_category_v1(category)
  FROM provider_account_categories
 WHERE category IS NOT NULL;

SELECT pg_advisory_unlock(hashtext('202605291815_console_v2_provider_account_settings_category_registry_v1'));

COMMIT;
