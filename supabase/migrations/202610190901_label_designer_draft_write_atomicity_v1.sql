-- Serialize draft saves and publication before either reads mutable state.
BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';
SELECT pg_advisory_xact_lock(hashtext('202610190901_label_designer_draft_write_atomicity_v1'));

CREATE OR REPLACE FUNCTION public.label_design_drafts_guard_immutable_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO public, extensions, pg_temp
AS $function$
BEGIN
  IF OLD.status IN ('published', 'archived') AND (
    ROW(NEW.id, NEW.organization_id, NEW.scope_type, NEW.scope_id, NEW.label_type,
        NEW.draft_name, NEW.draft_value, NEW.created_by, NEW.created_at,
        NEW.published_settings_version_id, NEW.published_at)
    IS DISTINCT FROM
    ROW(OLD.id, OLD.organization_id, OLD.scope_type, OLD.scope_id, OLD.label_type,
        OLD.draft_name, OLD.draft_value, OLD.created_by, OLD.created_at,
        OLD.published_settings_version_id, OLD.published_at)
    OR (NEW.status IS DISTINCT FROM OLD.status
        AND NOT (OLD.status = 'published' AND NEW.status IS NOT DISTINCT FROM 'archived'))
  ) THEN
    RAISE EXCEPTION 'Published and archived label drafts are immutable; create a new draft'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.label_design_drafts_guard_immutable_v1() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_label_design_drafts_guard_immutable_v1 ON public.label_design_drafts;
CREATE TRIGGER trg_label_design_drafts_guard_immutable_v1
BEFORE UPDATE ON public.label_design_drafts
FOR EACH ROW EXECUTE FUNCTION public.label_design_drafts_guard_immutable_v1();

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
   LIMIT 1
   FOR UPDATE;

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
   LIMIT 1
   FOR UPDATE;

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

COMMIT;
