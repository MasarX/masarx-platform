-- Test: operation_templates.call_type and outbound HTTP handler hardcoding-free

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(6);

-- 1) Column exists on operation_templates
SELECT has_column('public', 'operation_templates', 'call_type', 'operation_templates.call_type exists');

-- 2) Column has NOT NULL constraint
SELECT col_not_null('public', 'operation_templates', 'call_type', 'operation_templates.call_type is NOT NULL');

-- 3) Lookup contract enforces allowed values (row-driven; no hardcoded enum CHECK)
SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.lookup_column_contracts lc
    WHERE lc.table_schema = 'public'
      AND lc.table_name = 'operation_templates'
      AND lc.column_name = 'call_type'
      AND lc.lookup_category = 'call_type'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class rel ON rel.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = rel.relnamespace
    WHERE n.nspname = 'public'
      AND rel.relname = 'operation_templates'
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ILIKE '%call_type%'
      AND pg_get_constraintdef(c.oid) ILIKE '%provider_api%'
      AND pg_get_constraintdef(c.oid) ILIKE '%client_webhook%'
      AND pg_get_constraintdef(c.oid) ILIKE '%comms_sms%'
      AND pg_get_constraintdef(c.oid) ILIKE '%comms_whatsapp%'
      AND pg_get_constraintdef(c.oid) ILIKE '%comms_email%'
      AND pg_get_constraintdef(c.oid) ILIKE '%comms_voice%'
  ),
  'operation_templates.call_type governed by lookup contract (no hardcoded enum CHECK)'
);

-- 4) Default is provider_api
SELECT ok(
  (
    SELECT column_default IS NOT NULL AND column_default ILIKE '%provider_api%'
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'operation_templates'
      AND column_name = 'call_type'
  ),
  'operation_templates.call_type has provider_api default'
);

-- 5) Handler uses call_type instead of hardcoded mapping (no enqueue_notification switch)
SELECT ok(
  (
    SELECT position('enqueue_notification' in pg_get_functiondef(
             'workflow_handlers.execute_outbound_http_v1(public.workflow_run_steps, public.workflow_runs, jsonb)'::regprocedure
           )) = 0
  ),
  'execute_outbound_http_v1 does not hardcode channel mapping by operation name'
);

-- 6) Handler references v_operation.call_type or step metadata call_type
SELECT ok(
  (
    SELECT pg_get_functiondef('workflow_handlers.execute_outbound_http_v1(public.workflow_run_steps, public.workflow_runs, jsonb)'::regprocedure)
           ILIKE '%call_type%'
  ),
  'execute_outbound_http_v1 reads call_type dynamically'
);

SELECT * FROM finish();

ROLLBACK;

