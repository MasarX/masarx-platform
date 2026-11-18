-- pgTAP: Console V2 workflow run trigger writes use canonical workflows.write.
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(6);

SELECT ok(
  position(
    'assert_capability_v1(''workflows.write''' IN pg_get_functiondef(
      'public.ui_create_workflow_run_trigger_v1(uuid,uuid,text[],jsonb,boolean,text,uuid)'::regprocedure
    )
  ) > 0,
  'public ui_create_workflow_run_trigger_v1 asserts workflows.write'
);

SELECT ok(
  'api.ui_create_workflow_run_trigger_v1(uuid,uuid,text[],jsonb,boolean,text,uuid)'::regprocedure IS NOT NULL,
  'api wrapper exists for browser-safe workflow run trigger creation'
);

SELECT ok(
  pg_get_functiondef(
    'public.ui_create_workflow_run_trigger_v1(uuid,uuid,text[],jsonb,boolean,text,uuid)'::regprocedure
  ) LIKE '%v_scope_type = ''platform''%'
  AND pg_get_functiondef(
    'public.ui_create_workflow_run_trigger_v1(uuid,uuid,text[],jsonb,boolean,text,uuid)'::regprocedure
  ) LIKE '%v_scope_type := ''tenant''%'
  AND pg_get_functiondef(
    'public.ui_create_workflow_run_trigger_v1(uuid,uuid,text[],jsonb,boolean,text,uuid)'::regprocedure
  ) LIKE '%public.current_user_org_id()%',
  'public ui_create_workflow_run_trigger_v1 normalizes platform actors to tenant trigger scope'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'workflow_run_triggers'
      AND policyname IN (
        'workflow_run_triggers_authenticated_insert',
        'workflow_run_triggers_authenticated_update',
        'workflow_run_triggers_authenticated_delete'
      )
      AND (
        coalesce(qual, '') LIKE '%workflow_runs.write%'
        OR coalesce(with_check, '') LIKE '%workflow_runs.write%'
      )
  ),
  'workflow_run_triggers write policies no longer use workflow_runs.write'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.settings s
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value->'resources', '[]'::jsonb)) AS resource(value)
    LEFT JOIN LATERAL jsonb_array_elements(COALESCE(resource.value->'columns', '[]'::jsonb)) AS column_row(value) ON true
    WHERE s.category = 'ui_read_registry'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
      AND resource.value->>'key' = 'workflow_run_triggers'
      AND (
        resource.value->>'capability_write' = 'workflow_runs.write'
        OR column_row.value->>'edit_permission' = 'workflow_runs.write'
      )
  ),
  'workflow_run_triggers ui_read_registry no longer exposes workflow_runs.write'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings s
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value->'resources', '[]'::jsonb)) AS resource(value)
    WHERE s.category = 'ui_read_registry'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
      AND resource.value->>'key' = 'workflow_run_triggers'
      AND resource.value->>'capability_write' = 'workflows.write'
  ),
  'workflow_run_triggers ui_read_registry exposes workflows.write'
);

SELECT * FROM finish();
ROLLBACK;
