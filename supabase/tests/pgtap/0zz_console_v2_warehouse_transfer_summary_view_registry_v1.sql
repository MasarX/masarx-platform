BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(4);

SELECT is(
  (
    SELECT item->>'relation'
    FROM jsonb_array_elements(public.ui_read_registry_v1()->'resources') AS item
    WHERE item->>'key' = 'warehouse_transfer_summary'
    LIMIT 1
  ),
  'v_warehouse_transfer_summary',
  'warehouse_transfer_summary stays pinned to the canonical projection view'
);

SELECT is(
  (
    SELECT item->>'allow_view_relation'
    FROM jsonb_array_elements(public.ui_read_registry_v1()->'resources') AS item
    WHERE item->>'key' = 'warehouse_transfer_summary'
    LIMIT 1
  ),
  'true',
  'warehouse_transfer_summary explicitly opts into security-invoker view reads'
);

SELECT lives_ok(
  $$ SELECT public.ui_list_resource_v1('warehouse_transfer_summary', '{}'::jsonb, 5, 0, '{"key":"updated_at","direction":"desc"}'::jsonb) $$,
  'ui_list_resource_v1 can read warehouse_transfer_summary through the generic Console V2 substrate'
);

SELECT is(
  public.ui_list_resource_v1('warehouse_transfer_summary', '{}'::jsonb, 5, 0, '{"key":"updated_at","direction":"desc"}'::jsonb)->>'resource',
  'warehouse_transfer_summary',
  'ui_list_resource_v1 returns the warehouse_transfer_summary resource key'
);

SELECT * FROM finish();

ROLLBACK;
