-- pgTAP: Console V2 NDR resolution keeps the browser-safe UI wrapper
-- authenticated/capability-gated while temporarily elevating only the
-- service-only apply chain.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(8);

SELECT has_function(
  'public',
  'ui_execute_dispatch_exception_resolution_v1',
  ARRAY['text', 'text', 'text[]', 'text', 'integer', 'jsonb'],
  'public.ui_execute_dispatch_exception_resolution_v1(text, text, text[], text, integer, jsonb) exists'
);

SELECT has_function(
  'api',
  'ui_execute_dispatch_exception_resolution_v1',
  ARRAY['text', 'text', 'text[]', 'text', 'integer', 'jsonb'],
  'api.ui_execute_dispatch_exception_resolution_v1(text, text, text[], text, integer, jsonb) exists'
);

SELECT ok(
  has_function_privilege(
    'authenticated',
    'api.ui_execute_dispatch_exception_resolution_v1(text, text, text[], text, integer, jsonb)',
    'EXECUTE'
  ),
  'authenticated can execute api.ui_execute_dispatch_exception_resolution_v1'
);

WITH def AS (
  SELECT pg_get_functiondef('public.ui_execute_dispatch_exception_resolution_v1(text, text, text[], text, integer, jsonb)'::regprocedure) AS sql
)
SELECT ok(
  def.sql LIKE '%public.assert_capability_v1(v_capability, v_scope_type, v_scope_id)%',
  'public wrapper checks the row-driven command capability before resolution execution'
)
FROM def;

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings
    CROSS JOIN LATERAL jsonb_array_elements(cached_value->'commands') AS command
    WHERE category = 'ui_command_registry'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND command->>'key' = 'exceptions.resolve'
      AND command->>'capability' = 'tasks.write'
      AND command#>>'{route_targets,console,path}' = '/operate/exceptions'
  ),
  'exceptions.resolve command is registered to /operate/exceptions with tasks.write'
);

WITH def AS (
  SELECT pg_get_functiondef('public.ui_execute_dispatch_exception_resolution_v1(text, text, text[], text, integer, jsonb)'::regprocedure) AS sql
)
SELECT ok(
  def.sql LIKE '%jsonb_build_object(%'
    AND def.sql LIKE '%''role'', ''service_role''%',
  'public wrapper prepares temporary service_role JWT claims for service-only helpers'
)
FROM def;

WITH def AS (
  SELECT pg_get_functiondef('public.ui_execute_dispatch_exception_resolution_v1(text, text, text[], text, integer, jsonb)'::regprocedure) AS sql
)
SELECT ok(
  def.sql LIKE '%public.apply_dispatch_exception_resolution_v1(%'
    AND def.sql LIKE '%set_config(''request.jwt.claims'', v_elevated_claims::text, true)%'
    AND def.sql LIKE '%set_config(''request.jwt.claims'', v_prev_claims, true)%',
  'apply chain runs under temporary claims and restores original operator claims'
)
FROM def;

WITH def AS (
  SELECT pg_get_functiondef('public.ui_execute_dispatch_exception_resolution_v1(text, text, text[], text, integer, jsonb)'::regprocedure) AS sql
)
SELECT ok(
  def.sql LIKE '%EXCEPTION%'
    AND def.sql LIKE '%WHEN others THEN%'
    AND def.sql LIKE '%set_config(''request.jwt.claims'', v_prev_claims, true)%'
    AND def.sql LIKE '%RAISE%',
  'public wrapper restores operator claims on error'
)
FROM def;

SELECT * FROM finish();

ROLLBACK;
