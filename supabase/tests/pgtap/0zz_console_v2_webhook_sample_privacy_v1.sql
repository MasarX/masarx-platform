BEGIN;
SET LOCAL search_path TO public, pgtap, extensions, pg_temp;
SELECT plan(1);

SELECT is(
  public.console_v2_project_json_v1(
    '{"key":"sample-shipment","records":[{"count":1,"Cookie":{"value":"sample"},"access_token":"sample"}]}'::jsonb,
    '"operator_sample"'::jsonb
  ),
  '{"key":"sample-shipment","records":[{"count":1,"Cookie":"[redacted]","access_token":"[redacted]"}]}'::jsonb,
  'mapping remediation keeps input paths and excludes nested credential values'
);

SELECT * FROM finish();
ROLLBACK;
