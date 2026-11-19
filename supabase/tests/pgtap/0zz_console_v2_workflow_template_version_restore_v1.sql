-- pgTAP: Console V2 workflow template version diff + restore contract.
-- Guards Template Studio diff/restore readback without introducing a version
-- table: restore copies canonical workflow_template_steps from source lineage.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(25);

DO $$
DECLARE
  v_org uuid := '00000000-0000-0000-0000-00000000ca10';
  v_ops uuid := '00000000-0000-0000-0000-00000000ca11';
  v_source_template uuid := '00000000-0000-0000-0000-00000000ca12';
  v_current_template uuid := '00000000-0000-0000-0000-00000000ca13';
  v_source_step uuid := '00000000-0000-0000-0000-00000000ca14';
  v_current_step uuid := '00000000-0000-0000-0000-00000000ca15';
  v_other_org uuid := '00000000-0000-0000-0000-00000000ca16';
  v_other_template uuid := '00000000-0000-0000-0000-00000000ca17';
  v_other_step uuid := '00000000-0000-0000-0000-00000000ca18';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES
    (v_org, 'Console V2 Workflow Restore Org', 'console-v2-workflow-restore-org'),
    (v_other_org, 'Console V2 Workflow Restore Other Org', 'console-v2-workflow-restore-other-org')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (
    id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id
  )
  VALUES (
    v_ops,
    v_org,
    'console-v2-workflow-restore-ops@example.com',
    'Console V2 Workflow Restore Ops',
    'ops_admin',
    'tenant',
    NULL
  )
  ON CONFLICT (id) DO UPDATE
     SET organization_id = EXCLUDED.organization_id,
         user_type = EXCLUDED.user_type,
         access_scope_type = EXCLUDED.access_scope_type,
         access_scope_id = EXCLUDED.access_scope_id;

  INSERT INTO public.workflow_templates (
    id, name, description, status, version, scope_type, scope_id, created_by, metadata
  )
  VALUES
    (
      v_source_template,
      'Console V2 Restore Source ' || left(v_source_template::text, 8),
      'Source template for Console V2 restore pgTAP.',
      'archived',
      1,
      'tenant',
      v_org,
      v_ops,
      jsonb_build_object('trigger_event', 'shipment.created')
    ),
    (
      v_current_template,
      'Console V2 Restore Current ' || left(v_current_template::text, 8),
      'Current template restored from source in Console V2.',
      'draft',
      2,
      'tenant',
      v_org,
      v_ops,
      jsonb_build_object('source_template_id', v_source_template::text, 'source_version', '1')
    ),
    (
      v_other_template,
      'Console V2 Restore Other Tenant ' || left(v_other_template::text, 8),
      'Other tenant source must not be diffable or restorable.',
      'archived',
      1,
      'tenant',
      v_other_org,
      v_ops,
      jsonb_build_object('trigger_event', 'shipment.created')
    )
  ON CONFLICT (id) DO UPDATE
     SET status = EXCLUDED.status,
         version = EXCLUDED.version,
         scope_type = EXCLUDED.scope_type,
         scope_id = EXCLUDED.scope_id,
         metadata = EXCLUDED.metadata,
         steps_checksum = NULL;

  INSERT INTO public.workflow_template_steps (
    id,
    workflow_template_id,
    sequence_order,
    operation_name,
    operation_settings_category,
    handler_key,
    handler_version,
    transition_condition,
    condition_jsonlogic,
    metadata,
    enabled
  )
  VALUES
    (
      v_source_step,
      v_source_template,
      1,
      'webhook.receive',
      'workflow_binding_noop',
      'workflow_binding_noop',
      'v1',
      'success',
      '{}'::jsonb,
      jsonb_build_object('kind', 'trigger', 'label', 'Restore source trigger'),
      true
    ),
    (
      v_current_step,
      v_current_template,
      1,
      'webhook.receive',
      'workflow_binding_noop',
      'workflow_binding_noop',
      'v1',
      'success',
      '{}'::jsonb,
      jsonb_build_object('kind', 'trigger', 'label', 'Restore current trigger before restore'),
      true
    ),
    (
      v_other_step,
      v_other_template,
      1,
      'webhook.receive',
      'workflow_binding_noop',
      'workflow_binding_noop',
      'v1',
      'success',
      '{}'::jsonb,
      jsonb_build_object('kind', 'trigger', 'label', 'Other restore trigger'),
      true
    )
  ON CONFLICT (id) DO UPDATE
     SET workflow_template_id = EXCLUDED.workflow_template_id,
         sequence_order = EXCLUDED.sequence_order,
         operation_name = EXCLUDED.operation_name,
         operation_settings_category = EXCLUDED.operation_settings_category,
         handler_key = EXCLUDED.handler_key,
         handler_version = EXCLUDED.handler_version,
         transition_condition = EXCLUDED.transition_condition,
         condition_jsonlogic = EXCLUDED.condition_jsonlogic,
         metadata = EXCLUDED.metadata,
         enabled = EXCLUDED.enabled;

  PERFORM set_config('test.workflow_restore_org', v_org::text, true);
  PERFORM set_config('test.workflow_restore_ops', v_ops::text, true);
  PERFORM set_config('test.workflow_restore_source_template', v_source_template::text, true);
  PERFORM set_config('test.workflow_restore_current_template', v_current_template::text, true);
  PERFORM set_config('test.workflow_restore_source_step', v_source_step::text, true);
  PERFORM set_config('test.workflow_restore_current_step', v_current_step::text, true);
  PERFORM set_config('test.workflow_restore_other_template', v_other_template::text, true);

  EXECUTE 'RESET ROLE';
END $$;

SELECT has_function(
  'public',
  'workflow_template_version_diff_v1',
  ARRAY['jsonb'],
  'public.workflow_template_version_diff_v1(jsonb) exists'
);
SELECT has_function(
  'api',
  'workflow_template_version_diff_v1',
  ARRAY['jsonb'],
  'api.workflow_template_version_diff_v1(jsonb) exists'
);
SELECT has_function(
  'public',
  'restore_workflow_template_v1',
  ARRAY['jsonb'],
  'public.restore_workflow_template_v1(jsonb) exists'
);
SELECT has_function(
  'api',
  'restore_workflow_template_v1',
  ARRAY['jsonb'],
  'api.restore_workflow_template_v1(jsonb) exists'
);

SELECT ok(
  NOT has_function_privilege('anon', 'api.workflow_template_version_diff_v1(jsonb)', 'EXECUTE'),
  'anon cannot execute api.workflow_template_version_diff_v1'
);
SELECT ok(
  NOT has_function_privilege('anon', 'api.restore_workflow_template_v1(jsonb)', 'EXECUTE'),
  'anon cannot execute api.restore_workflow_template_v1'
);
SELECT ok(
  has_function_privilege('authenticated', 'api.workflow_template_version_diff_v1(jsonb)', 'EXECUTE'),
  'authenticated can execute api.workflow_template_version_diff_v1'
);
SELECT ok(
  has_function_privilege('authenticated', 'api.restore_workflow_template_v1(jsonb)', 'EXECUTE'),
  'authenticated can execute api.restore_workflow_template_v1'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.workflow_restore_ops'), true);
SET LOCAL ROLE authenticated;

WITH diff_result AS (
  SELECT api.workflow_template_version_diff_v1(jsonb_build_object(
    'workflow_template_id', current_setting('test.workflow_restore_current_template'),
    'source_workflow_template_id', current_setting('test.workflow_restore_source_template')
  )) AS result
)
SELECT
  is(result->>'ok', 'true', 'diff returns ok envelope'),
  is(result->>'current_step_count', '1', 'diff returns current active step count'),
  is(result->>'source_step_count', '1', 'diff returns source active step count'),
  is(jsonb_array_length(result->'modified_steps')::text, '1', 'diff reports modified step from backend comparison')
FROM diff_result;

SELECT throws_ok(
  $$ SELECT api.workflow_template_version_diff_v1(jsonb_build_object(
    'workflow_template_id', current_setting('test.workflow_restore_current_template'),
    'source_workflow_template_id', current_setting('test.workflow_restore_other_template')
  )) $$,
  '42501',
  'workflow_template_version_diff_v1 source workflow_template 00000000-0000-0000-0000-00000000ca17 outside caller scope',
  'diff denies other-tenant source template'
);

SELECT throws_ok(
  $$ SELECT api.restore_workflow_template_v1(jsonb_build_object(
    'workflow_template_id', current_setting('test.workflow_restore_current_template'),
    'source_workflow_template_id', current_setting('test.workflow_restore_other_template')
  )) $$,
  '42501',
  'restore_workflow_template_v1 source workflow_template 00000000-0000-0000-0000-00000000ca17 outside caller scope',
  'restore denies other-tenant source template'
);

WITH restored AS (
  SELECT api.restore_workflow_template_v1(jsonb_build_object(
    'workflow_template_id', current_setting('test.workflow_restore_current_template'),
    'source_workflow_template_id', current_setting('test.workflow_restore_source_template'),
    'reason', 'pgTAP Console V2 version restore'
  )) AS result
)
SELECT
  set_config('test.workflow_restore_correlation', result->>'correlation_id', true),
  set_config('test.workflow_restore_restored_version', result->>'restored_version', true),
  set_config('test.workflow_restore_prior_version', result->>'prior_version', true)
FROM restored;

RESET ROLE;

SELECT ok(
  current_setting('test.workflow_restore_correlation', true) IS NOT NULL,
  'restore returns backend correlation id'
);

SELECT is(
  (
    SELECT version::text
      FROM public.workflow_templates
     WHERE id = current_setting('test.workflow_restore_current_template')::uuid
  ),
  current_setting('test.workflow_restore_restored_version'),
  'restore returns final backend workflow template version'
);

SELECT ok(
  (
    SELECT version
      FROM public.workflow_templates
     WHERE id = current_setting('test.workflow_restore_current_template')::uuid
  ) > current_setting('test.workflow_restore_prior_version')::integer,
  'restore increments workflow template version'
);

SELECT is(
  (
    SELECT count(*)::text
      FROM public.workflow_template_steps
     WHERE workflow_template_id = current_setting('test.workflow_restore_current_template')::uuid
       AND COALESCE(enabled, TRUE) = TRUE
  ),
  '1',
  'restore leaves exactly one active copied source step'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.workflow_template_steps
     WHERE id = current_setting('test.workflow_restore_current_step')::uuid
       AND enabled = FALSE
       AND metadata->>'disabled_by_restore' = 'true'
  ),
  'restore disables prior active step for lineage'
);

SELECT is(
  (
    SELECT d.step_count::text
      FROM public.v_workflow_template_directory d
     WHERE d.workflow_template_id = current_setting('test.workflow_restore_current_template')::uuid
  ),
  '1',
  'directory projection exposes active restored step count'
);

SELECT is(
  (
    SELECT step.metadata->>'label'
      FROM public.workflow_template_steps step
     WHERE step.workflow_template_id = current_setting('test.workflow_restore_current_template')::uuid
       AND COALESCE(step.enabled, TRUE) = TRUE
     ORDER BY step.sequence_order
     LIMIT 1
  ),
  'Restore source trigger',
  'restore copies source step metadata into active template'
);

SELECT ok(
  (
    SELECT step.metadata->>'restored_from_template_step_id'
      FROM public.workflow_template_steps step
     WHERE step.workflow_template_id = current_setting('test.workflow_restore_current_template')::uuid
       AND COALESCE(step.enabled, TRUE) = TRUE
     ORDER BY step.sequence_order
     LIMIT 1
  ) = current_setting('test.workflow_restore_source_step'),
  'restore records source step lineage on copied step'
);

SELECT ok(
  (
    SELECT steps_checksum IS NOT NULL
      FROM public.workflow_templates
     WHERE id = current_setting('test.workflow_restore_current_template')::uuid
  ),
  'restore recomputes template checksum'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.decision_log dl
     WHERE dl.resource_type = 'workflow_template'
       AND dl.resource_id = current_setting('test.workflow_restore_current_template')::uuid
       AND dl.decision_category = 'workflows.template_restore'
       AND dl.decision_point = 'restore_workflow_template_v1'
       AND dl.decision_outcome = 'restored'
       AND dl.correlation_id = current_setting('test.workflow_restore_correlation')::uuid
  ),
  'restore writes decision_log lineage with correlation'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.domain_events de
     WHERE de.resource_type = 'workflow_template'
       AND de.resource_id = current_setting('test.workflow_restore_current_template')::uuid
       AND de.event_type = 'workflow_template.restored'
       AND de.correlation_id = current_setting('test.workflow_restore_correlation')::uuid
  ),
  'restore writes domain event lineage with correlation'
);

SELECT * FROM finish();
ROLLBACK;
