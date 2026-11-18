-- pgTAP: Console V2 workflow template clone + activate readback contract.
-- Guards the operator-visible Template Studio promotion card:
-- create clone -> activate -> directory/audit/event readback.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(16);

DO $$
DECLARE
  v_org uuid := '00000000-0000-0000-0000-00000000c901';
  v_ops uuid := '00000000-0000-0000-0000-00000000c902';
  v_source_template uuid := '00000000-0000-0000-0000-00000000c903';
  v_source_step uuid := '00000000-0000-0000-0000-00000000c904';
  v_other_org uuid := '00000000-0000-0000-0000-00000000c905';
  v_other_template uuid := '00000000-0000-0000-0000-00000000c906';
  v_other_step uuid := '00000000-0000-0000-0000-00000000c907';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Console V2 Workflow Promotion Org', 'console-v2-workflow-promotion-org')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_other_org, 'Console V2 Workflow Promotion Other Org', 'console-v2-workflow-promotion-other-org')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (
    id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id
  )
  VALUES (
    v_ops,
    v_org,
    'console-v2-workflow-promotion-ops@example.com',
    'Console V2 Workflow Promotion Ops',
    'ops_admin',
    'tenant',
    NULL
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.workflow_templates (
    id, name, description, status, version, scope_type, scope_id, created_by, metadata
  )
  VALUES (
    v_source_template,
    'Console V2 Promotion Source ' || left(v_source_template::text, 8),
    'Source template for Console V2 promotion readback pgTAP.',
    'draft',
    1,
    'tenant',
    v_org,
    v_ops,
    jsonb_build_object('trigger_event', 'shipment.created')
  )
  ON CONFLICT (id) DO UPDATE
     SET status = EXCLUDED.status,
         scope_type = EXCLUDED.scope_type,
         scope_id = EXCLUDED.scope_id,
         metadata = EXCLUDED.metadata,
         published_at = NULL;

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
  VALUES (
    v_source_step,
    v_source_template,
    1,
    'webhook.receive',
    'workflow_binding_noop',
    'workflow_binding_noop',
    'v1',
    'success',
    '{}'::jsonb,
    jsonb_build_object('kind', 'trigger', 'label', 'Promotion trigger'),
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

  INSERT INTO public.workflow_templates (
    id, name, description, status, version, scope_type, scope_id, created_by, metadata
  )
  VALUES (
    v_other_template,
    'Console V2 Promotion Other Tenant Source ' || left(v_other_template::text, 8),
    'Other-tenant source template must not be cloneable by the test tenant.',
    'draft',
    1,
    'tenant',
    v_other_org,
    v_ops,
    jsonb_build_object('trigger_event', 'shipment.created')
  )
  ON CONFLICT (id) DO UPDATE
     SET status = EXCLUDED.status,
         scope_type = EXCLUDED.scope_type,
         scope_id = EXCLUDED.scope_id,
         metadata = EXCLUDED.metadata,
         published_at = NULL;

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
  VALUES (
    v_other_step,
    v_other_template,
    1,
    'webhook.receive',
    'workflow_binding_noop',
    'workflow_binding_noop',
    'v1',
    'success',
    '{}'::jsonb,
    jsonb_build_object('kind', 'trigger', 'label', 'Other tenant promotion trigger'),
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

  PERFORM set_config('test.workflow_promotion_org', v_org::text, true);
  PERFORM set_config('test.workflow_promotion_ops', v_ops::text, true);
  PERFORM set_config('test.workflow_promotion_source_template', v_source_template::text, true);
  PERFORM set_config('test.workflow_promotion_other_template', v_other_template::text, true);

  EXECUTE 'RESET ROLE';
END $$;

SELECT set_config('request.jwt.claim.sub', current_setting('test.workflow_promotion_ops'), true);
SET LOCAL ROLE authenticated;

WITH created AS (
  SELECT api.ui_create_workflow_template_v1(jsonb_build_object(
    'name', 'Console V2 Promotion Clone ' || left(gen_random_uuid()::text, 8),
    'clone_from', current_setting('test.workflow_promotion_source_template'),
    'scope_type', 'tenant',
    'scope_id', current_setting('test.workflow_promotion_org')
  )) AS result
)
SELECT set_config(
  'test.workflow_promotion_clone_template',
  result->>'workflow_template_id',
  true
),
set_config(
  'test.workflow_promotion_clone_correlation',
  result->>'correlation_id',
  true
)
FROM created;

RESET ROLE;

SELECT ok(
  current_setting('test.workflow_promotion_clone_template', true) IS NOT NULL,
  'api.ui_create_workflow_template_v1 returns a clone template id'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.decision_log dl
     WHERE dl.resource_type = 'workflow_template'
       AND dl.resource_id = current_setting('test.workflow_promotion_clone_template')::uuid
       AND dl.decision_category = 'workflows.template_clone'
       AND dl.decision_point = 'ui_create_workflow_template_v1'
       AND dl.decision_outcome = 'cloned'
       AND dl.correlation_id = current_setting('test.workflow_promotion_clone_correlation')::uuid
  ),
  'clone writes decision_log lineage with create correlation'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.domain_events de
     WHERE de.resource_type = 'workflow_template'
       AND de.resource_id = current_setting('test.workflow_promotion_clone_template')::uuid
       AND de.event_type = 'workflow_template.cloned'
       AND de.correlation_id = current_setting('test.workflow_promotion_clone_correlation')::uuid
  ),
  'clone writes domain event lineage with create correlation'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.workflow_promotion_ops'), true);
SET LOCAL ROLE authenticated;

SELECT throws_ok(
  $$ SELECT api.ui_create_workflow_template_v1(jsonb_build_object(
    'name', 'Console V2 Forbidden Other Tenant Clone',
    'clone_from', current_setting('test.workflow_promotion_other_template'),
    'scope_type', 'tenant',
    'scope_id', current_setting('test.workflow_promotion_org')
  )) $$,
  '42501',
  'ui_create_workflow_template_v1 clone template outside caller organization',
  'tenant operator cannot clone another tenant workflow template by UUID'
);

RESET ROLE;

SELECT is(
  (
    SELECT wt.scope_id::text
      FROM public.workflow_templates wt
     WHERE wt.id = current_setting('test.workflow_promotion_clone_template')::uuid
  ),
  current_setting('test.workflow_promotion_org'),
  'clone is tenant-scoped for same-context Console readback'
);

SELECT is(
  (
    SELECT wt.metadata->>'source_template_id'
      FROM public.workflow_templates wt
     WHERE wt.id = current_setting('test.workflow_promotion_clone_template')::uuid
  ),
  current_setting('test.workflow_promotion_source_template'),
  'clone stores source_template_id lineage'
);

SELECT is(
  (
    SELECT count(*)::text
      FROM public.workflow_template_steps step
     WHERE step.workflow_template_id = current_setting('test.workflow_promotion_clone_template')::uuid
  ),
  (
    SELECT count(*)::text
      FROM public.workflow_template_steps step
     WHERE step.workflow_template_id = current_setting('test.workflow_promotion_source_template')::uuid
  ),
  'clone copies source workflow template steps'
);

SELECT is(
  (
    SELECT step.handler_key
      FROM public.workflow_template_steps step
     WHERE step.workflow_template_id = current_setting('test.workflow_promotion_clone_template')::uuid
     ORDER BY step.sequence_order ASC
     LIMIT 1
  ),
  'workflow_binding_noop',
  'clone preserves source workflow step handler_key'
);

SELECT is(
  (
    SELECT step.handler_version
      FROM public.workflow_template_steps step
     WHERE step.workflow_template_id = current_setting('test.workflow_promotion_clone_template')::uuid
     ORDER BY step.sequence_order ASC
     LIMIT 1
  ),
  'v1',
  'clone preserves source workflow step handler_version'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.v_workflow_template_directory d
     WHERE d.workflow_template_id = current_setting('test.workflow_promotion_clone_template')::uuid
       AND d.step_count = (
         SELECT count(*)
           FROM public.workflow_template_steps step
          WHERE step.workflow_template_id = current_setting('test.workflow_promotion_source_template')::uuid
       )
  ),
  'directory projection gives Console the copied-step readback count'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.workflow_promotion_ops'), true);
SET LOCAL ROLE authenticated;

WITH status_result AS (
  SELECT api.ui_set_workflow_template_status_v1(jsonb_build_object(
    'template_id', current_setting('test.workflow_promotion_clone_template'),
    'status', 'active',
    'reason', 'pgTAP Console V2 promotion readback'
  )) AS result
)
SELECT set_config(
  'test.workflow_promotion_status_correlation',
  result->>'correlation_id',
  true
)
FROM status_result;

RESET ROLE;

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.workflow_templates wt
     WHERE wt.id = current_setting('test.workflow_promotion_clone_template')::uuid
       AND wt.status = 'active'
       AND wt.published_at IS NOT NULL
  ),
  'activation sets workflow_templates status active and published_at'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.v_workflow_template_directory d
     WHERE d.workflow_template_id = current_setting('test.workflow_promotion_clone_template')::uuid
       AND d.scope_id = current_setting('test.workflow_promotion_org')::uuid
       AND d.status = 'active'
       AND d.is_published IS TRUE
  ),
  'directory projection confirms active published clone'
);

SELECT is(
  (
    SELECT d.step_count::text
      FROM public.v_workflow_template_directory d
     WHERE d.workflow_template_id = current_setting('test.workflow_promotion_clone_template')::uuid
  ),
  (
    SELECT count(*)::text
      FROM public.workflow_template_steps step
     WHERE step.workflow_template_id = current_setting('test.workflow_promotion_source_template')::uuid
  ),
  'directory projection exposes copied step count'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.workflow_template_status_changes sc
     WHERE sc.workflow_template_id = current_setting('test.workflow_promotion_clone_template')::uuid
       AND sc.prior_status = 'draft'
       AND sc.next_status = 'active'
       AND sc.correlation_id = current_setting('test.workflow_promotion_status_correlation')
  ),
  'activation writes status change lineage with correlation'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.decision_log dl
     WHERE dl.resource_type = 'workflow_template'
       AND dl.resource_id = current_setting('test.workflow_promotion_clone_template')::uuid
       AND dl.decision_category = 'workflows.template_status'
       AND dl.decision_point = 'ui_set_workflow_template_status_v1'
       AND dl.correlation_id = current_setting('test.workflow_promotion_status_correlation')::uuid
  ),
  'activation writes decision_log lineage with correlation'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.domain_events de
     WHERE de.resource_type = 'workflow_template'
       AND de.resource_id = current_setting('test.workflow_promotion_clone_template')::uuid
       AND de.event_type = 'workflow_template.status_changed'
       AND de.correlation_id = current_setting('test.workflow_promotion_status_correlation')::uuid
  ),
  'activation writes domain event lineage with correlation'
);

SELECT * FROM finish();
ROLLBACK;
