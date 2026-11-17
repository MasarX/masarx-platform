-- pgTAP: Onboarding readiness + integration plugin baseline contract

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(56);

SELECT has_function(
  'public',
  'request_role_is_service_v1',
  ARRAY[]::text[],
  'public.request_role_is_service_v1 exists'
);

SELECT has_function(
  'public',
  'bootstrap_integration_plugin_defaults_v1',
  ARRAY['text', 'uuid', 'text'],
  'public.bootstrap_integration_plugin_defaults_v1 exists'
);

SELECT has_function(
  'public',
  'onboarding_readiness_snapshot_v1',
  ARRAY['text', 'uuid'],
  'public.onboarding_readiness_snapshot_v1 exists'
);

SELECT has_function(
  'public',
  'ui_get_onboarding_readiness_v1',
  ARRAY['text', 'uuid'],
  'public.ui_get_onboarding_readiness_v1 exists'
);

SELECT has_function(
  'api',
  'ui_get_onboarding_readiness_v1',
  ARRAY['text', 'uuid'],
  'api.ui_get_onboarding_readiness_v1 exists'
);

SELECT ok(
  has_function_privilege(
    'service_role',
    'public.bootstrap_integration_plugin_defaults_v1(text,uuid,text)',
    'EXECUTE'
  ),
  'service_role can execute public.bootstrap_integration_plugin_defaults_v1'
);

SELECT ok(
  has_function_privilege(
    'service_role',
    'public.onboarding_integration_plugin_readiness_v1(text,uuid)',
    'EXECUTE'
  ),
  'service_role can execute public.onboarding_integration_plugin_readiness_v1'
);

SELECT ok(
  has_function_privilege(
    'service_role',
    'public.onboarding_readiness_snapshot_v1(text,uuid)',
    'EXECUTE'
  ),
  'service_role can execute public.onboarding_readiness_snapshot_v1'
);

SELECT ok(
  has_function_privilege(
    'authenticated',
    'public.ui_get_onboarding_readiness_v1(text,uuid)',
    'EXECUTE'
  ),
  'authenticated can execute public.ui_get_onboarding_readiness_v1'
);

SELECT ok(
  has_function_privilege(
    'authenticated',
    'api.ui_get_onboarding_readiness_v1(text,uuid)',
    'EXECUTE'
  ),
  'authenticated can execute api.ui_get_onboarding_readiness_v1'
);

SELECT ok(
  NOT has_function_privilege(
    'authenticated',
    'public.onboarding_integration_plugin_readiness_v1(text,uuid)',
    'EXECUTE'
  ),
  'authenticated cannot execute public.onboarding_integration_plugin_readiness_v1 directly'
);

SELECT ok(
  NOT has_function_privilege(
    'authenticated',
    'public.onboarding_readiness_snapshot_v1(text,uuid)',
    'EXECUTE'
  ),
  'authenticated cannot execute public.onboarding_readiness_snapshot_v1 directly'
);

SELECT ok(
  NOT has_function_privilege(
    'anon',
    'public.ui_get_onboarding_readiness_v1(text,uuid)',
    'EXECUTE'
  ),
  'anon cannot execute public.ui_get_onboarding_readiness_v1'
);

SELECT ok(
  NOT has_function_privilege(
    'anon',
    'api.ui_get_onboarding_readiness_v1(text,uuid)',
    'EXECUTE'
  ),
  'anon cannot execute api.ui_get_onboarding_readiness_v1'
);

SELECT ok(
  NOT has_function_privilege(
    'anon',
    'public.onboarding_integration_plugin_readiness_v1(text,uuid)',
    'EXECUTE'
  ),
  'anon cannot execute public.onboarding_integration_plugin_readiness_v1'
);

SELECT ok(
  NOT has_function_privilege(
    'anon',
    'public.onboarding_readiness_snapshot_v1(text,uuid)',
    'EXECUTE'
  ),
  'anon cannot execute public.onboarding_readiness_snapshot_v1'
);

CREATE OR REPLACE FUNCTION pg_temp.exercise_onboarding_readiness_plugin_defaults_v1()
RETURNS JSONB
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_sender UUID := NULL;
  v_user UUID := gen_random_uuid();
  v_org_slug TEXT := 'onboard-ready-org-' || left(replace(v_org::text, '-', ''), 12);
  v_client_slug TEXT := 'onboard-ready-client-' || left(replace(v_client::text, '-', ''), 12);

  v_have_request_role_helper BOOLEAN := to_regprocedure('public.request_role_is_service_v1()') IS NOT NULL;
  v_have_plugin_bootstrap BOOLEAN :=
    to_regprocedure('public.bootstrap_integration_plugin_defaults_v1(text,uuid,text)') IS NOT NULL;
  v_have_snapshot BOOLEAN := to_regprocedure('public.onboarding_readiness_snapshot_v1(text,uuid)') IS NOT NULL;
  v_have_ui_public BOOLEAN := to_regprocedure('public.ui_get_onboarding_readiness_v1(text,uuid)') IS NOT NULL;
  v_have_ui_api BOOLEAN := to_regprocedure('api.ui_get_onboarding_readiness_v1(text,uuid)') IS NOT NULL;

  v_tenant_bootstrap JSONB := NULL;
  v_tenant_bootstrap_error TEXT := NULL;
  v_client_bootstrap JSONB := NULL;
  v_client_bootstrap_error TEXT := NULL;
  v_sender_bootstrap JSONB := NULL;
  v_sender_bootstrap_error TEXT := NULL;

  v_workflow_binding_seeded_before BOOLEAN := FALSE;
  v_workflow_binding_seeded_after_tenant_bootstrap BOOLEAN := FALSE;
  v_default_sender_exists_before BOOLEAN := FALSE;
  v_default_sender_exists_after_client_bootstrap BOOLEAN := FALSE;

  v_service_detected_authenticated BOOLEAN := NULL;
  v_service_detected_authenticated_role_only BOOLEAN := NULL;
  v_service_detected_service BOOLEAN := NULL;

  v_plugin_bootstrap_first JSONB := NULL;
  v_plugin_bootstrap_first_error TEXT := NULL;
  v_plugin_bootstrap_second JSONB := NULL;
  v_plugin_bootstrap_second_error TEXT := NULL;
  v_plugin_binding_count_after_first INTEGER := NULL;
  v_plugin_binding_count_after_second INTEGER := NULL;
  v_pending_plugin_status TEXT := NULL;
  v_pending_plugin_task_exists BOOLEAN := FALSE;

  v_snapshot JSONB := NULL;
  v_snapshot_error TEXT := NULL;
  v_snapshot_scope_type TEXT := NULL;
  v_snapshot_plugin_status TEXT := NULL;
  v_client_snapshot JSONB := NULL;
  v_client_snapshot_error TEXT := NULL;
  v_client_snapshot_scope_type TEXT := NULL;
  v_sender_snapshot JSONB := NULL;
  v_sender_snapshot_error TEXT := NULL;
  v_sender_snapshot_scope_type TEXT := NULL;

  v_ui_public JSONB := NULL;
  v_ui_public_error TEXT := NULL;
  v_ui_public_scope_type TEXT := NULL;

  v_ui_api JSONB := NULL;
  v_ui_api_error TEXT := NULL;
  v_ui_api_scope_type TEXT := NULL;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Onboarding Readiness Org', v_org_slug);

  INSERT INTO public.users (
    id,
    organization_id,
    email,
    full_name,
    user_type,
    status,
    access_scope_type,
    access_scope_id
  )
  VALUES (
    v_user,
    v_org,
    format('onboarding-readiness-%s@example.com', left(replace(v_user::text, '-', ''), 12)),
    'Onboarding Readiness Operator',
    'ops_admin',
    'active',
    'tenant',
    NULL
  );

  PERFORM public.provision_rbac_roles_from_templates_v1(v_org, ARRAY['ops_admin'], v_user);

  INSERT INTO public.rbac_user_role_assignments (
    organization_id,
    user_id,
    role_id,
    assigned_by_user_id,
    metadata
  )
  SELECT
    v_org,
    v_user,
    r.id,
    v_user,
    jsonb_build_object('source', 'pgtap', 'template_key', r.key)
  FROM public.rbac_roles r
  WHERE r.organization_id = v_org
    AND r.key = 'ops_admin'
  ON CONFLICT DO NOTHING;

  INSERT INTO public.clients (id, organization_id, name, slug)
  VALUES (v_client, v_org, 'Onboarding Readiness Client', v_client_slug);

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

  DELETE FROM public.settings
  WHERE category = 'workflow_binding_policy'
    AND scope_type = 'tenant'
    AND scope_id = v_org;

  DELETE FROM public.senders
  WHERE client_id = v_client;

  SELECT EXISTS (
    SELECT 1
    FROM public.settings s
    WHERE s.category = 'workflow_binding_policy'
      AND s.scope_type = 'tenant'
      AND s.scope_id = v_org
  )
  INTO v_workflow_binding_seeded_before;

  SELECT EXISTS (
    SELECT 1
    FROM public.senders s
    WHERE s.client_id = v_client
  )
  INTO v_default_sender_exists_before;

  BEGIN
    v_tenant_bootstrap := public.bootstrap_tenant_onboarding_v1(
      v_org,
      'pgtap:onboarding-readiness-contract'
    );
  EXCEPTION WHEN OTHERS THEN
    v_tenant_bootstrap_error := SQLERRM;
  END;

  SELECT EXISTS (
    SELECT 1
    FROM public.settings s
    WHERE s.category = 'workflow_binding_policy'
      AND s.scope_type = 'tenant'
      AND s.scope_id = v_org
  )
  INTO v_workflow_binding_seeded_after_tenant_bootstrap;

  BEGIN
    v_client_bootstrap := public.bootstrap_client_onboarding_v1(
      v_client,
      'pgtap:onboarding-readiness-client-contract'
    );
  EXCEPTION WHEN OTHERS THEN
    v_client_bootstrap_error := SQLERRM;
  END;

  SELECT EXISTS (
    SELECT 1
    FROM public.senders s
    WHERE s.client_id = v_client
  )
  INTO v_default_sender_exists_after_client_bootstrap;

  SELECT s.id
    INTO v_sender
    FROM public.senders s
   WHERE s.client_id = v_client
   ORDER BY s.created_at, s.id
   LIMIT 1;

  IF v_sender IS NOT NULL THEN
    BEGIN
      v_sender_bootstrap := public.bootstrap_sender_onboarding_v1(
        v_sender,
        'pgtap:onboarding-readiness-sender-contract'
      );
    EXCEPTION WHEN OTHERS THEN
      v_sender_bootstrap_error := SQLERRM;
    END;
  END IF;

  IF v_have_request_role_helper THEN
    PERFORM set_config('request.jwt.claim.sub', v_user::text, TRUE);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', TRUE);
    PERFORM set_config(
      'request.jwt.claims',
      json_build_object('sub', v_user::text, 'role', 'authenticated')::text,
      TRUE
    );
    EXECUTE 'SET LOCAL ROLE authenticated';

    BEGIN
      EXECUTE 'SELECT public.request_role_is_service_v1()'
        INTO v_service_detected_authenticated;
    EXCEPTION WHEN OTHERS THEN
      v_service_detected_authenticated := NULL;
    END;

    PERFORM set_config('request.jwt.claim.role', '', TRUE);
    PERFORM set_config('request.jwt.claims', '', TRUE);

    BEGIN
      EXECUTE 'SELECT public.request_role_is_service_v1()'
        INTO v_service_detected_authenticated_role_only;
    EXCEPTION WHEN OTHERS THEN
      v_service_detected_authenticated_role_only := NULL;
    END;

    PERFORM set_config('request.jwt.claim.sub', '', TRUE);
    PERFORM set_config('request.jwt.claim.role', 'service_role', TRUE);
    PERFORM set_config(
      'request.jwt.claims',
      json_build_object('role', 'service_role')::text,
      TRUE
    );
    EXECUTE 'SET LOCAL ROLE service_role';

    BEGIN
      EXECUTE 'SELECT public.request_role_is_service_v1()'
        INTO v_service_detected_service;
    EXCEPTION WHEN OTHERS THEN
      v_service_detected_service := NULL;
    END;

    EXECUTE 'SET LOCAL ROLE postgres';
  END IF;

  IF v_have_plugin_bootstrap THEN
    PERFORM set_config('request.jwt.claim.sub', '', TRUE);
    PERFORM set_config('request.jwt.claim.role', 'service_role', TRUE);
    PERFORM set_config(
      'request.jwt.claims',
      json_build_object('role', 'service_role')::text,
      TRUE
    );
    EXECUTE 'SET LOCAL ROLE service_role';

    BEGIN
      EXECUTE 'SELECT public.bootstrap_integration_plugin_defaults_v1($1::text, $2::uuid)'
        INTO v_plugin_bootstrap_first
        USING 'tenant', v_org;
    EXCEPTION WHEN OTHERS THEN
      v_plugin_bootstrap_first_error := SQLERRM;
    END;

    SELECT COUNT(*)::INT
      INTO v_plugin_binding_count_after_first
      FROM public.integration_plugin_bindings b
      WHERE b.organization_id = v_org
        AND b.scope_type = 'tenant'
        AND b.scope_id = v_org;

    SELECT item.value->>'status',
           COALESCE((item.value->>'pending_task_exists')::boolean, FALSE)
      INTO v_pending_plugin_status, v_pending_plugin_task_exists
      FROM jsonb_array_elements(COALESCE(v_plugin_bootstrap_first->'items', '[]'::jsonb)) AS item(value)
     WHERE item.value->>'plugin_key' = 'default-provider-credentials-handoff'
     LIMIT 1;

    BEGIN
      EXECUTE 'SELECT public.bootstrap_integration_plugin_defaults_v1($1::text, $2::uuid, $3::text)'
        INTO v_plugin_bootstrap_second
        USING 'tenant', v_org, 'pgtap:onboarding-readiness-repeat';
    EXCEPTION WHEN OTHERS THEN
      v_plugin_bootstrap_second_error := SQLERRM;
    END;

    SELECT COUNT(*)::INT
      INTO v_plugin_binding_count_after_second
      FROM public.integration_plugin_bindings b
      WHERE b.organization_id = v_org
        AND b.scope_type = 'tenant'
        AND b.scope_id = v_org;

    EXECUTE 'SET LOCAL ROLE postgres';
  END IF;

  IF v_have_snapshot THEN
    PERFORM set_config('request.jwt.claim.sub', '', TRUE);
    PERFORM set_config('request.jwt.claim.role', 'service_role', TRUE);
    PERFORM set_config(
      'request.jwt.claims',
      json_build_object('role', 'service_role')::text,
      TRUE
    );
    EXECUTE 'SET LOCAL ROLE service_role';

    BEGIN
      EXECUTE 'SELECT public.onboarding_readiness_snapshot_v1($1::text, $2::uuid)'
        INTO v_snapshot
        USING 'tenant', v_org;
    EXCEPTION WHEN OTHERS THEN
      v_snapshot_error := SQLERRM;
    END;

    v_snapshot_scope_type := NULLIF(
      COALESCE(
        v_snapshot ->> 'scope_type',
        v_snapshot #>> '{scope,scope_type}',
        v_snapshot #>> '{snapshot,scope_type}'
      ),
      ''
    );
    v_snapshot_plugin_status := NULLIF(v_snapshot #>> '{integration_plugins,status}', '');

    BEGIN
      EXECUTE 'SELECT public.onboarding_readiness_snapshot_v1($1::text, $2::uuid)'
        INTO v_client_snapshot
        USING 'client', v_client;
    EXCEPTION WHEN OTHERS THEN
      v_client_snapshot_error := SQLERRM;
    END;

    v_client_snapshot_scope_type := NULLIF(
      COALESCE(
        v_client_snapshot ->> 'scope_type',
        v_client_snapshot #>> '{scope,scope_type}',
        v_client_snapshot #>> '{snapshot,scope_type}'
      ),
      ''
    );

    IF v_sender IS NOT NULL THEN
      BEGIN
        EXECUTE 'SELECT public.onboarding_readiness_snapshot_v1($1::text, $2::uuid)'
          INTO v_sender_snapshot
          USING 'sender', v_sender;
      EXCEPTION WHEN OTHERS THEN
        v_sender_snapshot_error := SQLERRM;
      END;

      v_sender_snapshot_scope_type := NULLIF(
        COALESCE(
          v_sender_snapshot ->> 'scope_type',
          v_sender_snapshot #>> '{scope,scope_type}',
          v_sender_snapshot #>> '{snapshot,scope_type}'
        ),
        ''
      );
    END IF;

    EXECUTE 'SET LOCAL ROLE postgres';
  END IF;

  IF v_have_ui_public OR v_have_ui_api THEN
    PERFORM set_config('request.jwt.claim.sub', v_user::text, TRUE);
    PERFORM set_config('request.jwt.claim.role', 'authenticated', TRUE);
    PERFORM set_config(
      'request.jwt.claims',
      json_build_object('sub', v_user::text, 'role', 'authenticated')::text,
      TRUE
    );
    EXECUTE 'SET LOCAL ROLE authenticated';

    IF v_have_ui_public THEN
      BEGIN
        EXECUTE 'SELECT public.ui_get_onboarding_readiness_v1($1::text, $2::uuid)'
          INTO v_ui_public
          USING 'tenant', v_org;
      EXCEPTION WHEN OTHERS THEN
        v_ui_public_error := SQLERRM;
      END;

      v_ui_public_scope_type := NULLIF(
        COALESCE(
          v_ui_public ->> 'scope_type',
          v_ui_public #>> '{scope,scope_type}',
          v_ui_public #>> '{snapshot,scope_type}'
        ),
        ''
      );
    END IF;

    IF v_have_ui_api THEN
      BEGIN
        EXECUTE 'SELECT api.ui_get_onboarding_readiness_v1($1::text, $2::uuid)'
          INTO v_ui_api
          USING 'tenant', v_org;
      EXCEPTION WHEN OTHERS THEN
        v_ui_api_error := SQLERRM;
      END;

      v_ui_api_scope_type := NULLIF(
        COALESCE(
          v_ui_api ->> 'scope_type',
          v_ui_api #>> '{scope,scope_type}',
          v_ui_api #>> '{snapshot,scope_type}'
        ),
        ''
      );
    END IF;

    EXECUTE 'SET LOCAL ROLE postgres';
  END IF;

  RETURN jsonb_build_object(
    'have_request_role_helper', v_have_request_role_helper,
    'have_plugin_bootstrap', v_have_plugin_bootstrap,
    'have_snapshot', v_have_snapshot,
    'have_ui_public', v_have_ui_public,
    'have_ui_api', v_have_ui_api,
    'workflow_binding_seeded_before', v_workflow_binding_seeded_before,
    'workflow_binding_seeded_after_tenant_bootstrap', v_workflow_binding_seeded_after_tenant_bootstrap,
    'default_sender_exists_before', v_default_sender_exists_before,
    'default_sender_exists_after_client_bootstrap', v_default_sender_exists_after_client_bootstrap,
    'tenant_bootstrap', v_tenant_bootstrap,
    'tenant_bootstrap_error', v_tenant_bootstrap_error,
    'client_bootstrap', v_client_bootstrap,
    'client_bootstrap_error', v_client_bootstrap_error,
    'sender_id', v_sender,
    'sender_bootstrap', v_sender_bootstrap,
    'sender_bootstrap_error', v_sender_bootstrap_error,
    'service_detected_authenticated', v_service_detected_authenticated,
    'service_detected_authenticated_role_only', v_service_detected_authenticated_role_only,
    'service_detected_service', v_service_detected_service,
    'plugin_bootstrap_first', v_plugin_bootstrap_first,
    'plugin_bootstrap_first_error', v_plugin_bootstrap_first_error,
    'plugin_bootstrap_second', v_plugin_bootstrap_second,
    'plugin_bootstrap_second_error', v_plugin_bootstrap_second_error,
    'plugin_binding_count_after_first', v_plugin_binding_count_after_first,
    'plugin_binding_count_after_second', v_plugin_binding_count_after_second,
    'pending_plugin_status', v_pending_plugin_status,
    'pending_plugin_task_exists', v_pending_plugin_task_exists,
    'readiness_snapshot', v_snapshot,
    'readiness_snapshot_error', v_snapshot_error,
    'readiness_snapshot_scope_type', v_snapshot_scope_type,
    'readiness_snapshot_plugin_status', v_snapshot_plugin_status,
    'client_snapshot', v_client_snapshot,
    'client_snapshot_error', v_client_snapshot_error,
    'client_snapshot_scope_type', v_client_snapshot_scope_type,
    'sender_snapshot', v_sender_snapshot,
    'sender_snapshot_error', v_sender_snapshot_error,
    'sender_snapshot_scope_type', v_sender_snapshot_scope_type,
    'ui_public', v_ui_public,
    'ui_public_error', v_ui_public_error,
    'ui_public_scope_type', v_ui_public_scope_type,
    'ui_api', v_ui_api,
    'ui_api_error', v_ui_api_error,
    'ui_api_scope_type', v_ui_api_scope_type
  );
END;
$function$;

CREATE TEMP TABLE pg_temp.onboarding_readiness_plugin_defaults_result AS
SELECT pg_temp.exercise_onboarding_readiness_plugin_defaults_v1() AS payload;

SELECT CASE
  WHEN COALESCE((payload->>'have_request_role_helper')::boolean, FALSE) THEN
    ok(
      COALESCE((payload->>'service_detected_authenticated')::boolean, TRUE) IS FALSE,
      'authenticated request context is not treated as service'
    )
  ELSE
    skip('public.request_role_is_service_v1 not installed yet', 1)
END
FROM pg_temp.onboarding_readiness_plugin_defaults_result;

SELECT CASE
  WHEN COALESCE((payload->>'have_request_role_helper')::boolean, FALSE) THEN
    ok(
      COALESCE((payload->>'service_detected_authenticated_role_only')::boolean, TRUE) IS FALSE,
      'authenticated SET ROLE context without JWT role is not treated as service'
    )
  ELSE
    skip('public.request_role_is_service_v1 not installed yet', 1)
END
FROM pg_temp.onboarding_readiness_plugin_defaults_result;

SELECT CASE
  WHEN COALESCE((payload->>'have_request_role_helper')::boolean, FALSE) THEN
    ok(
      COALESCE((payload->>'service_detected_service')::boolean, FALSE),
      'service_role request context is treated as service'
    )
  ELSE
    skip('public.request_role_is_service_v1 not installed yet', 1)
END
FROM pg_temp.onboarding_readiness_plugin_defaults_result;

SELECT ok(
  COALESCE((payload->>'workflow_binding_seeded_before')::boolean, TRUE) IS FALSE,
  'tenant workflow binding defaults can be absent before explicit tenant bootstrap proof'
)
FROM pg_temp.onboarding_readiness_plugin_defaults_result;

SELECT ok(
  COALESCE((payload->>'workflow_binding_seeded_after_tenant_bootstrap')::boolean, FALSE),
  'explicit tenant bootstrap materializes tenant workflow binding defaults'
)
FROM pg_temp.onboarding_readiness_plugin_defaults_result;

SELECT ok(
  NULLIF(payload->>'tenant_bootstrap_error', '') IS NULL,
  'explicit tenant bootstrap returns without error'
)
FROM pg_temp.onboarding_readiness_plugin_defaults_result;

SELECT ok(
  COALESCE((payload #>> '{tenant_bootstrap,ok}')::boolean, FALSE),
  'explicit tenant bootstrap returns ok=true'
)
FROM pg_temp.onboarding_readiness_plugin_defaults_result;

SELECT ok(
  COALESCE((payload->>'default_sender_exists_before')::boolean, TRUE) IS FALSE,
  'default sender can be absent before explicit client bootstrap proof'
)
FROM pg_temp.onboarding_readiness_plugin_defaults_result;

SELECT ok(
  NULLIF(payload->>'client_bootstrap_error', '') IS NULL,
  'explicit client bootstrap returns without error'
)
FROM pg_temp.onboarding_readiness_plugin_defaults_result;

SELECT ok(
  COALESCE((payload #>> '{client_bootstrap,ok}')::boolean, FALSE),
  'explicit client bootstrap returns ok=true'
)
FROM pg_temp.onboarding_readiness_plugin_defaults_result;

SELECT ok(
  COALESCE((payload->>'default_sender_exists_after_client_bootstrap')::boolean, FALSE),
  'explicit client bootstrap creates a default sender'
)
FROM pg_temp.onboarding_readiness_plugin_defaults_result;

SELECT ok(
  NULLIF(payload->>'sender_bootstrap_error', '') IS NULL,
  'explicit sender bootstrap returns without error'
)
FROM pg_temp.onboarding_readiness_plugin_defaults_result;

SELECT ok(
  COALESCE((payload #>> '{sender_bootstrap,ok}')::boolean, FALSE),
  'explicit sender bootstrap returns ok=true'
)
FROM pg_temp.onboarding_readiness_plugin_defaults_result;

SELECT CASE
  WHEN COALESCE((payload->>'have_plugin_bootstrap')::boolean, FALSE) THEN
    ok(
      NULLIF(payload->>'plugin_bootstrap_first_error', '') IS NULL,
      'plugin baseline bootstrap first call returns without error'
    )
  ELSE
    skip('public.bootstrap_integration_plugin_defaults_v1 not installed yet', 1)
END
FROM pg_temp.onboarding_readiness_plugin_defaults_result;

SELECT CASE
  WHEN COALESCE((payload->>'have_plugin_bootstrap')::boolean, FALSE) THEN
    ok(
      COALESCE((payload #>> '{plugin_bootstrap_first,ok}')::boolean, FALSE),
      'plugin baseline bootstrap first call returns ok=true'
    )
  ELSE
    skip('public.bootstrap_integration_plugin_defaults_v1 not installed yet', 1)
END
FROM pg_temp.onboarding_readiness_plugin_defaults_result;

SELECT CASE
  WHEN COALESCE((payload->>'have_plugin_bootstrap')::boolean, FALSE) THEN
    ok(
      NULLIF(payload->>'plugin_bootstrap_second_error', '') IS NULL,
      'plugin baseline bootstrap second call returns without error'
    )
  ELSE
    skip('public.bootstrap_integration_plugin_defaults_v1 not installed yet', 1)
END
FROM pg_temp.onboarding_readiness_plugin_defaults_result;

SELECT CASE
  WHEN COALESCE((payload->>'have_plugin_bootstrap')::boolean, FALSE) THEN
    ok(
      COALESCE((payload->>'plugin_binding_count_after_first')::int, -1) =
      COALESCE((payload->>'plugin_binding_count_after_second')::int, -2),
      'plugin baseline bootstrap is idempotent on tenant binding count'
    )
  ELSE
    skip('public.bootstrap_integration_plugin_defaults_v1 not installed yet', 1)
END
FROM pg_temp.onboarding_readiness_plugin_defaults_result;

SELECT CASE
  WHEN COALESCE((payload->>'have_plugin_bootstrap')::boolean, FALSE) THEN
    ok(
      COALESCE((payload #>> '{plugin_bootstrap_first,pending_credentials_count}')::int, 0) > 0,
      'plugin baseline bootstrap records pending-credentials follow-up work'
    )
  ELSE
    skip('public.bootstrap_integration_plugin_defaults_v1 not installed yet', 1)
END
FROM pg_temp.onboarding_readiness_plugin_defaults_result;

SELECT CASE
  WHEN COALESCE((payload->>'have_plugin_bootstrap')::boolean, FALSE) THEN
    ok(
      COALESCE(payload->>'pending_plugin_status', '') = 'pending_credentials'
      AND COALESCE((payload->>'pending_plugin_task_exists')::boolean, FALSE),
      'pending-credentials baseline plugin stays pending and task-backed after bootstrap'
    )
  ELSE
    skip('public.bootstrap_integration_plugin_defaults_v1 not installed yet', 1)
END
FROM pg_temp.onboarding_readiness_plugin_defaults_result;

SELECT CASE
  WHEN COALESCE((payload->>'have_snapshot')::boolean, FALSE) THEN
    ok(
      NULLIF(payload->>'readiness_snapshot_error', '') IS NULL,
      'onboarding readiness snapshot returns without error'
    )
  ELSE
    skip('public.onboarding_readiness_snapshot_v1 not installed yet', 1)
END
FROM pg_temp.onboarding_readiness_plugin_defaults_result;

SELECT CASE
  WHEN COALESCE((payload->>'have_snapshot')::boolean, FALSE) THEN
    ok(
      COALESCE(jsonb_typeof(payload->'readiness_snapshot') = 'object', FALSE),
      'onboarding readiness snapshot returns a JSON object'
    )
  ELSE
    skip('public.onboarding_readiness_snapshot_v1 not installed yet', 1)
END
FROM pg_temp.onboarding_readiness_plugin_defaults_result;

SELECT CASE
  WHEN COALESCE((payload->>'have_snapshot')::boolean, FALSE) THEN
    ok(
      COALESCE(payload->>'readiness_snapshot_scope_type', '') = 'tenant',
      'onboarding readiness snapshot resolves tenant scope'
    )
  ELSE
    skip('public.onboarding_readiness_snapshot_v1 not installed yet', 1)
END
FROM pg_temp.onboarding_readiness_plugin_defaults_result;

SELECT CASE
  WHEN COALESCE((payload->>'have_snapshot')::boolean, FALSE) THEN
    ok(
      COALESCE(payload->>'readiness_snapshot_plugin_status', '') = 'pending_credentials',
      'onboarding readiness snapshot surfaces pending-credentials plugin state'
    )
  ELSE
    skip('public.onboarding_readiness_snapshot_v1 not installed yet', 1)
END
FROM pg_temp.onboarding_readiness_plugin_defaults_result;

SELECT CASE
  WHEN COALESCE((payload->>'have_snapshot')::boolean, FALSE) THEN
    ok(
      NULLIF(payload #>> '{readiness_snapshot,generated_at}', '') IS NOT NULL,
      'onboarding readiness snapshot returns a generated_at timestamp'
    )
  ELSE
    skip('public.onboarding_readiness_snapshot_v1 not installed yet', 1)
END
FROM pg_temp.onboarding_readiness_plugin_defaults_result;

SELECT CASE
  WHEN COALESCE((payload->>'have_snapshot')::boolean, FALSE) THEN
    ok(
      COALESCE(payload #>> '{readiness_snapshot,workflow_bindings,status}', '') = 'healthy',
      'tenant onboarding readiness snapshot surfaces healthy workflow bindings'
    )
  ELSE
    skip('public.onboarding_readiness_snapshot_v1 not installed yet', 1)
END
FROM pg_temp.onboarding_readiness_plugin_defaults_result;

SELECT CASE
  WHEN COALESCE((payload->>'have_snapshot')::boolean, FALSE) THEN
    ok(
      COALESCE((payload #>> '{readiness_snapshot,workflow_bindings,required_count}')::int, 0) > 0,
      'tenant onboarding readiness snapshot reports required workflow bindings'
    )
  ELSE
    skip('public.onboarding_readiness_snapshot_v1 not installed yet', 1)
END
FROM pg_temp.onboarding_readiness_plugin_defaults_result;

SELECT CASE
  WHEN COALESCE((payload->>'have_snapshot')::boolean, FALSE) THEN
    ok(
      NULLIF(payload->>'client_snapshot_error', '') IS NULL,
      'client onboarding readiness snapshot returns without error'
    )
  ELSE
    skip('public.onboarding_readiness_snapshot_v1 not installed yet', 1)
END
FROM pg_temp.onboarding_readiness_plugin_defaults_result;

SELECT CASE
  WHEN COALESCE((payload->>'have_snapshot')::boolean, FALSE) THEN
    ok(
      COALESCE(payload->>'client_snapshot_scope_type', '') = 'client',
      'client onboarding readiness snapshot resolves client scope'
    )
  ELSE
    skip('public.onboarding_readiness_snapshot_v1 not installed yet', 1)
END
FROM pg_temp.onboarding_readiness_plugin_defaults_result;

SELECT CASE
  WHEN COALESCE((payload->>'have_snapshot')::boolean, FALSE) THEN
    ok(
      COALESCE(payload #>> '{client_snapshot,workflow_bindings,status}', '') = 'healthy',
      'client onboarding readiness snapshot surfaces healthy workflow bindings'
    )
  ELSE
    skip('public.onboarding_readiness_snapshot_v1 not installed yet', 1)
END
FROM pg_temp.onboarding_readiness_plugin_defaults_result;

SELECT CASE
  WHEN COALESCE((payload->>'have_snapshot')::boolean, FALSE) THEN
    ok(
      COALESCE((payload #>> '{client_snapshot,workflow_bindings,required_count}')::int, 0) > 0,
      'client onboarding readiness snapshot reports required workflow bindings'
    )
  ELSE
    skip('public.onboarding_readiness_snapshot_v1 not installed yet', 1)
END
FROM pg_temp.onboarding_readiness_plugin_defaults_result;

SELECT CASE
  WHEN COALESCE((payload->>'have_snapshot')::boolean, FALSE) THEN
    ok(
      NULLIF(payload->>'sender_snapshot_error', '') IS NULL,
      'sender onboarding readiness snapshot returns without error'
    )
  ELSE
    skip('public.onboarding_readiness_snapshot_v1 not installed yet', 1)
END
FROM pg_temp.onboarding_readiness_plugin_defaults_result;

SELECT CASE
  WHEN COALESCE((payload->>'have_snapshot')::boolean, FALSE) THEN
    ok(
      COALESCE(payload #>> '{sender_snapshot,workflow_bindings,status}', '') = 'healthy',
      'sender onboarding readiness snapshot surfaces healthy workflow bindings'
    )
  ELSE
    skip('public.onboarding_readiness_snapshot_v1 not installed yet', 1)
END
FROM pg_temp.onboarding_readiness_plugin_defaults_result;

SELECT CASE
  WHEN COALESCE((payload->>'have_snapshot')::boolean, FALSE) THEN
    ok(
      COALESCE((payload #>> '{sender_snapshot,workflow_bindings,required_count}')::int, 0) > 0,
      'sender onboarding readiness snapshot reports required workflow bindings'
    )
  ELSE
    skip('public.onboarding_readiness_snapshot_v1 not installed yet', 1)
END
FROM pg_temp.onboarding_readiness_plugin_defaults_result;

SELECT CASE
  WHEN COALESCE((payload->>'have_snapshot')::boolean, FALSE) THEN
    ok(
      COALESCE(payload->>'sender_snapshot_scope_type', '') = 'sender',
      'sender onboarding readiness snapshot resolves sender scope'
    )
  ELSE
    skip('public.onboarding_readiness_snapshot_v1 not installed yet', 1)
END
FROM pg_temp.onboarding_readiness_plugin_defaults_result;

SELECT CASE
  WHEN COALESCE((payload->>'have_ui_public')::boolean, FALSE) THEN
    ok(
      NULLIF(payload->>'ui_public_error', '') IS NULL,
      'public.ui_get_onboarding_readiness_v1 returns without error'
    )
  ELSE
    skip('public.ui_get_onboarding_readiness_v1 not installed yet', 1)
END
FROM pg_temp.onboarding_readiness_plugin_defaults_result;

SELECT CASE
  WHEN COALESCE((payload->>'have_ui_public')::boolean, FALSE) THEN
    ok(
      COALESCE(jsonb_typeof(payload->'ui_public') = 'object', FALSE),
      'public.ui_get_onboarding_readiness_v1 returns a JSON object'
    )
  ELSE
    skip('public.ui_get_onboarding_readiness_v1 not installed yet', 1)
END
FROM pg_temp.onboarding_readiness_plugin_defaults_result;

SELECT CASE
  WHEN COALESCE((payload->>'have_ui_public')::boolean, FALSE) THEN
    ok(
      COALESCE(payload->>'ui_public_scope_type', '') = 'tenant',
      'public.ui_get_onboarding_readiness_v1 resolves tenant scope'
    )
  ELSE
    skip('public.ui_get_onboarding_readiness_v1 not installed yet', 1)
END
FROM pg_temp.onboarding_readiness_plugin_defaults_result;

SELECT CASE
  WHEN COALESCE((payload->>'have_ui_api')::boolean, FALSE) THEN
    ok(
      NULLIF(payload->>'ui_api_error', '') IS NULL,
      'api.ui_get_onboarding_readiness_v1 returns without error'
    )
  ELSE
    skip('api.ui_get_onboarding_readiness_v1 not installed yet', 1)
END
FROM pg_temp.onboarding_readiness_plugin_defaults_result;

SELECT CASE
  WHEN COALESCE((payload->>'have_ui_api')::boolean, FALSE) THEN
    ok(
      COALESCE(jsonb_typeof(payload->'ui_api') = 'object', FALSE),
      'api.ui_get_onboarding_readiness_v1 returns a JSON object'
    )
  ELSE
    skip('api.ui_get_onboarding_readiness_v1 not installed yet', 1)
END
FROM pg_temp.onboarding_readiness_plugin_defaults_result;

SELECT CASE
  WHEN COALESCE((payload->>'have_ui_api')::boolean, FALSE) THEN
    ok(
      COALESCE(payload->>'ui_api_scope_type', '') = 'tenant',
      'api.ui_get_onboarding_readiness_v1 resolves tenant scope'
    )
  ELSE
    skip('api.ui_get_onboarding_readiness_v1 not installed yet', 1)
END
FROM pg_temp.onboarding_readiness_plugin_defaults_result;

SELECT * FROM finish();

ROLLBACK;
