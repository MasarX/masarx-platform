SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(6);

WITH commands AS (
  SELECT item
  FROM jsonb_array_elements(public.ui_command_registry_v1()->'commands') AS e(item)
)
SELECT is(
  (
    SELECT item#>>'{route_targets,console,path}'
    FROM commands
    WHERE item->>'key' = 'invoices.send'
  ),
  '/finance/billing',
  'Send invoice remains discoverable from the Billing module'
);

WITH commands AS (
  SELECT item
  FROM jsonb_array_elements(public.ui_command_registry_v1()->'commands') AS e(item)
)
SELECT is(
  (
    SELECT item#>>'{route_targets,console,path}'
    FROM commands
    WHERE item->>'key' = 'invoices.record_refund'
  ),
  '/finance/billing',
  'Record refund remains discoverable from the Billing module'
);

WITH commands AS (
  SELECT item
  FROM jsonb_array_elements(public.ui_command_registry_v1()->'commands') AS e(item)
)
SELECT is(
  (
    SELECT item#>>'{route_targets,console,path}'
    FROM commands
    WHERE item->>'key' = 'invoices.add_line'
  ),
  NULL,
  'Add invoice line has no Console route until its workflow exists'
);

WITH commands AS (
  SELECT item
  FROM jsonb_array_elements(public.ui_command_registry_v1()->'commands') AS e(item)
)
SELECT is(
  (
    SELECT item#>>'{route_targets,console,path}'
    FROM commands
    WHERE item->>'key' = 'invoices.remove_line'
  ),
  NULL,
  'Remove invoice line has no Console route until its workflow exists'
);

WITH commands AS (
  SELECT item
  FROM jsonb_array_elements(public.ui_command_registry_v1()->'commands') AS e(item)
)
SELECT is(
  (
    SELECT item#>>'{route_targets,console,path}'
    FROM commands
    WHERE item->>'key' = 'invoices.mark_paid'
  ),
  '/finance/billing',
  'Record invoice payment is discoverable from the Billing module once the payment workflow exists'
);

WITH commands AS (
  SELECT item
  FROM jsonb_array_elements(public.ui_command_registry_v1()->'commands') AS e(item)
)
SELECT is(
  (
    SELECT item#>>'{route_targets,console,path}'
    FROM commands
    WHERE item->>'key' = 'invoices.reissue'
  ),
  NULL,
  'Re-issue invoice has no Console route until its workflow exists'
);

SELECT * FROM finish();
ROLLBACK;
