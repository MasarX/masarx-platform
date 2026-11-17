-- Plan: PLAN-202603-fieldops-mobile-ux-connectivity-feature-completion-v1 / Step: S08
-- pgTAP: FieldOps mobile sync policy + artifact/exception command contract

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(31);

CREATE OR REPLACE FUNCTION pg_temp.read_delivery_handover_lookup_count()
RETURNS INT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org UUID := gen_random_uuid();
  v_user UUID := gen_random_uuid();
  v_count INT := 0;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'FieldOps Lookup Org', 'fieldops-lookup-' || left(v_org::text, 8));

  INSERT INTO public.users (id, organization_id, email, full_name, access_scope_type)
  VALUES (v_user, v_org, 'lookup-' || left(v_user::text, 8) || '@example.com', 'Lookup Driver', 'tenant');

  PERFORM public.provision_rbac_roles_from_templates_v1(v_org, ARRAY['driver'], v_user);

  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, assigned_by_user_id, metadata)
  SELECT v_org, v_user, r.id, v_user, jsonb_build_object('seed', TRUE, 'source', 'pgtap', 'template_key', r.key)
  FROM public.rbac_roles r
  WHERE r.organization_id = v_org
    AND r.key = 'driver'
  ON CONFLICT DO NOTHING;

  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('role', 'authenticated', 'sub', v_user::text)::text,
    true
  );

  SELECT COUNT(*)::int
    INTO v_count
    FROM public.list_lookup_values_v1('delivery_handover_mode');

  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', 'postgres', true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'postgres')::text, true);

  RETURN v_count;
END;
$function$;

SELECT has_function(
  'public',
  'resolve_mobile_sync_policy',
  ARRAY['jsonb'],
  'public.resolve_mobile_sync_policy(jsonb) exists'
);

SELECT has_function(
  'api',
  'resolve_mobile_sync_policy',
  ARRAY['jsonb'],
  'api.resolve_mobile_sync_policy(jsonb) exists'
);

SELECT has_function(
  'public',
  'register_mobile_artifact_v1',
  ARRAY['jsonb'],
  'public.register_mobile_artifact_v1(jsonb) exists'
);

SELECT has_function(
  'api',
  'register_mobile_artifact_v1',
  ARRAY['jsonb'],
  'api.register_mobile_artifact_v1(jsonb) exists'
);

SELECT has_function(
  'public',
  'list_lookup_values_v1',
  ARRAY['text'],
  'public.list_lookup_values_v1(text) exists'
);

SELECT has_function(
  'api',
  'list_lookup_values_v1',
  ARRAY['text'],
  'api.list_lookup_values_v1(text) exists'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
     WHERE s.category = 'mobile_sync_policy'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
  ),
  'mobile_sync_policy global settings row exists'
);

SELECT ok(
  (
    SELECT COALESCE((r.value->>'enabled')::boolean, FALSE)
      FROM public.resolve_mobile_sync_policy('{}'::jsonb) AS r
     LIMIT 1
  ),
  'resolve_mobile_sync_policy returns enabled=true by default'
);

SELECT ok(
  (
    SELECT COALESCE((r.value->>'sync_batch_size')::int, 0)
      FROM public.resolve_mobile_sync_policy('{}'::jsonb) AS r
     LIMIT 1
  ) > 0,
  'resolve_mobile_sync_policy returns positive sync_batch_size'
);

SELECT ok(
  (
    SELECT cmd->'execution'->>'payload_key'
      FROM public.settings s,
           LATERAL jsonb_array_elements(COALESCE(s.cached_value->'commands', '[]'::jsonb)) AS cmd
     WHERE s.category = 'ui_command_registry'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
       AND cmd->>'key' = 'tasks.exception'
     LIMIT 1
  ) = 'payload',
  'tasks.exception command uses execution.payload_key=payload'
);

SELECT ok(
  (
    SELECT cmd->'execution'->'params'->>'handler'
      FROM public.settings s,
           LATERAL jsonb_array_elements(COALESCE(s.cached_value->'commands', '[]'::jsonb)) AS cmd
     WHERE s.category = 'ui_command_registry'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
       AND cmd->>'key' = 'tasks.complete'
     LIMIT 1
  ) = 'task_transition',
  'tasks.complete command uses execution.params.handler=task_transition'
);

SELECT ok(
  (
    SELECT cmd->'execution'->'params'->>'handler'
      FROM public.settings s,
           LATERAL jsonb_array_elements(COALESCE(s.cached_value->'commands', '[]'::jsonb)) AS cmd
     WHERE s.category = 'ui_command_registry'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
       AND cmd->>'key' = 'tasks.exception'
     LIMIT 1
  ) = 'task_transition',
  'tasks.exception command uses execution.params.handler=task_transition'
);

SELECT ok(
  (
    SELECT EXISTS (
      SELECT 1
        FROM public.settings s,
             LATERAL jsonb_array_elements(COALESCE(s.cached_value->'commands', '[]'::jsonb)) AS cmd,
             LATERAL jsonb_array_elements(COALESCE(cmd->'execution'->'input_schema'->'fields', '[]'::jsonb)) AS field
       WHERE s.category = 'ui_command_registry'
         AND s.scope_type = 'global'
         AND s.scope_id IS NULL
         AND cmd->>'key' = 'tasks.exception'
         AND field->>'key' = 'exception_reason'
         AND field->>'type' = 'lookup'
         AND field->>'lookup_category' = 'dispatch_exception_reason'
    )
  ),
  'tasks.exception command declares exception_reason lookup schema'
);

SELECT ok(
  (
    SELECT EXISTS (
      SELECT 1
        FROM public.settings s,
             LATERAL jsonb_array_elements(COALESCE(s.cached_value->'commands', '[]'::jsonb)) AS cmd,
             LATERAL jsonb_array_elements(COALESCE(cmd->'execution'->'input_schema'->'fields', '[]'::jsonb)) AS field
       WHERE s.category = 'ui_command_registry'
         AND s.scope_type = 'global'
         AND s.scope_id IS NULL
         AND cmd->>'key' = 'tasks.complete'
         AND field->>'key' = 'completion_notes'
         AND field->>'type' = 'textarea'
    )
  ),
  'tasks.complete command declares completion_notes input schema'
);

SELECT ok(
  (
    SELECT EXISTS (
      SELECT 1
        FROM public.settings s,
             LATERAL jsonb_array_elements(COALESCE(s.cached_value->'commands', '[]'::jsonb)) AS cmd,
             LATERAL jsonb_array_elements(COALESCE(cmd->'execution'->'input_schema'->'fields', '[]'::jsonb)) AS field
       WHERE s.category = 'ui_command_registry'
         AND s.scope_type = 'global'
         AND s.scope_id IS NULL
         AND cmd->>'key' = 'tasks.complete'
         AND field->>'key' = 'recipient_name'
         AND COALESCE(field->>'type', 'text') = 'text'
    )
  ),
  'tasks.complete command declares recipient_name input schema'
);

SELECT ok(
  (
    SELECT EXISTS (
      SELECT 1
        FROM public.settings s,
             LATERAL jsonb_array_elements(COALESCE(s.cached_value->'commands', '[]'::jsonb)) AS cmd,
             LATERAL jsonb_array_elements(COALESCE(cmd->'execution'->'input_schema'->'fields', '[]'::jsonb)) AS field
       WHERE s.category = 'ui_command_registry'
         AND s.scope_type = 'global'
         AND s.scope_id IS NULL
         AND cmd->>'key' = 'tasks.complete'
         AND field->>'key' = 'handover_mode'
         AND field->>'type' = 'lookup'
         AND field->>'lookup_category' = 'delivery_handover_mode'
    )
  ),
  'tasks.complete command declares handover_mode lookup schema'
);

SELECT ok(
  (
    SELECT EXISTS (
      SELECT 1
        FROM public.settings s,
             LATERAL jsonb_array_elements(COALESCE(s.cached_value->'commands', '[]'::jsonb)) AS cmd,
             LATERAL jsonb_array_elements(COALESCE(cmd->'execution'->'input_schema'->'fields', '[]'::jsonb)) AS field
       WHERE s.category = 'ui_command_registry'
         AND s.scope_type = 'global'
         AND s.scope_id IS NULL
         AND cmd->>'key' = 'tasks.complete'
         AND field->>'key' = 'handover_mode'
         AND COALESCE(field->>'default_value', '') = 'named_recipient'
    )
  ),
  'tasks.complete handover_mode defaults to named_recipient'
);

SELECT ok(
  (
    SELECT EXISTS (
      SELECT 1
        FROM public.settings s,
             LATERAL jsonb_array_elements(COALESCE(s.cached_value->'commands', '[]'::jsonb)) AS cmd,
             LATERAL jsonb_array_elements(COALESCE(cmd->'execution'->'input_schema'->'fields', '[]'::jsonb)) AS field
       WHERE s.category = 'ui_command_registry'
         AND s.scope_type = 'global'
         AND s.scope_id IS NULL
         AND cmd->>'key' = 'tasks.complete'
         AND field->>'key' = 'recipient_class'
         AND COALESCE(field->>'type', 'text') = 'text'
    )
  ),
  'tasks.complete command declares recipient_class input schema'
);

SELECT ok(
  (
    SELECT pg_temp.read_delivery_handover_lookup_count()
  ) >= 5,
  'delivery_handover_mode lookup is readable for a tasks.complete-capable authenticated operator'
);

SELECT ok(
  (
    SELECT NOT EXISTS (
      SELECT 1
        FROM public.settings s,
             LATERAL jsonb_array_elements(COALESCE(s.cached_value->'commands', '[]'::jsonb)) AS cmd
       WHERE s.category = 'ui_command_registry'
         AND cmd->>'key' IN ('tasks.complete', 'tasks.exception')
         AND COALESCE(cmd->'execution'->>'payload_key', '') <> 'payload'
    )
  ),
  'all scoped task commands enforce execution.payload_key=payload'
);

SELECT ok(
  (
    SELECT NOT EXISTS (
      SELECT 1
        FROM public.settings s,
             LATERAL jsonb_array_elements(COALESCE(s.cached_value->'commands', '[]'::jsonb)) AS cmd
       WHERE s.category = 'ui_command_registry'
         AND cmd->>'key' IN ('tasks.complete', 'tasks.exception')
         AND COALESCE(cmd->'execution'->'params'->>'handler', '') <> 'task_transition'
    )
  ),
  'all scoped task commands keep execution.params.handler=task_transition'
);

SELECT ok(
  (
    SELECT NOT EXISTS (
      SELECT 1
        FROM public.settings s,
             LATERAL jsonb_array_elements(COALESCE(s.cached_value->'commands', '[]'::jsonb)) AS cmd
       WHERE s.category = 'ui_command_registry'
         AND cmd->>'key' IN ('tasks.en_route', 'tasks.arrived')
         AND COALESCE(cmd->'execution'->'params'->>'handler', '') <> 'task_transition'
    )
  ),
  'all scoped route progress commands keep execution.params.handler=task_transition'
);

SELECT ok(
  (
    SELECT NOT EXISTS (
      SELECT 1
        FROM public.settings s,
             LATERAL jsonb_array_elements(COALESCE(s.cached_value->'commands', '[]'::jsonb)) AS cmd
       WHERE s.category = 'ui_command_registry'
         AND cmd->>'key' = 'tasks.en_route'
         AND COALESCE(cmd->'execution'->'params'->>'to_status', '') <> 'in_progress'
    )
  ),
  'all scoped tasks.en_route commands keep execution.params.to_status=in_progress'
);

SELECT ok(
  (
    SELECT NOT EXISTS (
      SELECT 1
        FROM public.settings s,
             LATERAL jsonb_array_elements(COALESCE(s.cached_value->'commands', '[]'::jsonb)) AS cmd
       WHERE s.category = 'ui_command_registry'
         AND cmd->>'key' = 'tasks.en_route'
         AND COALESCE(cmd->'execution'->'params'->>'status_reason', '') <> 'en_route'
    )
  ),
  'all scoped tasks.en_route commands keep execution.params.status_reason=en_route'
);

SELECT ok(
  (
    SELECT NOT EXISTS (
      SELECT 1
        FROM public.settings s,
             LATERAL jsonb_array_elements(COALESCE(s.cached_value->'commands', '[]'::jsonb)) AS cmd
       WHERE s.category = 'ui_command_registry'
         AND cmd->>'key' = 'tasks.arrived'
         AND COALESCE(cmd->'execution'->'params'->>'to_status', '') <> 'in_progress'
    )
  ),
  'all scoped tasks.arrived commands keep execution.params.to_status=in_progress'
);

SELECT ok(
  (
    SELECT NOT EXISTS (
      SELECT 1
        FROM public.settings s,
             LATERAL jsonb_array_elements(COALESCE(s.cached_value->'commands', '[]'::jsonb)) AS cmd
       WHERE s.category = 'ui_command_registry'
         AND cmd->>'key' = 'tasks.arrived'
         AND COALESCE(cmd->'execution'->'params'->>'status_reason', '') <> 'arrived'
    )
  ),
  'all scoped tasks.arrived commands keep execution.params.status_reason=arrived'
);

SELECT ok(
  (
    SELECT NOT EXISTS (
      SELECT 1
        FROM public.settings s,
             LATERAL jsonb_array_elements(COALESCE(s.cached_value->'commands', '[]'::jsonb)) AS cmd
       WHERE s.category = 'ui_command_registry'
         AND cmd->>'key' = 'tasks.complete'
         AND COALESCE(cmd->'execution'->'params'->>'to_status', '') <> 'completed'
    )
  ),
  'all scoped tasks.complete commands keep execution.params.to_status=completed'
);

SELECT ok(
  (
    SELECT NOT EXISTS (
      SELECT 1
        FROM public.settings s,
             LATERAL jsonb_array_elements(COALESCE(s.cached_value->'commands', '[]'::jsonb)) AS cmd
       WHERE s.category = 'ui_command_registry'
         AND cmd->>'key' = 'tasks.exception'
         AND COALESCE(cmd->'execution'->'params'->>'to_status', '') <> 'exception'
    )
  ),
  'all scoped tasks.exception commands keep execution.params.to_status=exception'
);

SELECT ok(
  (
    SELECT NOT EXISTS (
      SELECT 1
        FROM public.settings s,
             LATERAL jsonb_array_elements(COALESCE(s.cached_value->'commands', '[]'::jsonb)) AS cmd
       WHERE s.category = 'ui_command_registry'
         AND cmd->>'key' = 'tasks.exception'
         AND NOT EXISTS (
           SELECT 1
             FROM jsonb_array_elements(COALESCE(cmd->'execution'->'input_schema'->'fields', '[]'::jsonb)) AS field
            WHERE field->>'key' = 'exception_reason'
              AND field->>'type' = 'lookup'
              AND field->>'lookup_category' = 'dispatch_exception_reason'
         )
    )
  ),
  'all scoped tasks.exception commands include exception_reason lookup schema'
);

SELECT ok(
  position(
    'IF v_handler = ''task_transition'' THEN' IN
    pg_get_functiondef('public.ui_execute_command_v1(text,text,text[],text,integer,jsonb)'::regprocedure)
  ) > 0,
  'ui_execute_command_v1 retains task_transition handler support'
);

SELECT throws_ok(
  $$ SELECT public.register_mobile_artifact_v1('{}'::jsonb); $$,
  '42501',
  'register_mobile_artifact_v1 requires authenticated user',
  'register_mobile_artifact_v1 fails closed for unauthenticated context'
);

SELECT * FROM finish();
ROLLBACK;
