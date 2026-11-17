-- Migration: Label designer draft list/create/update RPCs (capability-gated)
BEGIN;
SELECT pg_advisory_lock(hashtext('202602191150_label_designer_draft_write_rpcs_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

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
  v_user UUID := auth.uid();
  v_org UUID := current_user_org_id();
  v_scope_check JSONB;
  v_service_role BOOLEAN := public.label_designer_is_service_role_v1();
  v_drafts JSONB;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'auth_required', 'message', 'Authentication required'));
  END IF;

  IF v_org IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'org_required', 'message', 'Organization context required'));
  END IF;

  v_scope_check := public.label_designer_assert_scope(p_scope_type, p_scope_id);
  IF COALESCE((v_scope_check->>'ok')::boolean, false) IS NOT TRUE THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', v_scope_check);
  END IF;

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

  RETURN jsonb_build_object('ok', TRUE, 'drafts', COALESCE(v_drafts, '[]'::jsonb));
END;
$function$;

CREATE OR REPLACE FUNCTION public.label_designer_create_draft(
  p_scope_type TEXT,
  p_scope_id UUID,
  p_label_type TEXT DEFAULT 'shipping',
  p_draft_name TEXT DEFAULT NULL,
  p_draft_value JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user UUID := auth.uid();
  v_org UUID := current_user_org_id();
  v_scope_check JSONB;
  v_service_role BOOLEAN := public.label_designer_is_service_role_v1();
  v_label_type TEXT := COALESCE(NULLIF(btrim(p_label_type), ''), 'shipping');
  v_draft_name TEXT := NULLIF(btrim(p_draft_name), '');
  v_draft_value JSONB := COALESCE(p_draft_value, '{}'::jsonb);
  v_inserted public.label_design_drafts%ROWTYPE;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'auth_required', 'message', 'Authentication required'));
  END IF;

  IF v_org IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'org_required', 'message', 'Organization context required'));
  END IF;

  v_scope_check := public.label_designer_assert_scope(p_scope_type, p_scope_id);
  IF COALESCE((v_scope_check->>'ok')::boolean, false) IS NOT TRUE THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', v_scope_check);
  END IF;

  IF NOT v_service_role
     AND NOT public.user_has_capability_v1('label_design.write', p_scope_type, p_scope_id) THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object('code','access_denied','message','label_design.write capability is required')
    );
  END IF;

  IF jsonb_typeof(v_draft_value) <> 'object' THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object('code','invalid_draft_value','message','draft_value must be a JSON object')
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
    v_draft_name,
    v_draft_value,
    'draft',
    v_user
  )
  RETURNING * INTO v_inserted;

  RETURN jsonb_build_object('ok', TRUE, 'draft', to_jsonb(v_inserted));
END;
$function$;

CREATE OR REPLACE FUNCTION public.label_designer_update_draft(
  p_draft_id UUID,
  p_label_type TEXT DEFAULT NULL,
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
  v_org UUID := current_user_org_id();
  v_service_role BOOLEAN := public.label_designer_is_service_role_v1();
  v_current public.label_design_drafts%ROWTYPE;
  v_next_label_type TEXT;
  v_next_draft_name TEXT;
  v_next_draft_value JSONB;
  v_updated public.label_design_drafts%ROWTYPE;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'auth_required', 'message', 'Authentication required'));
  END IF;

  IF v_org IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'org_required', 'message', 'Organization context required'));
  END IF;

  SELECT *
    INTO v_current
    FROM public.label_design_drafts d
   WHERE d.id = p_draft_id
     AND d.organization_id = v_org
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'draft_not_found', 'message', 'Draft not found'));
  END IF;

  IF NOT v_service_role
     AND NOT public.user_has_capability_v1('label_design.write', v_current.scope_type, v_current.scope_id) THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object('code','access_denied','message','label_design.write capability is required')
    );
  END IF;

  IF v_current.status IS DISTINCT FROM 'draft' THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object('code', 'draft_not_editable', 'message', 'Only draft rows are editable')
    );
  END IF;

  v_next_label_type := COALESCE(NULLIF(btrim(p_label_type), ''), v_current.label_type);
  v_next_draft_name := CASE
    WHEN p_draft_name IS NULL THEN v_current.draft_name
    ELSE NULLIF(btrim(p_draft_name), '')
  END;
  v_next_draft_value := COALESCE(p_draft_value, v_current.draft_value);

  IF jsonb_typeof(v_next_draft_value) <> 'object' THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object('code','invalid_draft_value','message','draft_value must be a JSON object')
    );
  END IF;

  UPDATE public.label_design_drafts d
     SET label_type = v_next_label_type,
         draft_name = v_next_draft_name,
         draft_value = v_next_draft_value,
         updated_at = now()
   WHERE d.id = v_current.id
     AND d.organization_id = v_org
   RETURNING * INTO v_updated;

  RETURN jsonb_build_object('ok', TRUE, 'draft', to_jsonb(v_updated));
END;
$function$;

REVOKE ALL ON FUNCTION public.label_designer_list_drafts(TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.label_designer_list_drafts(TEXT, UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.label_designer_create_draft(TEXT, UUID, TEXT, TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.label_designer_create_draft(TEXT, UUID, TEXT, TEXT, JSONB) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.label_designer_update_draft(UUID, TEXT, TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.label_designer_update_draft(UUID, TEXT, TEXT, JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202602191150_label_designer_draft_write_rpcs_v1'));
COMMIT;
