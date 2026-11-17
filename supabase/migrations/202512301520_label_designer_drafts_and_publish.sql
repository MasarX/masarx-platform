-- Plan: PLAN-202512-label-designer-browser-v1 / Step: S03
-- Migration: Label designer drafts (RLS) + publish RPC (settings ladder write)
-- Purpose:
--   - Provide an enterprise-grade, user-facing draft surface for label_design edits.
--   - Publish writes to canonical settings tables (settings_versions + settings) with governance + audit fields.
-- Notes:
--   - No multi-user collaboration requirements in v1 (no locks/realtime co-editing).
--   - Publish uses DB "publish gate" geometry validation via validate_label_renderer_config().
BEGIN;

SET search_path TO public, extensions, pg_temp;

-- ---------------------------------------------------------------------------
-- 1) Drafts table (user-facing; RLS enforced)
-- ---------------------------------------------------------------------------
/* objectives:allow POLICY_MISSING Justification: Policies are defined on the partitioned parent and apply to partitions; avoid duplicate policies. */
CREATE TABLE IF NOT EXISTS public.label_design_drafts (
  id UUID DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL,
  scope_id UUID NOT NULL,
  label_type TEXT NOT NULL,
  draft_name TEXT,
  draft_value JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  created_by UUID REFERENCES public.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_settings_version_id UUID,
  published_at TIMESTAMPTZ,

  PRIMARY KEY (id, organization_id),
  CONSTRAINT label_design_drafts_scope_type_ck CHECK (scope_type IN ('tenant','client','sender')),
  CONSTRAINT label_design_drafts_label_type_ck CHECK (btrim(label_type) <> ''),
  CONSTRAINT label_design_drafts_status_ck CHECK (status IN ('draft','published','archived')),
  CONSTRAINT label_design_drafts_draft_value_obj_ck CHECK (jsonb_typeof(draft_value) = 'object')
) PARTITION BY HASH (organization_id);

CREATE TABLE IF NOT EXISTS public.label_design_drafts_p0
  PARTITION OF public.label_design_drafts
  FOR VALUES WITH (MODULUS 1, REMAINDER 0);

ALTER TABLE public.label_design_drafts_p0 ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_label_design_drafts_p0_scope
  ON public.label_design_drafts_p0 (organization_id, scope_type, scope_id, label_type, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_label_design_drafts_p0_status
  ON public.label_design_drafts_p0 (organization_id, status, updated_at DESC);

DROP TRIGGER IF EXISTS trg_label_design_drafts_set_updated_at ON public.label_design_drafts;
CREATE TRIGGER trg_label_design_drafts_set_updated_at
  BEFORE UPDATE ON public.label_design_drafts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.label_design_drafts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.label_design_drafts FROM PUBLIC;
REVOKE ALL ON TABLE public.label_design_drafts FROM anon;
REVOKE ALL ON TABLE public.label_design_drafts FROM authenticated;

DROP POLICY IF EXISTS label_design_drafts_select ON public.label_design_drafts;
CREATE POLICY label_design_drafts_select
  ON public.label_design_drafts
  FOR SELECT
  TO authenticated
  USING (organization_id = current_user_org_id());

DROP POLICY IF EXISTS label_design_drafts_insert ON public.label_design_drafts;
CREATE POLICY label_design_drafts_insert
  ON public.label_design_drafts
  FOR INSERT
  TO authenticated
  WITH CHECK (organization_id = current_user_org_id());

DROP POLICY IF EXISTS label_design_drafts_update ON public.label_design_drafts;
CREATE POLICY label_design_drafts_update
  ON public.label_design_drafts
  FOR UPDATE
  TO authenticated
  USING (organization_id = current_user_org_id())
  WITH CHECK (organization_id = current_user_org_id());

DROP POLICY IF EXISTS label_design_drafts_delete ON public.label_design_drafts;
CREATE POLICY label_design_drafts_delete
  ON public.label_design_drafts
  FOR DELETE
  TO authenticated
  USING (organization_id = current_user_org_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.label_design_drafts TO authenticated;
GRANT ALL ON public.label_design_drafts TO service_role;

-- ---------------------------------------------------------------------------
-- 2) Validation helper: validate an entire label_design object using the DB
--    renderer_config publish gate
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.label_designer_validate_label_design(p_label_design JSONB)
RETURNS JSONB
LANGUAGE plpgsql
AS $function$
DECLARE
  v_errors JSONB := '[]'::jsonb;
  v_templates JSONB;
  tpl RECORD;
  v_renderer_config JSONB;
  v_tpl_errors JSONB;
BEGIN
  IF p_label_design IS NULL OR jsonb_typeof(p_label_design) <> 'object' THEN
    RETURN jsonb_build_array(
      jsonb_build_object('code','label_design_invalid','message','label_design must be an object')
    );
  END IF;

  v_templates := p_label_design->'templates';
  IF v_templates IS NULL OR jsonb_typeof(v_templates) <> 'object' THEN
    RETURN jsonb_build_array(
      jsonb_build_object('code','templates_missing','message','label_design.templates missing')
    );
  END IF;

  FOR tpl IN SELECT key, value FROM jsonb_each(v_templates)
  LOOP
    IF tpl.value IS NULL OR jsonb_typeof(tpl.value) <> 'object' THEN
      v_errors := v_errors || jsonb_build_array(
        jsonb_build_object(
          'code','template_invalid',
          'message','template must be an object',
          'template_key', tpl.key
        )
      );
      CONTINUE;
    END IF;

    v_renderer_config := jsonb_strip_nulls(jsonb_build_object(
      'page', tpl.value->'page',
      'blocks', tpl.value->'blocks'
    ));

    v_tpl_errors := public.validate_label_renderer_config(v_renderer_config);
    IF jsonb_typeof(v_tpl_errors) = 'array' AND jsonb_array_length(v_tpl_errors) > 0 THEN
      v_errors := v_errors || jsonb_build_array(
        jsonb_build_object(
          'code','template_renderer_config_invalid',
          'template_key', tpl.key,
          'errors', v_tpl_errors
        )
      );
    END IF;
  END LOOP;

  RETURN v_errors;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 3) Publish: write draft_value to label_design settings at the draft's scope
-- ---------------------------------------------------------------------------
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

-- Lightweight validation RPC for UI (no writes).
CREATE OR REPLACE FUNCTION public.label_designer_validate_label_design_draft(p_draft_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user UUID := auth.uid();
  v_org UUID := current_user_org_id();
  v_value JSONB;
  v_errors JSONB;
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

  SELECT d.draft_value
    INTO v_value
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

  v_errors := public.label_designer_validate_label_design(v_value);

  RETURN jsonb_build_object(
    'ok', (jsonb_typeof(v_errors) = 'array' AND jsonb_array_length(v_errors) = 0),
    'errors', COALESCE(v_errors, '[]'::jsonb)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.label_designer_publish_label_design_draft(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.label_designer_publish_label_design_draft(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.label_designer_publish_label_design_draft(UUID, TEXT) TO service_role;

REVOKE ALL ON FUNCTION public.label_designer_validate_label_design_draft(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.label_designer_validate_label_design_draft(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.label_designer_validate_label_design_draft(UUID) TO service_role;

COMMIT;
