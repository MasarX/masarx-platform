-- Test Suite: Settings upsert helpers are SSOT-driven (no hardcoded scope ladders)

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(6);

SELECT ok(
  to_regprocedure('public.upsert_settings_value_v1(text,text,uuid,jsonb,integer,text)') IS NOT NULL,
  'upsert_settings_value_v1 exists'
);

SELECT ok(
  to_regprocedure('public.upsert_webhook_ingest_policy(text,uuid,jsonb)') IS NOT NULL,
  'upsert_webhook_ingest_policy exists'
);

SELECT ok(
  to_regprocedure('public.upsert_tenant_domain_event_policy(uuid,jsonb)') IS NOT NULL,
  'upsert_tenant_domain_event_policy exists'
);

DO $$
DECLARE
  v_def TEXT;
BEGIN
  v_def := pg_get_functiondef('public.upsert_webhook_ingest_policy(text,uuid,jsonb)'::regprocedure);
  PERFORM ok(v_def LIKE '%upsert_settings_value_v1%', 'upsert_webhook_ingest_policy delegates to upsert_settings_value_v1');
  PERFORM ok(v_def NOT LIKE '%ARRAY[''global''%', 'upsert_webhook_ingest_policy does not hardcode allowed scope types');
  PERFORM ok(v_def NOT LIKE '%00000000-0000-0000-0000-000000000000%', 'upsert_webhook_ingest_policy does not hardcode NIL UUID sentinel');
END $$;

SELECT finish();

ROLLBACK;

