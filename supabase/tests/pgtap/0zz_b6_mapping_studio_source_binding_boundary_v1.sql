BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(10);

SELECT has_function(
  'public',
  'ui_upsert_mapping_artifact_v1',
  ARRAY['jsonb'],
  'source-lineage validated Mapping Studio artifact upsert exists'
);

SELECT matches(
  pg_get_functiondef('public.ui_upsert_mapping_artifact_v1(jsonb)'::regprocedure),
  'v_workflow_template_scope_id = v_source_client_id',
  'client template binding must match the source sender client exactly'
);

SELECT matches(
  pg_get_functiondef('public.ui_upsert_mapping_artifact_v1(jsonb)'::regprocedure),
  'v_workflow_template_scope_id = v_source_sender_id',
  'sender template binding must match the source sender exactly'
);

SELECT matches(
  pg_get_functiondef('public.ui_upsert_mapping_artifact_v1(jsonb)'::regprocedure),
  'WHEN v_artifact = ''webhook_inbound'' AND v_webhook_source_id IS NOT NULL THEN',
  'exact source-lineage matching is limited to webhook artifacts with a source'
);

SELECT matches(
  pg_get_functiondef('public.ui_upsert_mapping_artifact_v1(jsonb)'::regprocedure),
  'attach_existing requires workflow_template_id',
  'explicit attach mode fails closed without a template id'
);

SELECT matches(
  pg_get_functiondef('public.ui_upsert_mapping_artifact_v1(jsonb)'::regprocedure),
  'create_new requires template_name',
  'explicit create mode fails closed without a nonblank name'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
     WHERE p.oid = 'public.resolve_webhook_followup_template_id_v1(jsonb,text)'::regprocedure
       AND acl.grantee = 0
       AND acl.privilege_type = 'EXECUTE'
  ),
  'PUBLIC cannot execute the webhook follow-up template resolver'
);
SELECT ok(
  NOT has_function_privilege('anon', 'public.resolve_webhook_followup_template_id_v1(jsonb,text)', 'EXECUTE'),
  'anon cannot execute the webhook follow-up template resolver'
);
SELECT ok(
  NOT has_function_privilege('authenticated', 'public.resolve_webhook_followup_template_id_v1(jsonb,text)', 'EXECUTE'),
  'authenticated cannot execute the webhook follow-up template resolver'
);
SELECT ok(
  has_function_privilege('service_role', 'public.resolve_webhook_followup_template_id_v1(jsonb,text)', 'EXECUTE'),
  'service_role can execute the webhook follow-up template resolver'
);

SELECT * FROM finish();
ROLLBACK;
