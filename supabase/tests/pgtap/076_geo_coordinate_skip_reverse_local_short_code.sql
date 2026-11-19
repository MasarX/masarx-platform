-- Test Suite: Coordinate handler skips reverse_local for short-codes
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(30);

SET search_path TO public, pgtap, extensions;

-- -----------------------------------------------------------------------------
-- Fixture data
-- -----------------------------------------------------------------------------
-- This fixture owns source-binding setup, so defer bootstrap until client/sender
-- context exists and fail-closed plugin activation has truthful binding inputs.
SELECT set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);

INSERT INTO public.organizations (id, name, slug)
VALUES ('07600000-0000-0000-0000-000000000001', 'PGTAP Geo Org 076', 'pgtap-geo-076')
ON CONFLICT (id) DO NOTHING;

SELECT set_config('app.organization_onboarding_source', '', true);

INSERT INTO public.clients (id, organization_id, name, slug, status)
VALUES (
  '07600000-0000-0000-0000-000000000002',
  '07600000-0000-0000-0000-000000000001',
  'PGTAP Geo Client 076',
  'pgtap-geo-client-076',
  'active'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status)
VALUES (
  '07600000-0000-0000-0000-000000000003',
  '07600000-0000-0000-0000-000000000002',
  'PGTAP Geo Sender 076',
  'PGTAP Geo Sender 076',
  TRUE,
  'active'
)
ON CONFLICT (id) DO NOTHING;

SELECT public.bootstrap_tenant_onboarding_v1(
  '07600000-0000-0000-0000-000000000001',
  'pgtap:geo-coordinate-skip-reverse-local-short-code-fixture-bootstrap'
);

INSERT INTO public.addresses (
  id,
  organization_id,
  client_id,
  raw_input,
  line1,
  city,
  province,
  country,
  validation_status,
  sa_short_code,
  created_at,
  updated_at
) VALUES (
  '07600000-0000-0000-0000-000000000004',
  '07600000-0000-0000-0000-000000000001',
  '07600000-0000-0000-0000-000000000002',
  '{"line1":"ABCD1234","country":"SA"}',
  'ABCD1234',
  'Riyadh',
  'Riyadh',
  'SA',
  'pending',
  'ABCD1234',
  now(),
  now()
)
ON CONFLICT (id, client_id) DO NOTHING;

INSERT INTO public.workflow_templates (
  id,
  name,
  description,
  version,
  status,
  scope_type
) VALUES (
  '07600000-0000-0000-0000-000000000005',
  'pgtap_geo_coordinate_076',
  'PGTAP coordinate skip reverse_local for short-code',
  1,
  'active',
  'global'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.workflow_template_steps (
  id,
  workflow_template_id,
  sequence_order,
  operation_name,
  transition_condition,
  handler_key,
  handler_version,
  enabled
) VALUES (
  '07600000-0000-0000-0000-000000000006',
  '07600000-0000-0000-0000-000000000005',
  1,
  'validate_coordinates',
  'always',
  'geo_coordinate',
  'v1',
  TRUE
)
ON CONFLICT (id) DO NOTHING;

-- Workflow guardrails require app.workflow_run_id context for inserts.
SELECT set_config('app.workflow_run_id', '07600000-0000-0000-0000-000000000007', true);

INSERT INTO public.workflow_runs (
  id,
  workflow_template_id,
  workflow_template_version,
  entry_point,
  workflow_status,
  context
) VALUES (
  '07600000-0000-0000-0000-000000000007',
  '07600000-0000-0000-0000-000000000005',
  1,
  'pgtap',
  'pending',
  jsonb_build_object(
    'organization_id', '07600000-0000-0000-0000-000000000001',
    'client_id', '07600000-0000-0000-0000-000000000002',
    'sender_id', '07600000-0000-0000-0000-000000000003',
    'address_id', '07600000-0000-0000-0000-000000000004',
    'shipment', jsonb_build_object(
      'coordinates', jsonb_build_object('latitude', 24.7, 'longitude', 46.7)
    ),
    'geocoding', jsonb_build_object(
      'short_code', 'ABCD1234'
    )
  )
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.workflow_run_steps (
  id,
  workflow_run_id,
  workflow_template_step_id,
  sequence_order,
  step_status,
  operation_name,
  handler_key,
  handler_version,
  max_retries,
  enqueued_at,
  created_at,
  updated_at
) VALUES (
  '07600000-0000-0000-0000-000000000008',
  '07600000-0000-0000-0000-000000000007',
  '07600000-0000-0000-0000-000000000006',
  1,
  'pending',
  'validate_coordinates',
  'geo_coordinate',
  'v1',
  1,
  now(),
  now(),
  now()
)
ON CONFLICT (id) DO NOTHING;

WITH policy AS (
  SELECT jsonb_build_object(
    'matching_plugins', jsonb_build_array(
      jsonb_build_object(
        'name', 'reverse',
        'enabled', TRUE
      ),
      jsonb_build_object(
        'name', 'reverse_local',
        'enabled', TRUE,
        'params', jsonb_build_object(
          'skip_when_short_code', TRUE,
          'confidence', 0.99
        )
      )
    )
  ) AS value
),
settings_version AS (
  SELECT *
  FROM public.upsert_settings_value_v1(
    'geocoding_policy',
    'sender',
    '07600000-0000-0000-0000-000000000003'::uuid,
    (SELECT value FROM policy),
    1,
    'pgtap: 076_geo_coordinate_skip_reverse_local_short_code policy seed'
  )
)
SELECT 1 FROM settings_version;

DELETE FROM public.settings_cache
WHERE cache_key LIKE 'geocoding_policy:%';

CREATE TEMP TABLE tmp_geo_coordinate_076 AS
SELECT workflow_handlers.execute_geo_coordinate_v1(
  (SELECT wrs FROM public.workflow_run_steps wrs WHERE id = '07600000-0000-0000-0000-000000000008'),
  (SELECT wr FROM public.workflow_runs wr WHERE id = '07600000-0000-0000-0000-000000000007'),
  '{}'::jsonb
) AS resp;

-- Second run: omit geocoding.short_code and intentionally mismatch client_id in context.
-- Short-code presence should still be detected from the persisted address row.

INSERT INTO public.clients (id, organization_id, name, slug, status)
VALUES (
  '07600000-0000-0000-0000-00000000000A',
  '07600000-0000-0000-0000-000000000001',
  'PGTAP Geo Client 076 (mismatch)',
  'pgtap-geo-client-076-mismatch',
  'active'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status)
VALUES (
  '07600000-0000-0000-0000-00000000000B',
  '07600000-0000-0000-0000-00000000000A',
  'PGTAP Geo Sender 076 (mismatch)',
  'PGTAP Geo Sender 076 (mismatch)',
  TRUE,
  'active'
)
ON CONFLICT (id) DO NOTHING;

-- Mutate the existing workflow run context (guardrails-safe because app.workflow_run_id stays aligned)
-- to simulate the mismatched client_id case.
UPDATE public.workflow_runs
SET context = jsonb_set(
  jsonb_set(
    (context #- '{geocoding,short_code}'),
    '{client_id}',
    to_jsonb('07600000-0000-0000-0000-00000000000A'::text),
    true
  ),
  '{sender_id}',
  to_jsonb('07600000-0000-0000-0000-00000000000B'::text),
  true
)
WHERE id = '07600000-0000-0000-0000-000000000007';

CREATE TEMP TABLE tmp_geo_coordinate_076_mismatch AS
SELECT workflow_handlers.execute_geo_coordinate_v1(
  (SELECT wrs FROM public.workflow_run_steps wrs WHERE id = '07600000-0000-0000-0000-000000000008'),
  (SELECT wr FROM public.workflow_runs wr WHERE id = '07600000-0000-0000-0000-000000000007'),
  '{}'::jsonb
) AS resp;

-- -----------------------------------------------------------------------------
-- Assertions
-- -----------------------------------------------------------------------------
SELECT is(
  (SELECT (resp).operation_result->>'short_code_present' FROM tmp_geo_coordinate_076),
  'true',
  'coordinate handler detects short_code'
);

SELECT is(
  (SELECT (resp).operation_result->>'skip_local_when_short_code' FROM tmp_geo_coordinate_076),
  'true',
  'coordinate handler applies skip_when_short_code policy'
);

SELECT ok(
  COALESCE((SELECT (((resp).context_patch->'geocoding'->>'reverse_geocode')::boolean) FROM tmp_geo_coordinate_076), FALSE),
  'coordinate handler sets reverse_geocode when skipping reverse_local'
);

SELECT ok(
  (SELECT (resp).operation_result->'local_reverse_match' IS NULL FROM tmp_geo_coordinate_076),
  'coordinate handler does not emit local_reverse_match when skipped'
);

SELECT is(
  (SELECT (resp).operation_result->>'short_code_present' FROM tmp_geo_coordinate_076_mismatch),
  'true',
  'coordinate handler detects short_code from persisted address even when client_id mismatched'
);

SELECT ok(
  COALESCE((SELECT (((resp).context_patch->'geocoding'->>'reverse_geocode')::boolean) FROM tmp_geo_coordinate_076_mismatch), FALSE),
  'coordinate handler sets reverse_geocode when skipping reverse_local (mismatched client)'
);


-- F279 uses the existing owned run/step; all polygon/policy/attempt writes roll back.
CREATE TEMP TABLE f279_coordinate_matrix(
 label text, actual_valid boolean, expected_valid boolean,
 actual_local boolean, expected_local boolean, reverse_requested boolean,
 exact_attempt_lineage boolean
) ON COMMIT DROP;
DO $f279$
DECLARE
 r public.workflow_runs; s public.workflow_run_steps;
 baseline jsonb; policy jsonb; c record; reply public.workflow_handler_response;
 exact_lineage boolean;
BEGIN
 SELECT * INTO STRICT r FROM public.workflow_runs WHERE id='07600000-0000-0000-0000-000000000007';
 SELECT * INTO STRICT s FROM public.workflow_run_steps WHERE id='07600000-0000-0000-0000-000000000008';
 -- Restore original owned lineage after the preceding mismatch scenario.
 r.context:=r.context||jsonb_build_object('client_id','07600000-0000-0000-0000-000000000002',
  'sender_id','07600000-0000-0000-0000-000000000003');
 baseline:=public.resolve_settings('geocoding_policy','sender','07600000-0000-0000-0000-000000000003');
 INSERT INTO public.sa_regions(id,name_en) VALUES(-279001,'F279 rollback region');
 INSERT INTO public.sa_cities(id,region_id,name_en) VALUES(-279001,-279001,'F279 rollback city');
 INSERT INTO public.sa_districts(id,city_id,region_id,name_en,geom)
 VALUES(-279001,-279001,-279001,'F279 rollback district',ST_MakeEnvelope(46.6999,24.6999,46.7001,24.7001,4326));
 PERFORM set_config('app.workflow_run_step_id',s.id::text,true);
 FOR c IN SELECT * FROM (VALUES
  ('local-false',false,true,false,true,false,false),
  ('local-true',true,true,false,true,true,false),
  ('local-absent',NULL::boolean,true,false,true,true,false),
  ('disabled',true,false,false,false,false,false),
  ('invalid-bounds',true,true,false,false,false,true),
  ('external-false',false,true,true,true,false,false)
 ) x(label,flag,enabled,skip_local,valid,local_match,invalid_coords)
 LOOP
  policy:=jsonb_set(baseline,'{matching_plugins}',jsonb_build_array(
   jsonb_build_object('name','reverse','enabled',c.enabled),
   jsonb_build_object('name','reverse_local','enabled',true,'params',
    jsonb_build_object('skip_when_short_code',c.skip_local,'confidence',0.99))));
  PERFORM public.upsert_settings_value_v1('geocoding_policy','sender',
   '07600000-0000-0000-0000-000000000003',policy,1,'F279 rollback matrix');
  r.context:=jsonb_set(r.context,'{geocoding}',jsonb_build_object('short_code','ABCD1234'));
  IF c.flag IS NOT NULL THEN
   r.context:=jsonb_set(r.context,'{geocoding,reverse_geocode}',to_jsonb(c.flag),true);
  END IF;
  r.context:=jsonb_set(r.context,'{shipment,coordinates}',jsonb_build_object(
   'latitude',CASE WHEN c.invalid_coords THEN 91 ELSE 24.7 END,'longitude',46.7));
  s.metadata:=COALESCE(s.metadata,'{}')||'{"validate_bounds":true}'::jsonb;
  -- Each case logs against its actual persisted owned run, then rolls back
  -- attempts and decisions without deleting any earlier evidence.
  BEGIN
   UPDATE public.workflow_runs SET context=r.context WHERE id=r.id;
   reply:=workflow_handlers.execute_geo_coordinate_v1(s,r,'{}');
   IF c.local_match THEN
    SELECT EXISTS(SELECT 1 FROM public.geocoding_attempts a
     WHERE a.id=(reply.operation_result#>>'{local_reverse_match,attempt_id}')::uuid
       AND a.address_id='07600000-0000-0000-0000-000000000004'
       AND a.organization_id='07600000-0000-0000-0000-000000000001'
       AND a.client_id='07600000-0000-0000-0000-000000000002'
       AND a.sender_id='07600000-0000-0000-0000-000000000003'
       AND a.workflow_run_step_id=s.id AND a.provider_name='reverse_local'
       AND a.attempt_order=1 AND a.status='succeeded'
       AND a.metadata->>'match_source'='sa_polygons'
       AND a.metadata#>>'{geocode,metadata,sa_district_id}'='-279001')
     AND reply.operation_result#>>'{local_reverse_match,district_id}'='-279001'
    INTO exact_lineage;
   ELSE
    SELECT NOT EXISTS(SELECT 1 FROM public.geocoding_attempts a
     WHERE a.workflow_run_step_id=s.id AND a.provider_name='reverse_local')
    INTO exact_lineage;
   END IF;
   RAISE EXCEPTION USING ERRCODE='PZ279',MESSAGE='F279 rollback case';
  EXCEPTION WHEN SQLSTATE 'PZ279' THEN NULL;
  END;
  INSERT INTO f279_coordinate_matrix VALUES(c.label,
   (reply.operation_result->>'within_bounds')::boolean,c.valid,
   reply.operation_result->'local_reverse_match' IS NOT NULL,c.local_match,
   COALESCE((reply.context_patch#>>'{geocoding,reverse_geocode}')::boolean,false),
   exact_lineage);
 END LOOP;
END;
$f279$;
SELECT is(actual_valid,expected_valid,label||': coordinate validation preserved') FROM f279_coordinate_matrix ORDER BY label;
SELECT is(actual_local,expected_local,label||': local polygon routing exact') FROM f279_coordinate_matrix ORDER BY label;
SELECT is(reverse_requested,false,label||': no unintended external reverse') FROM f279_coordinate_matrix ORDER BY label;
SELECT is(exact_attempt_lineage,true,label||': exact owned polygon attempt lineage') FROM f279_coordinate_matrix ORDER BY label;
SELECT finish();

ROLLBACK;
