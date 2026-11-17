BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(10);

-- pgTAP runs via direct SQL (not PostgREST), so request.jwt.claims is unset by default.
-- Task creation paths require either auth.uid() or role=service_role claims.
SELECT set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'service_role')::text,
  true
);

-- 1) RPC exists (public)
SELECT has_function(
  'public',
  'marketing_lead_request_create_v1',
  ARRAY['text','text','text','text','text','text','text','text','text','jsonb','text','boolean'],
  'marketing_lead_request_create_v1 exists'
);

-- 2) RPC is SECURITY DEFINER
SELECT ok(
  (
    SELECT p.prosecdef
    FROM pg_proc p
    WHERE p.oid = to_regprocedure(
      'public.marketing_lead_request_create_v1(text,text,text,text,text,text,text,text,text,jsonb,text,boolean)'
    )
      AND p.prokind = 'f'
  ),
  'marketing_lead_request_create_v1 is SECURITY DEFINER'
);

-- 3) api wrapper exists
SELECT has_function(
  'api',
  'marketing_lead_request_create_v1',
  ARRAY['text','text','text','text','text','text','text','text','text','jsonb','text','boolean'],
  'api.marketing_lead_request_create_v1 exists'
);

-- 4) service_role can execute api wrapper
SELECT ok(
  has_function_privilege(
    'service_role',
    'api.marketing_lead_request_create_v1(text,text,text,text,text,text,text,text,text,jsonb,text,boolean)',
    'EXECUTE'
  ),
  'service_role can EXECUTE api.marketing_lead_request_create_v1'
);

-- 5) anon cannot execute api wrapper
SELECT ok(
  NOT has_function_privilege(
    'anon',
    'api.marketing_lead_request_create_v1(text,text,text,text,text,text,text,text,text,jsonb,text,boolean)',
    'EXECUTE'
  ),
  'anon cannot EXECUTE api.marketing_lead_request_create_v1'
);

-- 6) authenticated cannot execute api wrapper
SELECT ok(
  NOT has_function_privilege(
    'authenticated',
    'api.marketing_lead_request_create_v1(text,text,text,text,text,text,text,text,text,jsonb,text,boolean)',
    'EXECUTE'
  ),
  'authenticated cannot EXECUTE api.marketing_lead_request_create_v1'
);

-- 7) edge_api_gateway_role can execute api wrapper (least-privilege public intake)
SELECT ok(
  has_function_privilege(
    'edge_api_gateway_role',
    'api.marketing_lead_request_create_v1(text,text,text,text,text,text,text,text,text,jsonb,text,boolean)',
    'EXECUTE'
  ),
  'edge_api_gateway_role can EXECUTE api.marketing_lead_request_create_v1'
);

-- 8) task_type_catalog includes marketing_lead_followup (global default)
SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings s
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value->'task_types', '[]'::jsonb)) AS t(value)
    WHERE s.category = 'task_type_catalog'
      AND s.scope_type = 'global'
      AND lower(NULLIF(btrim(COALESCE(t.value->>'key', '')), '')) = 'marketing_lead_followup'
  ),
  'task_type_catalog includes marketing_lead_followup'
);

-- 9-10) calling lead intake RPC returns ok=true and a task_id (not deduped)
WITH res AS (
  SELECT api.marketing_lead_request_create_v1(
    'lead@example.com',
    'Acme',
    NULL,
    'Ops',
    'Test lead intake.',
    'en',
    NULL,
    NULL,
    NULL,
    '{}'::jsonb,
    NULL,
    TRUE
  ) AS body
)
SELECT ok((body->>'ok') = 'true', 'marketing_lead_request_create_v1 returns ok=true') FROM res;

WITH res AS (
  SELECT api.marketing_lead_request_create_v1(
    'lead2@example.com',
    'Acme',
    NULL,
    'Ops',
    'Test lead intake.',
    'en',
    NULL,
    NULL,
    NULL,
    '{}'::jsonb,
    NULL,
    TRUE
  ) AS body
)
SELECT ok((body->>'task_id') IS NOT NULL, 'marketing_lead_request_create_v1 returns task_id') FROM res;

SELECT finish();

ROLLBACK;
