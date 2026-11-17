-- Migration: Disable duplicate create_shipment step from async_provider_dispatch_v1
-- Purpose: Ensure only the sequence 0 shipment_create step is active

BEGIN;

SET search_path TO public, pg_temp;

DO $$
DECLARE
  v_tpl UUID;
BEGIN
  SELECT id INTO v_tpl FROM workflow_templates WHERE name = 'async_provider_dispatch_v1' LIMIT 1;
  IF v_tpl IS NOT NULL THEN
    UPDATE workflow_template_steps
       SET enabled = FALSE, updated_at = now()
     WHERE workflow_template_id = v_tpl
       AND handler_key = 'shipment_create'
       AND sequence_order <> 0;
  END IF;
END $$;

COMMIT;