-- pgTAP: Console V2 finance bulk RPC browser contract
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(10);

SELECT has_function(
  'public',
  'ui_bulk_billing_invoice_send_v1',
  ARRAY['jsonb'],
  'public.ui_bulk_billing_invoice_send_v1(jsonb) is registered'
);

SELECT has_function(
  'api',
  'ui_bulk_billing_invoice_send_v1',
  ARRAY['jsonb'],
  'api.ui_bulk_billing_invoice_send_v1(jsonb) browser wrapper is registered'
);

SELECT has_function(
  'public',
  'ui_bulk_dispute_action_v1',
  ARRAY['jsonb'],
  'public.ui_bulk_dispute_action_v1(jsonb) is registered'
);

SELECT has_function(
  'api',
  'ui_bulk_dispute_action_v1',
  ARRAY['jsonb'],
  'api.ui_bulk_dispute_action_v1(jsonb) browser wrapper is registered'
);

SELECT is(
  (SELECT p.prosecdef
     FROM pg_proc p
     JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public'
      AND p.proname = 'ui_bulk_billing_invoice_send_v1'
    LIMIT 1),
  true,
  'public.ui_bulk_billing_invoice_send_v1 is SECURITY DEFINER'
);

SELECT is(
  (SELECT p.prosecdef
     FROM pg_proc p
     JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public'
      AND p.proname = 'ui_bulk_dispute_action_v1'
    LIMIT 1),
  true,
  'public.ui_bulk_dispute_action_v1 is SECURITY DEFINER'
);

SELECT ok(
  has_function_privilege('authenticated', 'api.ui_bulk_billing_invoice_send_v1(jsonb)', 'EXECUTE'),
  'authenticated can execute api.ui_bulk_billing_invoice_send_v1'
);

SELECT ok(
  has_function_privilege('authenticated', 'api.ui_bulk_dispute_action_v1(jsonb)', 'EXECUTE'),
  'authenticated can execute api.ui_bulk_dispute_action_v1'
);

SELECT ok(
  NOT has_function_privilege('anon', 'api.ui_bulk_billing_invoice_send_v1(jsonb)', 'EXECUTE'),
  'anon cannot execute api.ui_bulk_billing_invoice_send_v1'
);

SELECT ok(
  NOT has_function_privilege('anon', 'api.ui_bulk_dispute_action_v1(jsonb)', 'EXECUTE'),
  'anon cannot execute api.ui_bulk_dispute_action_v1'
);

SELECT * FROM finish();
ROLLBACK;
