-- Console V2 label designer platform active-tenant scope alignment.
--
-- Platform operators work inside an explicit active tenant lens in Console V2.
-- Label designer scope validation must therefore resolve the requested tenant,
-- client, or sender owner organization from the row-driven scope itself, then
-- let the existing capability checks decide whether the actor can read/write.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605300930_console_v2_label_designer_platform_active_tenant_scope_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

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
  v_actor_org UUID := public.current_user_org_id();
  v_scope_type TEXT := lower(NULLIF(btrim(COALESCE(p_scope_type, '')), ''));
  v_target_org UUID;
  v_is_platform BOOLEAN := COALESCE(public.is_platform_user(), FALSE);
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'auth_required', 'message', 'Authentication required');
  END IF;

  IF v_actor_org IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'org_required', 'message', 'Organization context required');
  END IF;

  IF v_scope_type IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'scope_type_required', 'message', 'scope_type is required');
  END IF;

  IF p_scope_id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'code', 'scope_id_required', 'message', 'scope_id is required');
  END IF;

  IF v_scope_type = 'tenant' THEN
    SELECT o.id
      INTO v_target_org
      FROM public.organizations o
     WHERE o.id = p_scope_id
     LIMIT 1;

    IF v_target_org IS NULL THEN
      RETURN jsonb_build_object('ok', FALSE, 'code', 'scope_invalid', 'message', 'tenant organization not found');
    END IF;

    IF NOT v_is_platform AND v_target_org IS DISTINCT FROM v_actor_org THEN
      RETURN jsonb_build_object('ok', FALSE, 'code', 'scope_invalid', 'message', 'tenant scope_id must equal organization_id');
    END IF;

    RETURN jsonb_build_object(
      'ok', TRUE,
      'organization_id', v_target_org,
      'actor_organization_id', v_actor_org,
      'scope_type', v_scope_type,
      'scope_id', p_scope_id,
      'platform_actor', v_is_platform
    );
  END IF;

  IF v_scope_type = 'client' THEN
    SELECT c.organization_id
      INTO v_target_org
      FROM public.clients c
     WHERE c.id = p_scope_id
     LIMIT 1;

    IF v_target_org IS NULL THEN
      RETURN jsonb_build_object('ok', FALSE, 'code', 'scope_invalid', 'message', 'client not in organization');
    END IF;

    IF NOT v_is_platform AND v_target_org IS DISTINCT FROM v_actor_org THEN
      RETURN jsonb_build_object('ok', FALSE, 'code', 'scope_invalid', 'message', 'client not in organization');
    END IF;

    RETURN jsonb_build_object(
      'ok', TRUE,
      'organization_id', v_target_org,
      'actor_organization_id', v_actor_org,
      'scope_type', v_scope_type,
      'scope_id', p_scope_id,
      'platform_actor', v_is_platform
    );
  END IF;

  IF v_scope_type = 'sender' THEN
    SELECT c.organization_id
      INTO v_target_org
      FROM public.senders s
      JOIN public.clients c ON c.id = s.client_id
     WHERE s.id = p_scope_id
     LIMIT 1;

    IF v_target_org IS NULL THEN
      RETURN jsonb_build_object('ok', FALSE, 'code', 'scope_invalid', 'message', 'sender not in organization');
    END IF;

    IF NOT v_is_platform AND v_target_org IS DISTINCT FROM v_actor_org THEN
      RETURN jsonb_build_object('ok', FALSE, 'code', 'scope_invalid', 'message', 'sender not in organization');
    END IF;

    RETURN jsonb_build_object(
      'ok', TRUE,
      'organization_id', v_target_org,
      'actor_organization_id', v_actor_org,
      'scope_type', v_scope_type,
      'scope_id', p_scope_id,
      'platform_actor', v_is_platform
    );
  END IF;

  RETURN jsonb_build_object('ok', FALSE, 'code', 'scope_type_invalid', 'message', 'Unsupported scope_type');
END;
$function$;

CREATE OR REPLACE FUNCTION public.label_designer_validate_label_design_draft(p_draft_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user UUID := auth.uid();
  v_actor_org UUID := public.current_user_org_id();
  v_scope_type TEXT;
  v_scope_id UUID;
  v_draft_org UUID;
  v_value JSONB;
  v_errors JSONB;
  v_scope_check JSONB;
  v_service_role BOOLEAN := public.label_designer_is_service_role_v1();
  v_is_platform BOOLEAN := COALESCE(public.is_platform_user(), FALSE);
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object('code','auth_required','message','Authentication required')
    );
  END IF;

  IF v_actor_org IS NULL AND NOT v_service_role THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object('code','org_required','message','Organization context required')
    );
  END IF;

  SELECT d.scope_type, d.scope_id, d.organization_id, d.draft_value
    INTO v_scope_type, v_scope_id, v_draft_org, v_value
    FROM public.label_design_drafts d
   WHERE d.id = p_draft_id
     AND (v_service_role OR v_is_platform OR d.organization_id = v_actor_org)
   LIMIT 1;

  IF NOT FOUND OR v_value IS NULL THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object('code','draft_not_found','message','Draft not found')
    );
  END IF;

  v_scope_check := public.label_designer_assert_scope(v_scope_type, v_scope_id);
  IF COALESCE((v_scope_check->>'ok')::BOOLEAN, FALSE) IS NOT TRUE
     OR (v_scope_check->>'organization_id')::UUID IS DISTINCT FROM v_draft_org THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', v_scope_check);
  END IF;

  IF NOT v_service_role
     AND NOT public.user_has_capability_v1('label_design.read', v_scope_type, v_scope_id) THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object('code','access_denied','message','label_design.read capability is required')
    );
  END IF;

  v_errors := public.label_designer_validate_label_design(v_value);

  RETURN jsonb_build_object(
    'ok', (jsonb_typeof(v_errors) = 'array' AND jsonb_array_length(v_errors) = 0),
    'errors', COALESCE(v_errors, '[]'::jsonb)
  );
END;
$function$;

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
  v_actor_org UUID := public.current_user_org_id();
  v_shipment_org UUID;
  v_payload JSONB;
  v_service_role BOOLEAN := public.label_designer_is_service_role_v1();
  v_is_platform BOOLEAN := COALESCE(public.is_platform_user(), FALSE);
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code','auth_required','message','Authentication required'));
  END IF;

  IF v_actor_org IS NULL AND NOT v_service_role THEN
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

  IF v_shipment_org IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code','shipment_not_found','message','Shipment not accessible'));
  END IF;

  IF NOT v_service_role
     AND NOT v_is_platform
     AND v_shipment_org IS DISTINCT FROM v_actor_org THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code','access_denied','message','Shipment not accessible'));
  END IF;

  IF NOT v_service_role
     AND NOT public.user_has_capability_v1('label_design.read', 'tenant', v_shipment_org) THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object('code','access_denied','message','label_design.read capability is required')
    );
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

CREATE OR REPLACE FUNCTION public.label_designer_archive_draft(
  p_draft_id UUID,
  p_archive_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user UUID := auth.uid();
  v_actor_org UUID := public.current_user_org_id();
  v_existing public.label_design_drafts%ROWTYPE;
  v_reason TEXT := NULLIF(btrim(COALESCE(p_archive_reason, '')), '');
  v_draft JSONB;
  v_scope_check JSONB;
  v_service_role BOOLEAN := public.label_designer_is_service_role_v1();
  v_is_platform BOOLEAN := COALESCE(public.is_platform_user(), FALSE);
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object('code','auth_required','message','Authentication required')
    );
  END IF;

  IF v_actor_org IS NULL AND NOT v_service_role THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object('code','org_required','message','Organization context required')
    );
  END IF;

  SELECT *
    INTO v_existing
    FROM public.label_design_drafts d
   WHERE d.id = p_draft_id
     AND (v_service_role OR v_is_platform OR d.organization_id = v_actor_org)
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object('code','draft_not_found','message','Draft not found')
    );
  END IF;

  v_scope_check := public.label_designer_assert_scope(v_existing.scope_type, v_existing.scope_id);
  IF COALESCE((v_scope_check->>'ok')::BOOLEAN, FALSE) IS NOT TRUE
     OR (v_scope_check->>'organization_id')::UUID IS DISTINCT FROM v_existing.organization_id THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', v_scope_check);
  END IF;

  IF v_existing.status IS DISTINCT FROM 'draft' THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object('code','draft_not_archivable','message','Only draft rows can be archived')
    );
  END IF;

  IF NOT v_service_role
     AND NOT public.user_has_capability_v1('label_design.write', v_existing.scope_type, v_existing.scope_id) THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object('code','access_denied','message','label_design.write capability is required')
    );
  END IF;

  UPDATE public.label_design_drafts d
     SET status = 'archived',
         archived_at = public.workflow_now(),
         archived_by = v_user,
         archive_reason = COALESCE(v_reason, 'Archived from Console V2 Labels'),
         updated_at = public.workflow_now()
   WHERE d.id = p_draft_id
     AND d.organization_id = v_existing.organization_id;

  SELECT to_jsonb(d)
    INTO v_draft
    FROM public.label_design_drafts d
   WHERE d.id = p_draft_id
     AND d.organization_id = v_existing.organization_id
   LIMIT 1;

  RETURN jsonb_build_object('ok', TRUE, 'draft', v_draft);
END;
$function$;

COMMENT ON FUNCTION public.label_designer_assert_scope(TEXT, UUID) IS
  'Validates label designer tenant/client/sender scope. Platform actors may target an active tenant scope, while tenant actors remain restricted to their own organization; capability checks remain enforced by caller RPCs.';
COMMENT ON FUNCTION public.label_designer_validate_label_design_draft(UUID) IS
  'Validates a label design draft with resolved owner organization and label_design.read enforcement, including platform active-tenant drafts.';
COMMENT ON FUNCTION public.label_designer_get_sample_payload(UUID, UUID) IS
  'Returns a shipment label preview payload for a caller-visible tenant shipment, including platform active-tenant proof through label_design.read.';
COMMENT ON FUNCTION public.label_designer_archive_draft(UUID, TEXT) IS
  'Archives an unpublished label design draft with resolved owner organization and label_design.write enforcement, including platform active-tenant drafts.';

SELECT pg_advisory_unlock(hashtext('202605300930_console_v2_label_designer_platform_active_tenant_scope_v1'));

COMMIT;
