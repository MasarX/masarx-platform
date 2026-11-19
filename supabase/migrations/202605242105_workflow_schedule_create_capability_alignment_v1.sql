BEGIN;

SET search_path TO public, extensions, pg_temp;

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES (
  'workflow_schedule_type',
  'Workflow schedule trigger type taxonomy for Console V2 schedule authoring.',
  'engineering',
  'tier_1',
  false
)
ON CONFLICT (category) DO UPDATE
SET
  description = EXCLUDED.description,
  owner_role = EXCLUDED.owner_role,
  approval_policy = EXCLUDED.approval_policy,
  is_mutable = EXCLUDED.is_mutable,
  updated_at = now();

WITH lookup_rows AS (
  SELECT *
  FROM (
    VALUES
      (
        'interval',
        'Interval',
        'Run at a fixed second interval.',
        10,
        true,
        '{"tone":"info","summary_template":"every","thresholds":{"hour_seconds":3600,"minute_seconds":60}}'::jsonb
      ),
      (
        'daily',
        'Daily',
        'Run once per day at a configured local time.',
        20,
        false,
        '{"tone":"info","summary_template":"daily"}'::jsonb
      ),
      (
        'weekly',
        'Weekly',
        'Run on selected weekdays at a configured local time.',
        30,
        false,
        '{"tone":"info","summary_template":"weekly"}'::jsonb
      ),
      (
        'cron',
        'Cron',
        'Run from a cron expression.',
        40,
        false,
        '{"tone":"neutral","summary_template":"cron"}'::jsonb
      )
  ) AS v(value, label, description, sort_order, is_default, metadata)
)
INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  description,
  sort_order,
  is_default,
  status,
  metadata
)
SELECT
  d.id,
  r.value,
  r.label,
  r.description,
  r.sort_order,
  r.is_default,
  'active',
  r.metadata
FROM public.lookup_definitions d
JOIN lookup_rows r
  ON d.category = 'workflow_schedule_type'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  is_default = EXCLUDED.is_default,
  status = 'active',
  effective_until = NULL,
  retired_at = NULL,
  metadata = EXCLUDED.metadata,
  updated_at = now();

CREATE OR REPLACE FUNCTION public.ui_create_workflow_schedule_trigger_v1(
  p_workflow_template_id UUID,
  p_schedule JSONB,
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
  IF p_workflow_template_id IS NULL THEN
    RAISE EXCEPTION 'ui_create_workflow_schedule_trigger_v1 requires workflow_template_id';
  END IF;

  PERFORM public.assert_capability_v1('workflows.write', v_scope_type, v_scope_id);

  INSERT INTO public.workflow_schedule_triggers (
    scope_type,
    scope_id,
    workflow_template_id,
    schedule,
    context_patch,
    enabled,
    created_by,
    notes
  )
  VALUES (
    v_scope_type,
    v_scope_id,
    p_workflow_template_id,
    COALESCE(p_schedule, '{}'::jsonb),
    COALESCE(p_context_patch, '{}'::jsonb),
    COALESCE(p_enabled, TRUE),
    auth.uid(),
    NULLIF(btrim(COALESCE(p_notes, '')), '')
  )
  RETURNING id INTO v_trigger_id;

  RETURN jsonb_build_object(
    'status', 'ok',
    'workflow_schedule_trigger_id', v_trigger_id::text
  );
END;
$$;

REVOKE ALL ON FUNCTION public.ui_create_workflow_schedule_trigger_v1(UUID, JSONB, JSONB, BOOLEAN, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_create_workflow_schedule_trigger_v1(UUID, JSONB, JSONB, BOOLEAN, TEXT) TO authenticated, service_role;

COMMENT ON FUNCTION public.ui_create_workflow_schedule_trigger_v1(UUID, JSONB, JSONB, BOOLEAN, TEXT)
  IS 'Creates workflow schedule triggers through Console V2. Capability: workflows.write.';

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;
GRANT USAGE ON SCHEMA api TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.ui_create_workflow_schedule_trigger_v1(
  p_workflow_template_id UUID,
  p_schedule JSONB,
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
  SELECT public.ui_create_workflow_schedule_trigger_v1(
    p_workflow_template_id,
    p_schedule,
    COALESCE(p_context_patch, '{}'::jsonb),
    COALESCE(p_enabled, TRUE),
    p_notes
  );
$wrapper$;

REVOKE ALL ON FUNCTION api.ui_create_workflow_schedule_trigger_v1(UUID, JSONB, JSONB, BOOLEAN, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.ui_create_workflow_schedule_trigger_v1(UUID, JSONB, JSONB, BOOLEAN, TEXT) TO authenticated, service_role;

COMMENT ON FUNCTION api.ui_create_workflow_schedule_trigger_v1(UUID, JSONB, JSONB, BOOLEAN, TEXT)
  IS 'API-schema wrapper for Console V2 workflow schedule trigger creation. Capability: workflows.write.';

DROP POLICY IF EXISTS workflow_schedule_triggers_authenticated_insert ON public.workflow_schedule_triggers;
CREATE POLICY workflow_schedule_triggers_authenticated_insert
  ON public.workflow_schedule_triggers
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.user_has_capability_v1('workflows.write')
    AND public.workflow_template_scope_allowed(scope_type, scope_id)
    AND EXISTS (
      SELECT 1
      FROM public.workflow_templates wt
      WHERE wt.id = workflow_schedule_triggers.workflow_template_id
        AND public.workflow_template_scope_allowed(wt.scope_type, wt.scope_id)
    )
  );

DROP POLICY IF EXISTS workflow_schedule_triggers_authenticated_update ON public.workflow_schedule_triggers;
CREATE POLICY workflow_schedule_triggers_authenticated_update
  ON public.workflow_schedule_triggers
  FOR UPDATE
  TO authenticated
  USING (
    public.user_has_capability_v1('workflows.write')
    AND public.workflow_template_scope_allowed(scope_type, scope_id)
  )
  WITH CHECK (
    public.user_has_capability_v1('workflows.write')
    AND public.workflow_template_scope_allowed(scope_type, scope_id)
  );

DROP POLICY IF EXISTS workflow_schedule_triggers_authenticated_delete ON public.workflow_schedule_triggers;
CREATE POLICY workflow_schedule_triggers_authenticated_delete
  ON public.workflow_schedule_triggers
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
          WHEN resource.value->>'key' = 'workflow_schedule_triggers' THEN
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
      'Align workflow schedule trigger write registry with workflows.write',
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
