BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(10);

SELECT has_function(
  'public',
  'ui_upsert_mapping_artifact_v1',
  ARRAY['jsonb'],
  'validated Mapping Studio artifact upsert exists'
);

SELECT is(
  public.normalize_shipment_intent_v1('shipment.created', 'shipment.created'),
  'shipment.create',
  'external create alias canonicalizes before policy storage'
);

CREATE TEMP TABLE pgtap_b6_active_template (id UUID PRIMARY KEY) ON COMMIT DROP;
WITH inserted AS (
  INSERT INTO public.workflow_templates (name, status, version, scope_type, scope_id)
  VALUES ('b6_binding_active_' || left(gen_random_uuid()::text, 8), 'active', 1, 'global', NULL)
  RETURNING id
)
INSERT INTO pgtap_b6_active_template (id) SELECT id FROM inserted;
SELECT is(
  public.resolve_active_workflow_template_ref_v1((SELECT id::text FROM pgtap_b6_active_template)),
  (SELECT id FROM pgtap_b6_active_template),
  'active UUID reference resolves'
);

WITH fixture AS (
  INSERT INTO public.workflow_templates (name, status, version, scope_type, scope_id)
  VALUES ('b6_binding_draft_' || left(gen_random_uuid()::text, 8), 'draft', 1, 'global', NULL)
  RETURNING id
)
SELECT is(
  public.resolve_active_workflow_template_ref_v1((SELECT id::text FROM fixture)),
  NULL::UUID,
  'draft UUID reference fails closed'
);

SELECT is(
  public.resolve_active_workflow_template_ref_v1(gen_random_uuid()::text),
  NULL::UUID,
  'missing UUID reference fails closed'
);

CREATE TEMP TABLE pgtap_b6_policy_template (id UUID PRIMARY KEY) ON COMMIT DROP;
WITH inserted AS (
  INSERT INTO public.workflow_templates (name, status, version, scope_type, scope_id)
  VALUES ('b6_binding_policy_' || left(gen_random_uuid()::text, 8), 'active', 1, 'global', NULL)
  RETURNING id
)
INSERT INTO pgtap_b6_policy_template (id) SELECT id FROM inserted;
SELECT is(
  public.resolve_webhook_followup_template_id_v1(
    jsonb_build_object(
      'workflow',
      jsonb_build_object(
        'templates_by_intent',
        jsonb_build_object('shipment.create', jsonb_build_object('template_id', (SELECT id FROM pgtap_b6_policy_template)))
      )
    ),
    'shipment.create'
  ),
  (SELECT id FROM pgtap_b6_policy_template),
  'canonical policy key is consumed by the runtime resolver'
);

SELECT matches(
  pg_get_functiondef('public.ui_upsert_mapping_artifact_v1(jsonb)'::regprocedure),
  'workflow_template_scope_allowed',
  'artifact upsert validates caller workflow scope'
);
SELECT matches(
  pg_get_functiondef('public.ui_upsert_mapping_artifact_v1(jsonb)'::regprocedure),
  'v_workflow_template_status IS DISTINCT FROM ''active''',
  'artifact upsert rejects inactive supplied templates'
);
SELECT matches(
  pg_get_functiondef('public.ui_upsert_mapping_artifact_v1(jsonb)'::regprocedure),
  'unsupported or unresolved shipment intent',
  'artifact upsert rejects unsupported and unresolved generic intent keys'
);
SELECT matches(
  pg_get_functiondef('public.ui_upsert_mapping_artifact_v1(jsonb)'::regprocedure),
  'pending_activation',
  'create-new drafts remain pending instead of becoming active bindings'
);

SELECT * FROM finish();
ROLLBACK;
