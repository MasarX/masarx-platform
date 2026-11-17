-- Plan: PLAN-202512-label-designer-browser-v1 / Step: S03
-- Migration: Label designer read APIs + restrict resolve_settings_merged privileges
-- Purpose:
--   - Restrict SECURITY DEFINER settings resolvers to runtime roles only (least privilege).
--   - Expose safe, org-scoped read RPCs for the browser label designer:
--       - label_field_catalog (curated bindings)
--       - effective label_design (merged via ladder)
--       - effective label_render_policy / label_print_profile
--       - sample shipment payload for preview
BEGIN;

SET search_path TO public, extensions, pg_temp;

-- ---------------------------------------------------------------------------
-- 1) Privilege hardening: resolve_settings_merged must not be callable by PUBLIC
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.resolve_settings_merged(TEXT, TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_settings_merged(TEXT, TEXT, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.resolve_settings_merged(TEXT, TEXT, UUID) FROM authenticated;

GRANT EXECUTE ON FUNCTION public.resolve_settings_merged(TEXT, TEXT, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.resolve_settings_merged(TEXT, TEXT, UUID) TO label_renderer_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_label_renderer_role') THEN
    GRANT EXECUTE ON FUNCTION public.resolve_settings_merged(TEXT, TEXT, UUID) TO edge_label_renderer_role;
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2) Safe scope validation helper (org-scoped, authenticated only)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.label_designer_assert_scope(
  p_scope_type TEXT,
  p_scope_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user UUID := auth.uid();
  v_org UUID := current_user_org_id();
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'auth_required', 'message', 'Authentication required');
  END IF;

  IF v_org IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'org_required', 'message', 'Organization context required');
  END IF;

  IF p_scope_type IS NULL OR btrim(p_scope_type) = '' THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'scope_type_required', 'message', 'scope_type is required');
  END IF;

  IF p_scope_id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'scope_id_required', 'message', 'scope_id is required');
  END IF;

  IF p_scope_type = 'tenant' THEN
    IF p_scope_id IS DISTINCT FROM v_org THEN
      RETURN jsonb_build_object('ok', FALSE, 'code', 'scope_invalid', 'message', 'tenant scope_id must equal organization_id');
    END IF;
    RETURN jsonb_build_object('ok', TRUE, 'organization_id', v_org);
  END IF;

  IF p_scope_type = 'client' THEN
    PERFORM 1
    FROM public.clients c
    WHERE c.id = p_scope_id
      AND c.organization_id = v_org;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', FALSE, 'code', 'scope_invalid', 'message', 'client not in organization');
    END IF;
    RETURN jsonb_build_object('ok', TRUE, 'organization_id', v_org);
  END IF;

  IF p_scope_type = 'sender' THEN
    PERFORM 1
    FROM public.senders s
    JOIN public.clients c ON c.id = s.client_id
    WHERE s.id = p_scope_id
      AND c.organization_id = v_org;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', FALSE, 'code', 'scope_invalid', 'message', 'sender not in organization');
    END IF;
    RETURN jsonb_build_object('ok', TRUE, 'organization_id', v_org);
  END IF;

  RETURN jsonb_build_object('ok', FALSE, 'code', 'scope_type_invalid', 'message', 'Unsupported scope_type');
END;
$function$;

REVOKE ALL ON FUNCTION public.label_designer_assert_scope(TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.label_designer_assert_scope(TEXT, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.label_designer_assert_scope(TEXT, UUID) TO service_role;

-- ---------------------------------------------------------------------------
-- 3) Read APIs (designer-safe)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.label_designer_get_field_catalog(
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
  v_value JSONB;
BEGIN
  v_scope_check := public.label_designer_assert_scope(p_scope_type, p_scope_id);
  IF COALESCE((v_scope_check->>'ok')::boolean, false) IS NOT TRUE THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', v_scope_check);
  END IF;

  v_value := public.resolve_settings_merged('label_field_catalog', p_scope_type, p_scope_id);
  RETURN jsonb_build_object('ok', TRUE, 'value', COALESCE(v_value, '{}'::jsonb));
END;
$function$;

REVOKE ALL ON FUNCTION public.label_designer_get_field_catalog(TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.label_designer_get_field_catalog(TEXT, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.label_designer_get_field_catalog(TEXT, UUID) TO service_role;

CREATE OR REPLACE FUNCTION public.label_designer_get_effective_label_design(
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
  v_value JSONB;
BEGIN
  v_scope_check := public.label_designer_assert_scope(p_scope_type, p_scope_id);
  IF COALESCE((v_scope_check->>'ok')::boolean, false) IS NOT TRUE THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', v_scope_check);
  END IF;

  v_value := public.resolve_settings_merged('label_design', p_scope_type, p_scope_id);
  RETURN jsonb_build_object('ok', TRUE, 'value', COALESCE(v_value, '{}'::jsonb));
END;
$function$;

REVOKE ALL ON FUNCTION public.label_designer_get_effective_label_design(TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.label_designer_get_effective_label_design(TEXT, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.label_designer_get_effective_label_design(TEXT, UUID) TO service_role;

CREATE OR REPLACE FUNCTION public.label_designer_get_effective_label_render_policy(
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
  v_value JSONB;
BEGIN
  v_scope_check := public.label_designer_assert_scope(p_scope_type, p_scope_id);
  IF COALESCE((v_scope_check->>'ok')::boolean, false) IS NOT TRUE THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', v_scope_check);
  END IF;

  v_value := public.resolve_settings_merged('label_render_policy', p_scope_type, p_scope_id);
  RETURN jsonb_build_object('ok', TRUE, 'value', COALESCE(v_value, '{}'::jsonb));
END;
$function$;

REVOKE ALL ON FUNCTION public.label_designer_get_effective_label_render_policy(TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.label_designer_get_effective_label_render_policy(TEXT, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.label_designer_get_effective_label_render_policy(TEXT, UUID) TO service_role;

CREATE OR REPLACE FUNCTION public.label_designer_get_effective_label_print_profile(
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
  v_value JSONB;
BEGIN
  v_scope_check := public.label_designer_assert_scope(p_scope_type, p_scope_id);
  IF COALESCE((v_scope_check->>'ok')::boolean, false) IS NOT TRUE THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', v_scope_check);
  END IF;

  v_value := public.resolve_settings_merged('label_print_profile', p_scope_type, p_scope_id);
  RETURN jsonb_build_object('ok', TRUE, 'value', COALESCE(v_value, '{}'::jsonb));
END;
$function$;

REVOKE ALL ON FUNCTION public.label_designer_get_effective_label_print_profile(TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.label_designer_get_effective_label_print_profile(TEXT, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.label_designer_get_effective_label_print_profile(TEXT, UUID) TO service_role;

CREATE OR REPLACE FUNCTION public.label_designer_get_sample_payload(
  p_shipment_id UUID,
  p_shipment_box_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user UUID := auth.uid();
  v_org UUID := current_user_org_id();
  v_shipment_org UUID;
  v_payload JSONB;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code','auth_required','message','Authentication required'));
  END IF;

  IF v_org IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code','org_required','message','Organization context required'));
  END IF;

  IF p_shipment_id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code','shipment_id_required','message','shipment_id is required'));
  END IF;

  SELECT s.organization_id
    INTO v_shipment_org
    FROM public.shipments s
   WHERE s.id = p_shipment_id
   LIMIT 1;

  IF v_shipment_org IS DISTINCT FROM v_org THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code','access_denied','message','Shipment not accessible'));
  END IF;

  SELECT to_jsonb(payload)
    INTO v_payload
    FROM public.shipment_label_payload_v payload
   WHERE payload.shipment_id = p_shipment_id
     AND (
       p_shipment_box_id IS NULL
       OR payload.shipment_box_id = p_shipment_box_id
     )
   ORDER BY payload.box_number NULLS FIRST
   LIMIT 1;

  IF v_payload IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code','payload_not_found','message','Label payload not found'));
  END IF;

  RETURN jsonb_build_object('ok', TRUE, 'payload', v_payload);
END;
$function$;

REVOKE ALL ON FUNCTION public.label_designer_get_sample_payload(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.label_designer_get_sample_payload(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.label_designer_get_sample_payload(UUID, UUID) TO service_role;

-- ---------------------------------------------------------------------------
-- 4) Lightweight "whoami" for the browser designer (avoid direct reads of
--    public.users from the client; keep org resolution server-side).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.label_designer_whoami()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user UUID := auth.uid();
  v_org UUID := current_user_org_id();
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code','auth_required','message','Authentication required'));
  END IF;

  IF v_org IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code','org_required','message','Organization context required'));
  END IF;

  RETURN jsonb_build_object('ok', TRUE, 'user_id', v_user, 'organization_id', v_org);
END;
$function$;

REVOKE ALL ON FUNCTION public.label_designer_whoami() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.label_designer_whoami() TO authenticated;
GRANT EXECUTE ON FUNCTION public.label_designer_whoami() TO service_role;

COMMIT;
