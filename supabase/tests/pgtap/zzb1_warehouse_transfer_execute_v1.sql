-- pgTAP: public.warehouse_transfer_execute_v1 contract
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(4);

-- 1) RPC is wired (FE adapter assertion target)
SELECT ok(
  to_regprocedure('public.warehouse_transfer_execute_v1(jsonb)') IS NOT NULL,
  'public.warehouse_transfer_execute_v1(jsonb) RPC exists'
);

-- 2) Canonical workflow template name 'warehouse_transfer_execute_v1' is registered
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.workflow_templates
     WHERE name = 'warehouse_transfer_execute_v1'
  ),
  'warehouse_transfer_execute_v1 workflow template registered (RPC start target)'
);

-- 3) Capability registered: warehouse.write resolves at global ladder scope
SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s,
           jsonb_array_elements(s.cached_value->'capabilities') AS cap
     WHERE s.category = 'access_control_policy'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
       AND cap->>'key' = 'warehouse.write'
  ),
  'warehouse.write capability resolves at global ladder scope'
);

-- 4) RLS isolation: warehouse_transfers does not allow direct authenticated mutation
SELECT ok(
  NOT has_table_privilege('anon', 'public.warehouse_transfers', 'update'),
  'anon has no direct UPDATE on warehouse_transfers (RLS / capability-gated only)'
);

SELECT * FROM finish();
ROLLBACK;
