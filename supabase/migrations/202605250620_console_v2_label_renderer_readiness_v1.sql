-- Migration: Console V2 label renderer readiness readback
-- Purpose:
--   Expose a redacted, operator-safe readiness snapshot for /platform/labels.
--   The canonical renderer invoke resolver remains service/edge-only; this UI
--   wrapper calls it and redacts secrets before returning readback.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605250620_console_v2_label_renderer_readiness_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.ui_label_renderer_readiness_v1(
  p_scope_type TEXT,
  p_scope_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_scope_check JSONB;
  v_service_role BOOLEAN := public.label_designer_is_service_role_v1();
  v_org_id UUID;
  v_provider JSONB := '{}'::jsonb;
  v_provider_error TEXT;
  v_invoke_url TEXT;
  v_render_policy JSONB;
  v_print_profile JSONB;
  v_profile_missing TEXT[] := ARRAY[]::TEXT[];
  v_render_missing TEXT[] := ARRAY[]::TEXT[];
  v_certification JSONB;
  v_cert_missing TEXT[] := ARRAY[]::TEXT[];
BEGIN
  v_scope_check := public.label_designer_assert_scope(p_scope_type, p_scope_id);
  IF COALESCE((v_scope_check->>'ok')::BOOLEAN, FALSE) IS NOT TRUE THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', v_scope_check);
  END IF;

  IF NOT v_service_role
     AND NOT (
       public.user_has_capability_v1('labels.read', p_scope_type, p_scope_id)
       OR public.user_has_capability_v1('label_design.read', p_scope_type, p_scope_id)
     ) THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object(
        'code', 'access_denied',
        'message', 'labels.read or label_design.read capability is required'
      )
    );
  END IF;

  v_org_id := CASE
    WHEN p_scope_type = 'tenant' THEN p_scope_id
    ELSE public.current_user_org_id()
  END;

  BEGIN
    v_provider := public.resolve_label_renderer_invoke_config_v1(v_org_id);
  EXCEPTION WHEN OTHERS THEN
    v_provider_error := SQLERRM;
    v_provider := '{}'::jsonb;
  END;

  v_invoke_url := NULLIF(v_provider->>'invoke_url', '');
  IF v_invoke_url IS NOT NULL AND position('?' in v_invoke_url) > 0 THEN
    v_invoke_url := split_part(v_invoke_url, '?', 1) || '?redacted=query';
  END IF;

  v_render_policy := COALESCE(public.resolve_settings_merged('label_render_policy', p_scope_type, p_scope_id), '{}'::jsonb);
  v_print_profile := COALESCE(public.resolve_settings_merged('label_print_profile', p_scope_type, p_scope_id), '{}'::jsonb);

  IF v_render_policy = '{}'::jsonb THEN
    v_render_missing := array_append(v_render_missing, 'label_render_policy');
  END IF;
  IF NULLIF(v_render_policy->>'header_brand_mode', '') IS NULL THEN
    v_render_missing := array_append(v_render_missing, 'header_brand_mode');
  END IF;

  IF v_print_profile = '{}'::jsonb THEN
    v_profile_missing := array_append(v_profile_missing, 'label_print_profile');
  END IF;
  IF NULLIF(v_print_profile->>'profile_key', '') IS NULL THEN
    v_profile_missing := array_append(v_profile_missing, 'profile_key');
  END IF;
  IF NULLIF(v_print_profile->>'dpi', '') IS NULL THEN
    v_profile_missing := array_append(v_profile_missing, 'dpi');
  END IF;

  v_certification := COALESCE(
    v_print_profile->'printer_certification',
    v_print_profile->'certification',
    v_print_profile->'certified_printers',
    v_print_profile#>'{media,certification}'
  );
  IF v_certification IS NULL OR v_certification = '{}'::jsonb OR v_certification = '[]'::jsonb THEN
    v_cert_missing := array_append(v_cert_missing, 'printer_certification');
  END IF;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'scope', jsonb_build_object('scope_type', p_scope_type, 'scope_id', p_scope_id),
    'renderer_provider', jsonb_build_object(
      'status', CASE WHEN v_provider_error IS NULL THEN 'ready' ELSE 'missing' END,
      'provider_name', NULLIF(v_provider->>'provider_name', ''),
      'invoke_url', v_invoke_url,
      'invoke_secret', CASE WHEN NULLIF(v_provider->>'invoke_secret', '') IS NULL THEN NULL ELSE 'redacted' END,
      'timeout_ms', NULLIF(v_provider->>'timeout_ms', ''),
      'timeout_seconds', NULLIF(v_provider->>'timeout_seconds', ''),
      'error', v_provider_error
    ),
    'render_policy', jsonb_build_object(
      'status', CASE WHEN array_length(v_render_missing, 1) IS NULL THEN 'ready' ELSE 'missing' END,
      'missing', COALESCE(to_jsonb(v_render_missing), '[]'::jsonb),
      'value', v_render_policy
    ),
    'print_profile', jsonb_build_object(
      'status', CASE WHEN array_length(v_profile_missing, 1) IS NULL THEN 'ready' ELSE 'missing' END,
      'missing', COALESCE(to_jsonb(v_profile_missing), '[]'::jsonb),
      'value', v_print_profile
    ),
    'printer_certification', jsonb_build_object(
      'status', CASE WHEN array_length(v_cert_missing, 1) IS NULL THEN 'ready' ELSE 'missing' END,
      'missing', COALESCE(to_jsonb(v_cert_missing), '[]'::jsonb),
      'evidence', COALESCE(v_certification, '{}'::jsonb)
    )
  );
END;
$function$;

COMMENT ON FUNCTION public.ui_label_renderer_readiness_v1(TEXT, UUID)
  IS 'Operator-safe Console V2 label renderer readiness snapshot with provider secrets redacted and effective label render/print policy readback.';

REVOKE ALL ON FUNCTION public.ui_label_renderer_readiness_v1(TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_label_renderer_readiness_v1(TEXT, UUID) TO authenticated, service_role;

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;
GRANT USAGE ON SCHEMA api TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.ui_label_renderer_readiness_v1(
  p_scope_type TEXT,
  p_scope_id UUID
)
RETURNS JSONB
LANGUAGE sql
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.ui_label_renderer_readiness_v1(p_scope_type, p_scope_id);
$function$;

REVOKE ALL ON FUNCTION api.ui_label_renderer_readiness_v1(TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.ui_label_renderer_readiness_v1(TEXT, UUID) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202605250620_console_v2_label_renderer_readiness_v1'));

COMMIT;
