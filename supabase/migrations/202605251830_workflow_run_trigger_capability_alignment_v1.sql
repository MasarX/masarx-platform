BEGIN;

SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.ui_create_workflow_run_trigger_v1(
  p_source_workflow_template_id UUID,
  p_target_workflow_template_id UUID,
  p_source_statuses TEXT[] DEFAULT NULL,
  p_context_patch JSONB DEFAULT '{}'::jsonb,
  p_enabled BOOLEAN DEFAULT TRUE,
  p_notes TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $$
DECLARE
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_trigger_id UUID;
BEGIN
  IF p_source_workflow_template_id IS NULL THEN
    RAISE EXCEPTION 'ui_create_workflow_run_trigger_v1 requires source_workflow_template_id';
  END IF;
  IF p_target_workflow_template_id IS NULL THEN
    RAISE EXCEPTION 'ui_create_workflow_run_trigger_v1 requires target_workflow_template_id';
  END IF;

  PERFORM public.assert_capability_v1('workflows.write', v_scope_type, v_scope_id);

  INSERT INTO public.workflow_run_triggers (
    scope_type,
    scope_id,
    source_workflow_template_id,
    target_workflow_template_id,
    source_statuses,
    context_patch,
    enabled,
    created_by,
    notes
  )
  VALUES (
    v_scope_type,
    v_scope_id,
    p_source_workflow_template_id,
    p_target_workflow_template_id,
    COALESCE(p_source_statuses, ARRAY['completed']::TEXT[]),
    COALESCE(p_context_patch, '{}'::jsonb),
    COALESCE(p_enabled, TRUE),
    auth.uid(),
    NULLIF(btrim(COALESCE(p_notes, '')), '')
  )
  RETURNING id INTO v_trigger_id;

  RETURN jsonb_build_object(
    'status', 'ok',
    'workflow_run_trigger_id', v_trigger_id::text
  );
END;
$$;

REVOKE ALL ON FUNCTION public.ui_create_workflow_run_trigger_v1(UUID, UUID, TEXT[], JSONB, BOOLEAN, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_create_workflow_run_trigger_v1(UUID, UUID, TEXT[], JSONB, BOOLEAN, TEXT) TO authenticated, service_role;

COMMENT ON FUNCTION public.ui_create_workflow_run_trigger_v1(UUID, UUID, TEXT[], JSONB, BOOLEAN, TEXT)
  IS 'Creates workflow run triggers through Console V2. Capability: workflows.write.';

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;
GRANT USAGE ON SCHEMA api TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.ui_create_workflow_run_trigger_v1(
  p_source_workflow_template_id UUID,
  p_target_workflow_template_id UUID,
  p_source_statuses TEXT[] DEFAULT NULL,
  p_context_patch JSONB DEFAULT '{}'::jsonb,
  p_enabled BOOLEAN DEFAULT TRUE,
  p_notes TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $wrapper$
  SELECT public.ui_create_workflow_run_trigger_v1(
    p_source_workflow_template_id,
    p_target_workflow_template_id,
    p_source_statuses,
    COALESCE(p_context_patch, '{}'::jsonb),
    COALESCE(p_enabled, TRUE),
    p_notes
  );
$wrapper$;

REVOKE ALL ON FUNCTION api.ui_create_workflow_run_trigger_v1(UUID, UUID, TEXT[], JSONB, BOOLEAN, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.ui_create_workflow_run_trigger_v1(UUID, UUID, TEXT[], JSONB, BOOLEAN, TEXT) TO authenticated, service_role;

COMMENT ON FUNCTION api.ui_create_workflow_run_trigger_v1(UUID, UUID, TEXT[], JSONB, BOOLEAN, TEXT)
  IS 'API-schema wrapper for Console V2 workflow run trigger creation. Capability: workflows.write.';

DROP POLICY IF EXISTS workflow_run_triggers_authenticated_insert ON public.workflow_run_triggers;
CREATE POLICY workflow_run_triggers_authenticated_insert
  ON public.workflow_run_triggers
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.user_has_capability_v1('workflows.write')
    AND public.workflow_template_scope_allowed(scope_type, scope_id)
    AND EXISTS (
      SELECT 1
      FROM public.workflow_templates wt
      WHERE wt.id = workflow_run_triggers.source_workflow_template_id
        AND public.workflow_template_scope_allowed(wt.scope_type, wt.scope_id)
    )
    AND EXISTS (
      SELECT 1
      FROM public.workflow_templates wt
      WHERE wt.id = workflow_run_triggers.target_workflow_template_id
        AND public.workflow_template_scope_allowed(wt.scope_type, wt.scope_id)
    )
  );

DROP POLICY IF EXISTS workflow_run_triggers_authenticated_update ON public.workflow_run_triggers;
CREATE POLICY workflow_run_triggers_authenticated_update
  ON public.workflow_run_triggers
  FOR UPDATE
  TO authenticated
  USING (
    public.user_has_capability_v1('workflows.write')
    AND public.workflow_template_scope_allowed(scope_type, scope_id)
  )
  WITH CHECK (
    public.user_has_capability_v1('workflows.write')
    AND public.workflow_template_scope_allowed(scope_type, scope_id)
    AND EXISTS (
      SELECT 1
      FROM public.workflow_templates wt
      WHERE wt.id = workflow_run_triggers.source_workflow_template_id
        AND public.workflow_template_scope_allowed(wt.scope_type, wt.scope_id)
    )
    AND EXISTS (
      SELECT 1
      FROM public.workflow_templates wt
      WHERE wt.id = workflow_run_triggers.target_workflow_template_id
        AND public.workflow_template_scope_allowed(wt.scope_type, wt.scope_id)
    )
  );

DROP POLICY IF EXISTS workflow_run_triggers_authenticated_delete ON public.workflow_run_triggers;
CREATE POLICY workflow_run_triggers_authenticated_delete
  ON public.workflow_run_triggers
  FOR DELETE
  TO authenticated
  USING (
    public.user_has_capability_v1('workflows.write')
    AND public.workflow_template_scope_allowed(scope_type, scope_id)
  );

DO $$
DECLARE
  v_current JSONB;
  v_next JSONB;
  v_previous_version INTEGER;
  v_next_version_id UUID := gen_random_uuid();
BEGIN
  SELECT s.cached_value, sv.version
    INTO v_current, v_previous_version
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'ui_read_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'ui_read_registry global settings missing';
  END IF;

  SELECT jsonb_set(
    COALESCE(v_current, '{"resources":[]}'::jsonb),
    '{resources}',
    COALESCE(
      jsonb_agg(
        CASE
          WHEN resource.value->>'key' = 'workflow_run_triggers' THEN
            jsonb_set(
              jsonb_set(resource.value, '{capability_write}', to_jsonb('workflows.write'::text), true),
              '{columns}',
              COALESCE(
                (
                  SELECT jsonb_agg(
                    CASE
                      WHEN column_value->>'edit_permission' = 'workflow_runs.write' THEN
                        jsonb_set(column_value, '{edit_permission}', to_jsonb('workflows.write'::text), true)
                      ELSE column_value
                    END
                  )
                  FROM jsonb_array_elements(COALESCE(resource.value->'columns', '[]'::jsonb)) AS column_row(column_value)
                ),
                '[]'::jsonb
              ),
              true
            )
          ELSE resource.value
        END
      ),
      '[]'::jsonb
    ),
    true
  )
    INTO v_next
    FROM jsonb_array_elements(COALESCE(v_current->'resources', '[]'::jsonb)) AS resource(value);

  IF v_next IS DISTINCT FROM v_current THEN
    UPDATE public.settings_versions
       SET effective_until = COALESCE(effective_until, now()),
           updated_at = DEFAULT
     WHERE category = 'ui_read_registry'
       AND scope_type = 'global'
       AND scope_id IS NULL
       AND effective_until IS NULL;

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
      approved_at,
      effective_from
    )
    VALUES (
      v_next_version_id,
      'ui_read_registry',
      'global',
      NULL,
      '00000000-0000-0000-0000-000000000000'::uuid,
      COALESCE(v_previous_version, 0) + 1,
      v_next,
      NULL,
      'Align workflow run trigger write registry with workflows.write',
      now(),
      now()
    );

    UPDATE public.settings
       SET settings_version_id = v_next_version_id,
           cached_value = v_next,
           last_updated = now(),
           updated_at = DEFAULT
     WHERE category = 'ui_read_registry'
       AND scope_type = 'global'
       AND scope_id IS NULL;
  END IF;
END $$;

COMMIT;
