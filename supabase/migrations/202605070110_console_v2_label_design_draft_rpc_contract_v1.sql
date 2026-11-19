-- Console V2 first-tenant label design draft RPC contract.
--
-- The Console label design surface needs browser-safe backend RPCs for draft
-- list/create/update before publish/validate can be a real tenant setup flow.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605070110_console_v2_label_design_draft_rpc_contract_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;
REVOKE USAGE ON SCHEMA api FROM anon;
GRANT USAGE ON SCHEMA api TO authenticated;
GRANT USAGE ON SCHEMA api TO service_role;

CREATE OR REPLACE FUNCTION public.label_designer_list_drafts(
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
  v_org UUID;
  v_drafts JSONB := '[]'::jsonb;
  v_service_role BOOLEAN := public.label_designer_is_service_role_v1();
BEGIN
  v_scope_check := public.label_designer_assert_scope(p_scope_type, p_scope_id);
  IF COALESCE((v_scope_check->>'ok')::boolean, FALSE) IS NOT TRUE THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', v_scope_check);
  END IF;

  v_org := (v_scope_check->>'organization_id')::uuid;

  IF NOT v_service_role
     AND NOT public.user_has_capability_v1('label_design.read', p_scope_type, p_scope_id) THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object('code','access_denied','message','label_design.read capability is required')
    );
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(d) ORDER BY d.updated_at DESC, d.created_at DESC), '[]'::jsonb)
    INTO v_drafts
    FROM public.label_design_drafts d
   WHERE d.organization_id = v_org
     AND d.scope_type = p_scope_type
     AND d.scope_id = p_scope_id;

  RETURN jsonb_build_object('ok', TRUE, 'drafts', v_drafts);
END;
$function$;

CREATE OR REPLACE FUNCTION public.label_designer_create_draft(
  p_scope_type TEXT,
  p_scope_id UUID,
  p_label_type TEXT DEFAULT 'shipping',
  p_draft_name TEXT DEFAULT NULL,
  p_draft_value JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user UUID := auth.uid();
  v_scope_check JSONB;
  v_org UUID;
  v_label_type TEXT := COALESCE(NULLIF(btrim(p_label_type), ''), 'shipping');
  v_draft_id UUID;
  v_draft JSONB;
  v_service_role BOOLEAN := public.label_designer_is_service_role_v1();
BEGIN
  v_scope_check := public.label_designer_assert_scope(p_scope_type, p_scope_id);
  IF COALESCE((v_scope_check->>'ok')::boolean, FALSE) IS NOT TRUE THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', v_scope_check);
  END IF;

  v_org := (v_scope_check->>'organization_id')::uuid;

  IF p_draft_value IS NULL OR jsonb_typeof(p_draft_value) <> 'object' THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object('code','draft_value_invalid','message','draft_value must be a JSON object')
    );
  END IF;

  IF NOT v_service_role
     AND NOT public.user_has_capability_v1('label_design.write', p_scope_type, p_scope_id) THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object('code','access_denied','message','label_design.write capability is required')
    );
  END IF;

  INSERT INTO public.label_design_drafts (
    organization_id,
    scope_type,
    scope_id,
    label_type,
    draft_name,
    draft_value,
    status,
    created_by
  )
  VALUES (
    v_org,
    p_scope_type,
    p_scope_id,
    v_label_type,
    NULLIF(btrim(p_draft_name), ''),
    p_draft_value,
    'draft',
    v_user
  )
  RETURNING id INTO v_draft_id;

  SELECT to_jsonb(d)
    INTO v_draft
    FROM public.label_design_drafts d
   WHERE d.organization_id = v_org
     AND d.id = v_draft_id
   LIMIT 1;

  RETURN jsonb_build_object('ok', TRUE, 'draft', v_draft);
END;
$function$;

CREATE OR REPLACE FUNCTION api.label_designer_list_drafts(
  p_scope_type TEXT,
  p_scope_id UUID
)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.label_designer_list_drafts(p_scope_type, p_scope_id);
$function$;

CREATE OR REPLACE FUNCTION api.label_designer_create_draft(
  p_scope_type TEXT,
  p_scope_id UUID,
  p_label_type TEXT DEFAULT 'shipping',
  p_draft_name TEXT DEFAULT NULL,
  p_draft_value JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.label_designer_create_draft(
    p_scope_type,
    p_scope_id,
    p_label_type,
    p_draft_name,
    p_draft_value
  );
$function$;

CREATE OR REPLACE FUNCTION api.label_designer_update_draft(
  p_draft_id UUID,
  p_label_type TEXT DEFAULT NULL,
  p_draft_name TEXT DEFAULT NULL,
  p_draft_value JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.label_designer_update_draft(
    p_draft_id,
    p_label_type,
    p_draft_name,
    p_draft_value
  );
$function$;

REVOKE ALL ON FUNCTION public.label_designer_list_drafts(TEXT, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION api.label_designer_list_drafts(TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.label_designer_list_drafts(TEXT, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.label_designer_list_drafts(TEXT, UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.label_designer_create_draft(TEXT, UUID, TEXT, TEXT, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION api.label_designer_create_draft(TEXT, UUID, TEXT, TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.label_designer_create_draft(TEXT, UUID, TEXT, TEXT, JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.label_designer_create_draft(TEXT, UUID, TEXT, TEXT, JSONB) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.label_designer_update_draft(UUID, TEXT, TEXT, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION api.label_designer_update_draft(UUID, TEXT, TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.label_designer_update_draft(UUID, TEXT, TEXT, JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.label_designer_update_draft(UUID, TEXT, TEXT, JSONB) TO authenticated, service_role;

COMMENT ON FUNCTION public.label_designer_list_drafts(TEXT, UUID) IS
  'Lists label design drafts for a validated tenant/client/sender scope with label_design.read enforcement.';
COMMENT ON FUNCTION api.label_designer_list_drafts(TEXT, UUID) IS
  'Browser-safe api schema wrapper for public.label_designer_list_drafts.';
COMMENT ON FUNCTION public.label_designer_create_draft(TEXT, UUID, TEXT, TEXT, JSONB) IS
  'Creates a label design draft for a validated tenant/client/sender scope with label_design.write enforcement.';
COMMENT ON FUNCTION api.label_designer_create_draft(TEXT, UUID, TEXT, TEXT, JSONB) IS
  'Browser-safe api schema wrapper for public.label_designer_create_draft.';
COMMENT ON FUNCTION public.label_designer_update_draft(UUID, TEXT, TEXT, JSONB) IS
  'Updates an editable label design draft with organization and label_design.write enforcement.';
COMMENT ON FUNCTION api.label_designer_update_draft(UUID, TEXT, TEXT, JSONB) IS
  'Browser-safe api schema wrapper for public.label_designer_update_draft.';

SELECT pg_advisory_unlock(hashtext('202605070110_console_v2_label_design_draft_rpc_contract_v1'));

COMMIT;
