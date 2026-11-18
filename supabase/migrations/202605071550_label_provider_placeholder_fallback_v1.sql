-- Migration: Label provider placeholder fallback
-- Purpose:
--   Tenant onboarding can materialize label_provider defaults before the real
--   local/shared renderer secret is provisioned. Placeholder tenant rows should
--   not block an activated global provider, while malformed non-placeholder
--   tenant config must still fail closed.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605071550_label_provider_placeholder_fallback_v1'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.resolve_label_renderer_invoke_config_v1(
  p_organization_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_settings jsonb;
  v_global_settings jsonb;
  v_provider jsonb;
  v_url text;
  v_secret text;
  v_timeout_ms int;
  v_allow_fallback boolean := p_organization_id IS NOT NULL;
BEGIN
  IF p_organization_id IS NOT NULL THEN
    v_settings := public.resolve_settings('label_provider', 'tenant', p_organization_id);
  END IF;

  IF v_settings IS NULL THEN
    v_settings := public.resolve_settings('label_provider', 'global', NULL);
    v_allow_fallback := false;
  END IF;

  IF v_settings IS NULL THEN
    RAISE EXCEPTION 'resolve_label_renderer_invoke_config_v1: label_provider settings not found';
  END IF;

  -- Use the same credential read for the tenant and any bootstrap fallback.
  LOOP
    v_provider := COALESCE((v_settings->'providers')->0, '{}'::jsonb);
    v_url := NULLIF(v_provider->>'invoke_url', '');
    v_secret := NULLIF(v_provider->>'invoke_secret', '');
    EXIT WHEN NOT v_allow_fallback
      OR ((v_url LIKE 'https://example.%') IS NOT TRUE AND v_secret IS DISTINCT FROM 'EXAMPLE_PASSWORD');

    v_global_settings := public.resolve_settings('label_provider', 'global', NULL);
    EXIT WHEN v_global_settings IS NULL;
    v_settings := v_global_settings;
    v_allow_fallback := false;
  END LOOP;
  v_timeout_ms := COALESCE(NULLIF(v_provider->>'timeout_ms', '')::int, 15000);

  IF v_url IS NULL THEN
    RAISE EXCEPTION 'resolve_label_renderer_invoke_config_v1: invoke_url missing in label_provider configuration';
  END IF;
  IF v_secret IS NULL THEN
    RAISE EXCEPTION 'resolve_label_renderer_invoke_config_v1: invoke_secret missing in label_provider configuration';
  END IF;
  IF v_url LIKE 'https://example.%' OR v_secret = 'EXAMPLE_PASSWORD' THEN
    RAISE EXCEPTION 'resolve_label_renderer_invoke_config_v1: provider invoke configuration not activated (update settings)';
  END IF;

  RETURN jsonb_build_object(
    'invoke_url', v_url,
    'invoke_secret', v_secret,
    'provider_name', NULLIF(v_provider->>'name', ''),
    'timeout_ms', v_timeout_ms,
    'timeout_seconds', GREATEST((v_timeout_ms + 999) / 1000, 1)
  );
END;
$function$;

COMMENT ON FUNCTION public.resolve_label_renderer_invoke_config_v1(uuid)
  IS 'Resolve active label renderer invoke configuration; placeholder tenant bootstrap rows fall through to active global provider, otherwise config fails closed.';

REVOKE ALL ON FUNCTION public.resolve_label_renderer_invoke_config_v1(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_label_renderer_invoke_config_v1(uuid) TO service_role;
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_label_renderer_role') THEN
    GRANT EXECUTE ON FUNCTION public.resolve_label_renderer_invoke_config_v1(uuid) TO edge_label_renderer_role;
  END IF;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202605071550_label_provider_placeholder_fallback_v1'));

COMMIT;
