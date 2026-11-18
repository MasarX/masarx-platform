BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(15);

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

-- 8) edge_api_gateway_role can execute public implementation through the api wrapper
SELECT ok(
  has_function_privilege(
    'edge_api_gateway_role',
    'public.marketing_lead_request_create_v1(text,text,text,text,text,text,text,text,text,jsonb,text,boolean)',
    'EXECUTE'
  ),
  'edge_api_gateway_role can EXECUTE public.marketing_lead_request_create_v1'
);

-- 9) task_type_catalog includes marketing_lead_followup (global default)
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

-- 10-11) calling lead intake RPC returns ok=true and a task_id (not deduped)
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

-- 12-15) duplicate marketing lead intake returns the existing backend reference.
CREATE TEMP TABLE tmp_marketing_lead_dedupe_readback (
  seq INT PRIMARY KEY,
  body JSONB NOT NULL
) ON COMMIT DROP;

INSERT INTO tmp_marketing_lead_dedupe_readback(seq, body)
SELECT 1, api.marketing_lead_request_create_v1(
  'lead-dedupe-reference-readback@example.com',
  'Acme Dedupe',
  '10k-60k',
  'Ops',
  'First lead intake.',
  'en',
  NULL,
  NULL,
  NULL,
  '{}'::jsonb,
  NULL,
  TRUE
);

INSERT INTO tmp_marketing_lead_dedupe_readback(seq, body)
SELECT 2, api.marketing_lead_request_create_v1(
  'lead-dedupe-reference-readback@example.com',
  'Acme Dedupe',
  '10k-60k',
  'Ops',
  'Second duplicate lead intake.',
  'en',
  NULL,
  NULL,
  NULL,
  '{}'::jsonb,
  NULL,
  TRUE
);

SELECT ok((body->>'ok') = 'true' AND NULLIF(body->>'id', '') IS NOT NULL, 'first marketing lead intake returns id')
  FROM tmp_marketing_lead_dedupe_readback
 WHERE seq = 1;

SELECT ok((body->>'deduped') = 'true', 'duplicate marketing lead intake is marked deduped')
  FROM tmp_marketing_lead_dedupe_readback
 WHERE seq = 2;

SELECT is(
  second_res.body->>'id',
  first_res.body->>'id',
  'duplicate marketing lead intake returns existing lead id'
)
  FROM tmp_marketing_lead_dedupe_readback first_res
  JOIN tmp_marketing_lead_dedupe_readback second_res ON second_res.seq = 2
 WHERE first_res.seq = 1;

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.marketing_demo_requests r
    WHERE r.id = NULLIF(second_res.body->>'id', '')::uuid
      AND r.email = 'lead-dedupe-reference-readback@example.com'
  ),
  'duplicate marketing lead reference points to the persisted lead row'
)
  FROM tmp_marketing_lead_dedupe_readback second_res
 WHERE second_res.seq = 2;

SELECT finish();

ROLLBACK;
