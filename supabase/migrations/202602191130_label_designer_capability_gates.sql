-- Migration: Label designer capability gates (RLS + RPC hardening)
BEGIN;
SELECT pg_advisory_lock(hashtext('202602191130_label_designer_capability_gates'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.label_designer_is_service_role_v1()
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_claims JSONB;
  v_role TEXT;
BEGIN
  BEGIN
    v_claims := current_setting('request.jwt.claims', true)::jsonb;
  EXCEPTION
    WHEN others THEN
      v_claims := NULL;
  END;

  v_role := NULLIF(btrim(COALESCE(v_claims->>'role', '')), '');
  RETURN v_role = 'service_role';
END;
$function$;

REVOKE ALL ON FUNCTION public.label_designer_is_service_role_v1() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.label_designer_is_service_role_v1() TO authenticated, service_role;

-- RLS: enforce capability gates in addition to organization isolation.
DROP POLICY IF EXISTS label_design_drafts_select ON public.label_design_drafts;
CREATE POLICY label_design_drafts_select
  ON public.label_design_drafts
  FOR SELECT
  TO authenticated
  USING (
    organization_id = current_user_org_id()
    AND (
      public.label_designer_is_service_role_v1()
      OR public.user_has_capability_v1('label_design.read', scope_type, scope_id)
    )
  );

DROP POLICY IF EXISTS label_design_drafts_insert ON public.label_design_drafts;
CREATE POLICY label_design_drafts_insert
  ON public.label_design_drafts
  FOR INSERT
  TO authenticated
  WITH CHECK (
    organization_id = current_user_org_id()
    AND (
      public.label_designer_is_service_role_v1()
      OR public.user_has_capability_v1('label_design.write', scope_type, scope_id)
    )
  );

DROP POLICY IF EXISTS label_design_drafts_update ON public.label_design_drafts;
CREATE POLICY label_design_drafts_update
  ON public.label_design_drafts
  FOR UPDATE
  TO authenticated
  USING (
    organization_id = current_user_org_id()
    AND (
      public.label_designer_is_service_role_v1()
      OR public.user_has_capability_v1('label_design.write', scope_type, scope_id)
    )
  )
  WITH CHECK (
    organization_id = current_user_org_id()
    AND (
      public.label_designer_is_service_role_v1()
      OR public.user_has_capability_v1('label_design.write', scope_type, scope_id)
    )
  );

DROP POLICY IF EXISTS label_design_drafts_delete ON public.label_design_drafts;
CREATE POLICY label_design_drafts_delete
  ON public.label_design_drafts
  FOR DELETE
  TO authenticated
  USING (
    organization_id = current_user_org_id()
    AND (
      public.label_designer_is_service_role_v1()
      OR public.user_has_capability_v1('label_design.write', scope_type, scope_id)
    )
  );

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
  v_service_role BOOLEAN := public.label_designer_is_service_role_v1();
BEGIN
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

  v_value := public.resolve_settings_merged('label_field_catalog', p_scope_type, p_scope_id);
  RETURN jsonb_build_object('ok', TRUE, 'value', COALESCE(v_value, '{}'::jsonb));
END;
$function$;

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
  v_service_role BOOLEAN := public.label_designer_is_service_role_v1();
BEGIN
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

  v_value := public.resolve_settings_merged('label_design', p_scope_type, p_scope_id);
  RETURN jsonb_build_object('ok', TRUE, 'value', COALESCE(v_value, '{}'::jsonb));
END;
$function$;

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
  v_service_role BOOLEAN := public.label_designer_is_service_role_v1();
BEGIN
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

  v_value := public.resolve_settings_merged('label_render_policy', p_scope_type, p_scope_id);
  RETURN jsonb_build_object('ok', TRUE, 'value', COALESCE(v_value, '{}'::jsonb));
END;
$function$;

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
  v_service_role BOOLEAN := public.label_designer_is_service_role_v1();
BEGIN
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

  v_value := public.resolve_settings_merged('label_print_profile', p_scope_type, p_scope_id);
  RETURN jsonb_build_object('ok', TRUE, 'value', COALESCE(v_value, '{}'::jsonb));
END;
$function$;

CREATE OR REPLACE FUNCTION public.label_designer_get_label_media_catalog(
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
  v_service_role BOOLEAN := public.label_designer_is_service_role_v1();
BEGIN
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

  v_value := public.resolve_settings_merged('label_media_catalog', p_scope_type, p_scope_id);
  RETURN jsonb_build_object('ok', TRUE, 'value', COALESCE(v_value, '{}'::jsonb));
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
  v_org UUID := current_user_org_id();
  v_shipment_org UUID;
  v_payload JSONB;
  v_service_role BOOLEAN := public.label_designer_is_service_role_v1();
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

  IF NOT v_service_role
     AND NOT public.user_has_capability_v1('label_design.read', 'tenant', v_org) THEN
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

  RETURN jsonb_build_object(
    'ok', TRUE,
    'user_id', v_user,
    'organization_id', v_org,
    'can_read', public.user_has_capability_v1('label_design.read', 'tenant', v_org),
    'can_write', public.user_has_capability_v1('label_design.write', 'tenant', v_org)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.label_designer_publish_label_design_draft(
  p_draft_id UUID,
  p_change_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user UUID := auth.uid();
  v_org UUID := current_user_org_id();
  v_now TIMESTAMPTZ := workflow_now();
  v_draft public.label_design_drafts%ROWTYPE;
  v_validation JSONB;
  v_schema_version INT;
  v_scope_hash UUID;
  v_next_version INT;
  v_settings_version_id UUID;
  v_reason TEXT;
  v_service_role BOOLEAN := public.label_designer_is_service_role_v1();
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object('code','auth_required','message','Authentication required')
    );
  END IF;

  IF v_org IS NULL THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object('code','org_required','message','Organization context required')
    );
  END IF;

  SELECT *
    INTO v_draft
    FROM public.label_design_drafts d
   WHERE d.id = p_draft_id
     AND d.organization_id = v_org
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object('code','draft_not_found','message','Draft not found')
    );
  END IF;

  IF NOT v_service_role
     AND NOT public.user_has_capability_v1('label_design.write', v_draft.scope_type, v_draft.scope_id) THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object('code','access_denied','message','label_design.write capability is required')
    );
  END IF;

  IF v_draft.status IS DISTINCT FROM 'draft' THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object(
        'code','draft_not_publishable',
        'message','Draft status is not publishable',
        'status', v_draft.status
      )
    );
  END IF;

  -- Ensure the target scope belongs to the same org (write-time governance).
  IF v_draft.scope_type = 'tenant' THEN
    IF v_draft.scope_id IS DISTINCT FROM v_org THEN
      RETURN jsonb_build_object(
        'ok', FALSE,
        'error', jsonb_build_object(
          'code','scope_invalid',
          'message','tenant scope_id must equal organization_id'
        )
      );
    END IF;
  ELSIF v_draft.scope_type = 'client' THEN
    PERFORM 1
    FROM public.clients c
    WHERE c.id = v_draft.scope_id
      AND c.organization_id = v_org;
    IF NOT FOUND THEN
      RETURN jsonb_build_object(
        'ok', FALSE,
        'error', jsonb_build_object('code','scope_invalid','message','client not in organization')
      );
    END IF;
  ELSIF v_draft.scope_type = 'sender' THEN
    PERFORM 1
    FROM public.senders s
    JOIN public.clients c ON c.id = s.client_id
    WHERE s.id = v_draft.scope_id
      AND c.organization_id = v_org;
    IF NOT FOUND THEN
      RETURN jsonb_build_object(
        'ok', FALSE,
        'error', jsonb_build_object('code','scope_invalid','message','sender not in organization')
      );
    END IF;
  ELSE
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object('code','scope_type_invalid','message','Unsupported scope_type')
    );
  END IF;

  -- Publish gate: validate label_design templates via validate_label_renderer_config().
  v_validation := public.label_designer_validate_label_design(v_draft.draft_value);
  IF jsonb_typeof(v_validation) = 'array' AND jsonb_array_length(v_validation) > 0 THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object('code','validation_failed','message','Draft validation failed'),
      'validation_errors', v_validation
    );
  END IF;

  SELECT sr.version
    INTO v_schema_version
    FROM public.schema_registry sr
   WHERE sr.category = 'label_design'
     AND sr.is_active = TRUE
   ORDER BY sr.version DESC
   LIMIT 1;

  v_schema_version := COALESCE(v_schema_version, 1);

  v_reason := NULLIF(btrim(p_change_reason), '');
  IF v_reason IS NULL THEN
    v_reason := format('Publish label_design draft %s', v_draft.id);
  END IF;

  v_scope_hash := COALESCE(v_draft.scope_id, '00000000-0000-0000-0000-000000000000'::uuid);

  -- Close any current approved row to satisfy uniqueness (category/scope_hash).
  UPDATE public.settings_versions
  SET effective_until = v_now
  WHERE category = 'label_design'
    AND scope_type = v_draft.scope_type
    AND scope_hash = v_scope_hash
    AND effective_until IS NULL
    AND approved_at IS NOT NULL;

  SELECT COALESCE(MAX(version), 0) + 1
    INTO v_next_version
    FROM public.settings_versions
   WHERE category = 'label_design'
     AND scope_type = v_draft.scope_type
     AND scope_hash = v_scope_hash;

  INSERT INTO public.settings_versions (
    id,
    category,
    scope_type,
    scope_id,
    scope_hash,
    version,
    value,
    schema_version,
    change_reason,
    requested_by,
    approved_by,
    approved_at,
    effective_from,
    effective_until
  )
  VALUES (
    gen_random_uuid(),
    'label_design',
    v_draft.scope_type,
    v_draft.scope_id,
    v_scope_hash,
    v_next_version,
    v_draft.draft_value,
    v_schema_version,
    v_reason,
    v_user,
    v_user,
    v_now,
    v_now,
    NULL
  )
  RETURNING id INTO v_settings_version_id;

  INSERT INTO public.settings (
    id,
    category,
    scope_type,
    scope_id,
    scope_hash,
    settings_version_id,
    cached_value,
    last_updated
  )
  VALUES (
    gen_random_uuid(),
    'label_design',
    v_draft.scope_type,
    v_draft.scope_id,
    v_scope_hash,
    v_settings_version_id,
    v_draft.draft_value,
    v_now
  )
  ON CONFLICT (category, scope_type, scope_hash) DO UPDATE
  SET
    settings_version_id = EXCLUDED.settings_version_id,
    cached_value = EXCLUDED.cached_value,
    last_updated = EXCLUDED.last_updated;

  UPDATE public.label_design_drafts
  SET
    status = 'published',
    published_settings_version_id = v_settings_version_id,
    published_at = v_now,
    updated_at = v_now
  WHERE id = v_draft.id
    AND organization_id = v_org;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'settings_version_id', v_settings_version_id,
    'scope_type', v_draft.scope_type,
    'scope_id', v_draft.scope_id,
    'schema_version', v_schema_version,
    'version', v_next_version
  );
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
  v_org UUID := current_user_org_id();
  v_scope_type TEXT;
  v_scope_id UUID;
  v_value JSONB;
  v_errors JSONB;
  v_service_role BOOLEAN := public.label_designer_is_service_role_v1();
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object('code','auth_required','message','Authentication required')
    );
  END IF;

  IF v_org IS NULL THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object('code','org_required','message','Organization context required')
    );
  END IF;

  SELECT d.scope_type, d.scope_id, d.draft_value
    INTO v_scope_type, v_scope_id, v_value
    FROM public.label_design_drafts d
   WHERE d.id = p_draft_id
     AND d.organization_id = v_org
   LIMIT 1;

  IF NOT FOUND OR v_value IS NULL THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object('code','draft_not_found','message','Draft not found')
    );
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

REVOKE ALL ON FUNCTION public.label_designer_get_field_catalog(TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.label_designer_get_field_catalog(TEXT, UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.label_designer_get_effective_label_design(TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.label_designer_get_effective_label_design(TEXT, UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.label_designer_get_effective_label_render_policy(TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.label_designer_get_effective_label_render_policy(TEXT, UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.label_designer_get_effective_label_print_profile(TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.label_designer_get_effective_label_print_profile(TEXT, UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.label_designer_get_label_media_catalog(TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.label_designer_get_label_media_catalog(TEXT, UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.label_designer_get_sample_payload(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.label_designer_get_sample_payload(UUID, UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.label_designer_whoami() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.label_designer_whoami() TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.label_designer_publish_label_design_draft(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.label_designer_publish_label_design_draft(UUID, TEXT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.label_designer_validate_label_design_draft(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.label_designer_validate_label_design_draft(UUID) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202602191130_label_designer_capability_gates'));
COMMIT;
