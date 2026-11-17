-- Preserve registry labels through the existing scope-authorized read.
BEGIN;
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
  v_label_types JSONB;
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

  -- Global canonical lookup catalog: no tenant override columns exist here.
  SELECT COALESCE(jsonb_agg(jsonb_build_object('value', lv.value, 'label', lv.label)
    ORDER BY lv.sort_order NULLS LAST, lv.label, lv.value), '[]'::jsonb)
    INTO v_label_types
    FROM public.lookup_definitions ld
    JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
   WHERE ld.category = 'label_type'
     AND lv.status = 'active'
     AND (lv.effective_from IS NULL OR lv.effective_from <= now())
     AND (lv.effective_until IS NULL OR lv.effective_until > now());

  RETURN jsonb_build_object('ok', TRUE, 'drafts', COALESCE(v_drafts, '[]'::jsonb),
    'label_types', v_label_types);
END;
$function$;


COMMIT;
