-- Console V2 workflow template studio reads a consolidated template projection.
-- Keeps workflow_template_steps editable through canonical RPCs, but prevents
-- the frontend from stitching paginated raw step rows for the main canvas.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605041825_console_v2_workflow_templates_steps_projection_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE VIEW public.workflow_templates_console_v1
WITH (security_invoker = true) AS
WITH version_history AS (
  SELECT
    wt_inner.name,
    jsonb_agg((wt_inner.version)::text ORDER BY wt_inner.version DESC) AS versions
  FROM public.workflow_templates wt_inner
  GROUP BY wt_inner.name
),
steps AS (
  SELECT
    wts.workflow_template_id,
    jsonb_agg(
      jsonb_build_object(
        'id', wts.id,
        'workflow_template_id', wts.workflow_template_id,
        'sequence_order', wts.sequence_order,
        'operation_name', wts.operation_name,
        'operation_settings_category', wts.operation_settings_category,
        'transition_condition', wts.transition_condition,
        'condition_jsonlogic', wts.condition_jsonlogic,
        'next_operation_name', wts.next_operation_name,
        'next_operation_priority', wts.next_operation_priority,
        'next_operation_delay_seconds', wts.next_operation_delay_seconds,
        'manual_action_required', wts.manual_action_required,
        'metadata', COALESCE(wts.metadata, '{}'::jsonb),
        'enabled', wts.enabled,
        'created_at', wts.created_at,
        'updated_at', wts.updated_at,
        'handler_key', wts.handler_key,
        'handler_version', wts.handler_version
      )
      ORDER BY wts.sequence_order ASC, wts.created_at ASC, wts.id ASC
    ) AS steps
  FROM public.workflow_template_steps wts
  GROUP BY wts.workflow_template_id
)
SELECT
  wt.id,
  wt.name,
  wt.description,
  wt.version,
  wt.status,
  wt.scope_type,
  wt.scope_id,
  wt.created_by,
  wt.created_at,
  wt.published_at,
  wt.retired_at,
  wt.notes,
  wt.steps_checksum,
  wt.updated_at,
  wt.metadata,
  wt.template_key,
  COALESCE(wt.template_key, wt.name, wt.id::text) AS template_id,
  COALESCE(
    wt.metadata->>'trigger_event',
    wt.metadata->>'binding_key',
    wt.metadata->>'source_template_name',
    wt.template_key,
    wt.name
  ) AS trigger,
  COALESCE(vh.versions, jsonb_build_array((wt.version)::text)) AS versions,
  COALESCE(s.steps, '[]'::jsonb) AS steps
FROM public.workflow_templates wt
LEFT JOIN version_history vh
  ON vh.name = wt.name
LEFT JOIN steps s
  ON s.workflow_template_id = wt.id;

REVOKE ALL ON public.workflow_templates_console_v1 FROM PUBLIC;
REVOKE ALL ON public.workflow_templates_console_v1 FROM anon;
GRANT SELECT ON public.workflow_templates_console_v1 TO authenticated, service_role;

DO $$
DECLARE
  v_current JSONB;
  v_previous_version INT;
  v_next_version_id UUID := gen_random_uuid();
  v_next JSONB;
  v_resource JSONB := '{
    "key": "workflow_templates",
    "label": "Workflow templates",
    "relation": "public.workflow_templates_console_v1",
    "id_column": "id",
    "capability_read": "workflows.read",
    "capability_write": "workflows.write",
    "default_sort": { "column": "created_at", "direction": "desc" },
    "filters": [
      { "key": "status", "column": "status", "op": "eq" },
      { "key": "scope_type", "column": "scope_type", "op": "eq" },
      { "key": "name", "column": "name", "op": "ilike" }
    ],
    "related": [
      {
        "label": "Steps",
        "resource": "workflow_template_steps",
        "from": "id",
        "filter_key": "workflow_template_id",
        "limit": 200
      }
    ],
    "import": {
      "enabled": true,
      "capability": "workflows.write",
      "accepted_formats": ["csv", "xls", "xlsx"],
      "default_write_mode": "create",
      "allow_upsert": false,
      "identity_columns": []
    }
  }'::jsonb;
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
    COALESCE(jsonb_agg(resource_row.value), '[]'::jsonb) || jsonb_build_array(v_resource),
    TRUE
  )
    INTO v_next
    FROM jsonb_array_elements(COALESCE(v_current->'resources', '[]'::jsonb)) AS resource_row(value)
   WHERE resource_row.value->>'key' <> 'workflow_templates';

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
    'Route Console V2 workflow template studio through consolidated template-step projection',
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
END $$;

SELECT pg_advisory_unlock(hashtext('202605041825_console_v2_workflow_templates_steps_projection_v1'));

COMMIT;
