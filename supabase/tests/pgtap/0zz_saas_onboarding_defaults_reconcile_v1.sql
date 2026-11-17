-- pgTAP: SaaS onboarding defaults reconcile RPC

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(19);

SELECT ok(
  to_regprocedure('public.reconcile_saas_onboarding_defaults_v1(text,uuid,text)') IS NOT NULL,
  'reconcile_saas_onboarding_defaults_v1 RPC exists'
);

CREATE OR REPLACE FUNCTION pg_temp.exercise_saas_onboarding_defaults_reconcile_v1()
RETURNS JSONB
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();
  v_org_slug TEXT := 'pgtap-reconcile-org-' || left(replace(v_org::text, '-', ''), 8);
  v_client_slug TEXT := 'pgtap-reconcile-client-' || left(replace(v_client::text, '-', ''), 8);
  v_global_result JSONB := NULL;
  v_global_scope_result JSONB := NULL;
  v_tenant_first JSONB := NULL;
  v_tenant_second JSONB := NULL;
  v_client_result JSONB := NULL;
  v_sender_result JSONB := NULL;
  v_plugin_binding_count_first INTEGER := 0;
  v_plugin_binding_count_second INTEGER := 0;
  v_plugin_task_count_first INTEGER := 0;
  v_plugin_task_count_second INTEGER := 0;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'pgTAP Reconcile Org', v_org_slug);

  INSERT INTO public.clients (id, organization_id, name, slug)
  VALUES (v_client, v_org, 'pgTAP Reconcile Client', v_client_slug);

  INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, auto_recreate, status, settings_override)
  VALUES (v_sender, v_client, 'pgTAP Reconcile Sender', 'pgTAP Reconcile Sender', FALSE, TRUE, 'active', '{}'::jsonb);

  INSERT INTO public.onboarding_integration_plugin_defaults (
    profile_key,
    scope_type,
    plugin_key,
    plugin_name,
    description,
    plugin_kind,
    required,
    activation_mode,
    validation_pack,
    task_template_key,
    task_queue_key,
    task_priority,
    task_sla_minutes,
    source_type,
    source_payload,
    inbound_config,
    mapping_config,
    workflow_binding,
    outbound_operations,
    metadata,
    enabled
  )
  VALUES (
    'default',
    'tenant',
    'default-provider-credentials-handoff',
    'Default Provider Credentials Handoff',
    'Baseline provider plugin that installs automatically and remains pending until credentials are supplied.',
    'webhook',
    TRUE,
    'auto_install_pending_credentials',
    '{}'::jsonb,
    'integration_plugin_credentials',
    'integration_plugin_credentials',
    45,
    60,
    'manual',
    jsonb_build_object(
      'baseline_profile', 'default',
      'managed_by', 'pgtap'
    ),
    jsonb_build_object(
      'webhook', jsonb_build_object(
        'name', 'Default Provider Credentials Handoff'
      )
    ),
    '{}'::jsonb,
    jsonb_build_object('template_name', 'webhook_intake_v1'),
    '[]'::jsonb,
    jsonb_build_object(
      'baseline_profile', 'default',
      'required', TRUE,
      'activation_mode', 'auto_install_pending_credentials'
    ),
    TRUE
  )
  ON CONFLICT (profile_key, scope_type, plugin_key) DO UPDATE
  SET
    plugin_name = EXCLUDED.plugin_name,
    description = EXCLUDED.description,
    plugin_kind = EXCLUDED.plugin_kind,
    required = EXCLUDED.required,
    activation_mode = EXCLUDED.activation_mode,
    validation_pack = EXCLUDED.validation_pack,
    task_template_key = EXCLUDED.task_template_key,
    task_queue_key = EXCLUDED.task_queue_key,
    task_priority = EXCLUDED.task_priority,
    task_sla_minutes = EXCLUDED.task_sla_minutes,
    source_type = EXCLUDED.source_type,
    source_payload = EXCLUDED.source_payload,
    inbound_config = EXCLUDED.inbound_config,
    mapping_config = EXCLUDED.mapping_config,
    workflow_binding = EXCLUDED.workflow_binding,
    outbound_operations = EXCLUDED.outbound_operations,
    metadata = EXCLUDED.metadata,
    enabled = EXCLUDED.enabled,
    updated_at = now();

  v_global_result := public.reconcile_saas_onboarding_defaults_v1(NULL, NULL, 'pgtap:global');
  v_global_scope_result := public.reconcile_saas_onboarding_defaults_v1('global', NULL, 'pgtap:global-scope');

  v_tenant_first := public.reconcile_saas_onboarding_defaults_v1('tenant', v_org, 'pgtap:tenant:first');

  SELECT COUNT(*)::INT
    INTO v_plugin_binding_count_first
    FROM public.integration_plugin_bindings b
    JOIN public.integration_plugin_versions v
      ON v.id = b.plugin_version_id
    JOIN public.integration_plugins p
      ON p.id = v.plugin_id
   WHERE p.organization_id = v_org
     AND p.plugin_key = 'default-provider-credentials-handoff'
     AND b.scope_type = 'tenant'
     AND b.scope_id = v_org;

  SELECT COUNT(*)::INT
    INTO v_plugin_task_count_first
    FROM public.tasks t
   WHERE t.organization_id = v_org
     AND t.resource_type = 'integration_plugins'
     AND COALESCE(t.metadata->>'plugin_key', '') = 'default-provider-credentials-handoff';

  v_tenant_second := public.reconcile_saas_onboarding_defaults_v1('tenant', v_org, 'pgtap:tenant:second');

  SELECT COUNT(*)::INT
    INTO v_plugin_binding_count_second
    FROM public.integration_plugin_bindings b
    JOIN public.integration_plugin_versions v
      ON v.id = b.plugin_version_id
    JOIN public.integration_plugins p
      ON p.id = v.plugin_id
   WHERE p.organization_id = v_org
     AND p.plugin_key = 'default-provider-credentials-handoff'
     AND b.scope_type = 'tenant'
     AND b.scope_id = v_org;

  SELECT COUNT(*)::INT
    INTO v_plugin_task_count_second
    FROM public.tasks t
   WHERE t.organization_id = v_org
     AND t.resource_type = 'integration_plugins'
     AND COALESCE(t.metadata->>'plugin_key', '') = 'default-provider-credentials-handoff';

  v_client_result := public.reconcile_saas_onboarding_defaults_v1('client', v_client, 'pgtap:client');
  v_sender_result := public.reconcile_saas_onboarding_defaults_v1('sender', v_sender, 'pgtap:sender');

  RETURN jsonb_build_object(
    'global_result', v_global_result,
    'global_scope_result', v_global_scope_result,
    'tenant_first', v_tenant_first,
    'tenant_second', v_tenant_second,
    'client_result', v_client_result,
    'sender_result', v_sender_result,
    'plugin_binding_count_first', v_plugin_binding_count_first,
    'plugin_binding_count_second', v_plugin_binding_count_second,
    'plugin_task_count_first', v_plugin_task_count_first,
    'plugin_task_count_second', v_plugin_task_count_second
  );
END;
$function$;

CREATE TEMP TABLE pg_temp.saas_onboarding_defaults_reconcile_result AS
SELECT pg_temp.exercise_saas_onboarding_defaults_reconcile_v1() AS payload;

SELECT ok(
  COALESCE((payload #>> '{global_result,ok}')::boolean, FALSE),
  'global reconcile succeeds when no scope is requested'
)
FROM pg_temp.saas_onboarding_defaults_reconcile_result;

SELECT ok(
  COALESCE((payload #>> '{global_scope_result,ok}')::boolean, FALSE),
  'global reconcile succeeds for explicit global scope'
)
FROM pg_temp.saas_onboarding_defaults_reconcile_result;

SELECT is(
  payload #>> '{global_scope_result,scope_type}',
  'global',
  'explicit global reconcile returns global scope type'
)
FROM pg_temp.saas_onboarding_defaults_reconcile_result;

SELECT ok(
  COALESCE((payload #>> '{tenant_first,ok}')::boolean, FALSE),
  'tenant reconcile succeeds'
)
FROM pg_temp.saas_onboarding_defaults_reconcile_result;

SELECT is(
  payload #>> '{tenant_first,scope_type}',
  'tenant',
  'tenant reconcile returns tenant scope type'
)
FROM pg_temp.saas_onboarding_defaults_reconcile_result;

SELECT is(
  payload #>> '{tenant_first,workflow_bindings,baseline_profile}',
  'default',
  'tenant reconcile returns the baseline workflow profile'
)
FROM pg_temp.saas_onboarding_defaults_reconcile_result;

SELECT is(
  payload #>> '{tenant_first,readiness,workflow_bindings,status}',
  'healthy',
  'tenant reconcile reports healthy workflow bindings'
)
FROM pg_temp.saas_onboarding_defaults_reconcile_result;

SELECT ok(
  COALESCE((payload #>> '{tenant_first,integration_plugins,pending_credentials_count}')::int, 0) > 0,
  'tenant reconcile reports pending-credentials plugin work'
)
FROM pg_temp.saas_onboarding_defaults_reconcile_result;

SELECT ok(
  COALESCE(
    jsonb_path_exists(
      payload #> '{tenant_first,integration_plugins,items}',
      '$[*] ? (@.plugin_key == "default-provider-credentials-handoff" && @.status == "pending_credentials" && @.pending_task_exists == true)'
    ),
    FALSE
  ),
  'tenant reconcile surfaces a task-backed pending-credentials plugin item'
)
FROM pg_temp.saas_onboarding_defaults_reconcile_result;

SELECT ok(
  NULLIF(payload #>> '{tenant_first,readiness,generated_at}', '') IS NOT NULL,
  'tenant reconcile returns readiness freshness metadata'
)
FROM pg_temp.saas_onboarding_defaults_reconcile_result;

SELECT ok(
  COALESCE((payload->>'plugin_binding_count_first')::int, -1) =
  COALESCE((payload->>'plugin_binding_count_second')::int, -2),
  'tenant reconcile is idempotent on plugin bindings'
)
FROM pg_temp.saas_onboarding_defaults_reconcile_result;

SELECT ok(
  COALESCE((payload->>'plugin_task_count_first')::int, -1) =
  COALESCE((payload->>'plugin_task_count_second')::int, -2),
  'tenant reconcile is idempotent on plugin follow-up tasks'
)
FROM pg_temp.saas_onboarding_defaults_reconcile_result;

SELECT ok(
  COALESCE((payload #>> '{client_result,ok}')::boolean, FALSE),
  'client reconcile succeeds'
)
FROM pg_temp.saas_onboarding_defaults_reconcile_result;

SELECT is(
  payload #>> '{client_result,readiness,scope_type}',
  'client',
  'client reconcile returns client readiness scope'
)
FROM pg_temp.saas_onboarding_defaults_reconcile_result;

SELECT is(
  payload #>> '{client_result,readiness,workflow_bindings,status}',
  'healthy',
  'client reconcile reports healthy workflow bindings'
)
FROM pg_temp.saas_onboarding_defaults_reconcile_result;

SELECT ok(
  COALESCE((payload #>> '{sender_result,ok}')::boolean, FALSE),
  'sender reconcile succeeds'
)
FROM pg_temp.saas_onboarding_defaults_reconcile_result;

SELECT is(
  payload #>> '{sender_result,readiness,scope_type}',
  'sender',
  'sender reconcile returns sender readiness scope'
)
FROM pg_temp.saas_onboarding_defaults_reconcile_result;

SELECT is(
  payload #>> '{sender_result,readiness,workflow_bindings,status}',
  'healthy',
  'sender reconcile reports healthy workflow bindings'
)
FROM pg_temp.saas_onboarding_defaults_reconcile_result;

SELECT * FROM finish();

ROLLBACK;
