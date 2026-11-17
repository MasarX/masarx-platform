-- Plan: PLAN-202601-ladder-phase6-remaining-ladder-hardcoding-ssot / Step: S04
-- Migration: Repair lookup contracts for domain enum-like columns (row-driven; no hardcoded CHECK IN)
-- Rationale:
-- - Some environments may have migration history "repaired" without executing older lookup-contract migrations.
-- - This forward-only migration ensures SSOT lookup values + lookup_column_contracts rows exist and triggers are attached.
-- - Removes redundant enum CHECK constraints where lookup contracts are the SSOT.

BEGIN;

SET search_path TO public, extensions, pg_temp;

-------------------------------------------------------------------------------
-- 1) Ensure lookup categories exist (baseline, row-driven)
-------------------------------------------------------------------------------

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES
  ('service_level', 'Shipment service level (economy/standard/premium/express)', 'operations', 'tier_1', false),
  ('barcode_format', 'Supported barcode symbologies for labels', 'engineering', 'tier_1', false),
  ('box_status', 'Shipment box lifecycle status', 'operations', 'tier_1', false),
  ('campaign_enrollment_status', 'Campaign enrollment lifecycle status', 'operations', 'tier_1', false),
  ('manual_review_task_status', 'Manual review task lifecycle status', 'operations', 'tier_1', false),
  ('manual_review_task_type', 'Manual review task type', 'engineering', 'tier_1', false),
  ('label_job_status', 'Label job lifecycle status', 'engineering', 'tier_1', false),
  ('label_job_purpose', 'Label job purpose (primary/reprint/manual)', 'engineering', 'tier_1', false)
ON CONFLICT (category) DO NOTHING;

-------------------------------------------------------------------------------
-- 2) Seed lookup values (baseline values required for enforcement + tests)
-------------------------------------------------------------------------------

INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, status)
SELECT d.id, v.value, v.label, v.sort_order, v.is_default, 'active'
FROM public.lookup_definitions d
JOIN (
  VALUES
    -- shipments.service_level (already a column; make it governed)
    ('service_level', 'economy', 'Economy', 10, true),
    ('service_level', 'standard', 'Standard', 20, false),
    ('service_level', 'premium', 'Premium', 30, false),
    ('service_level', 'express', 'Express', 40, false),

    -- labels.barcode_format
    ('barcode_format', 'CODE128', 'Code 128', 10, true),
    ('barcode_format', 'QR', 'QR', 20, false),
    ('barcode_format', 'GS1_128', 'GS1-128', 30, false),
    ('barcode_format', 'EAN13', 'EAN-13', 40, false),

    -- shipment_boxes.status
    ('box_status', 'pending', 'Pending', 10, true),
    ('box_status', 'scanned', 'Scanned', 20, false),
    ('box_status', 'in_transit', 'In Transit', 30, false),
    ('box_status', 'delivered', 'Delivered', 40, false),
    ('box_status', 'missing', 'Missing', 50, false),

    -- campaign_enrollments.status
    ('campaign_enrollment_status', 'enrolled', 'Enrolled', 10, true),
    ('campaign_enrollment_status', 'dispatched', 'Dispatched', 20, false),
    ('campaign_enrollment_status', 'completed', 'Completed', 30, false),
    ('campaign_enrollment_status', 'cancelled', 'Cancelled', 40, false),

    -- manual_review_tasks.status / task_type
    ('manual_review_task_status', 'pending', 'Pending', 10, true),
    ('manual_review_task_status', 'assigned', 'Assigned', 20, false),
    ('manual_review_task_status', 'escalated', 'Escalated', 30, false),
    ('manual_review_task_status', 'resolved', 'Resolved', 40, false),
    ('manual_review_task_type', 'geocoding', 'Geocoding', 10, true),
    ('manual_review_task_type', 'settings_approval', 'Settings Approval', 20, false),

    -- label_jobs.status / job_purpose
    ('label_job_status', 'pending', 'Pending', 10, true),
    ('label_job_status', 'in_progress', 'In Progress', 20, false),
    ('label_job_status', 'succeeded', 'Succeeded', 30, false),
    ('label_job_status', 'failed', 'Failed', 40, false),
    ('label_job_purpose', 'primary', 'Primary', 10, true),
    ('label_job_purpose', 'reprint', 'Reprint', 20, false),
    ('label_job_purpose', 'manual', 'Manual', 30, false),

    -- shipment_status: add missing live/test values (must be allowed before enforcing)
    ('shipment_status', 'created', 'Created', 5, false),
    ('shipment_status', 'pending_dispatch', 'Pending Dispatch', 15, false),

    -- geocoding_attempt_type: align SSOT lookup with existing check constraints + tests
    ('geocoding_attempt_type', 'local', 'Local', 60, false),

    -- integration_type: webhook source kinds (provider_type column semantics)
    ('integration_type', 'client', 'Client', 10, true),
    ('integration_type', 'provider', 'Provider', 15, false),
    ('integration_type', 'shopify', 'Shopify', 20, false),
    ('integration_type', 'woocommerce', 'WooCommerce', 30, false),
    ('integration_type', 'generic', 'Generic', 40, false),
    ('integration_type', 'custom_erp', 'Custom ERP', 50, false),
    ('integration_type', 'erp', 'ERP', 60, false),
    ('integration_type', 'async_3pl', 'Async 3PL', 70, false),
    ('integration_type', 'communications', 'Communications', 80, false),
    ('integration_type', 'delivery_provider', 'Delivery Provider', 90, false),

    -- label_type: required for labels/label_jobs and must not be empty
    ('label_type', 'shipping', 'Shipping', 10, true),
    ('label_type', 'return', 'Return', 20, false),
    ('label_type', 'customs', 'Customs', 30, false)
) v(category, value, label, sort_order, is_default)
  ON d.category = v.category
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

-------------------------------------------------------------------------------
-- 3) Normalize pre-live data to comply with SSOT categories (config-driven)
-------------------------------------------------------------------------------

WITH service_level_values AS (
  SELECT lv.value
  FROM public.lookup_definitions d
  JOIN public.lookup_values lv ON lv.lookup_definition_id = d.id
  WHERE d.category = 'service_level'
    AND lv.retired_at IS NULL
    AND lv.status = 'active'
),
default_service_type AS (
  SELECT lv.value
  FROM public.lookup_definitions d
  JOIN public.lookup_values lv ON lv.lookup_definition_id = d.id
  WHERE d.category = 'service_type'
    AND lv.retired_at IS NULL
    AND lv.status = 'active'
    AND lv.is_default IS TRUE
  ORDER BY lv.sort_order NULLS LAST, lv.created_at
  LIMIT 1
)
UPDATE public.shipments s
SET
  service_level = COALESCE(s.service_level, lower(s.service_type)),
  service_type = (SELECT value FROM default_service_type),
  updated_at = now()
WHERE s.service_type IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM service_level_values sl
    WHERE sl.value = lower(s.service_type)
  );

-------------------------------------------------------------------------------
-- 4) Extend lookup column contracts (SSOT mappings)
-------------------------------------------------------------------------------

INSERT INTO public.lookup_column_contracts (table_schema, table_name, column_name, lookup_category)
VALUES
  ('public', 'shipments', 'status', 'shipment_status'),
  ('public', 'shipments', 'service_type', 'service_type'),
  ('public', 'shipments', 'service_level', 'service_level'),
  ('public', 'shipment_boxes', 'status', 'box_status'),
  ('public', 'labels', 'label_type', 'label_type'),
  ('public', 'labels', 'barcode_format', 'barcode_format'),
  ('public', 'label_jobs', 'label_type', 'label_type'),
  ('public', 'label_jobs', 'status', 'label_job_status'),
  ('public', 'label_jobs', 'job_purpose', 'label_job_purpose'),
  ('public', 'campaign_enrollments', 'status', 'campaign_enrollment_status'),
  ('public', 'manual_review_tasks', 'status', 'manual_review_task_status'),
  ('public', 'manual_review_tasks', 'task_type', 'manual_review_task_type'),
  ('public', 'webhook_sources', 'provider_type', 'integration_type'),
  ('public', 'webhook_inbox', 'provider_type', 'integration_type'),
  ('public', 'baskets', 'basket_type', 'basket_type'),
  ('public', 'baskets', 'state', 'basket_state'),
  ('public', 'shipment_reference_numbers', 'reference_type', 'shipment_reference_type')
ON CONFLICT ON CONSTRAINT lookup_column_contracts_unique DO NOTHING;

-------------------------------------------------------------------------------
-- 5) Apply triggers for all affected tables (row-driven; no per-table hardcoding)
-------------------------------------------------------------------------------

SELECT public.apply_lookup_column_contracts('public');

-------------------------------------------------------------------------------
-- 6) Remove redundant hardcoded enum CHECK constraints where lookup contracts are SSOT
-------------------------------------------------------------------------------

DO $$
DECLARE
  v_parent REGCLASS;
  v_table REGCLASS;
  v_status_attnum SMALLINT;
  v_purpose_attnum SMALLINT;
  r record;
BEGIN
  v_parent := to_regclass('public.label_jobs');
  IF v_parent IS NULL THEN
    RETURN;
  END IF;

  FOR v_table IN
    SELECT v_parent
    UNION ALL
    SELECT inhrelid::regclass
    FROM pg_inherits
    WHERE inhparent = v_parent
  LOOP
    SELECT a.attnum
    INTO v_status_attnum
    FROM pg_attribute a
    WHERE a.attrelid = v_table
      AND a.attname = 'status'
      AND a.attisdropped = false;

    SELECT a.attnum
    INTO v_purpose_attnum
    FROM pg_attribute a
    WHERE a.attrelid = v_table
      AND a.attname = 'job_purpose'
      AND a.attisdropped = false;

    FOR r IN
      SELECT c.conname
      FROM pg_constraint c
      WHERE c.conrelid = v_table
        AND c.contype = 'c'
        AND (
          (v_status_attnum IS NOT NULL AND v_status_attnum = ANY (c.conkey))
          OR (v_purpose_attnum IS NOT NULL AND v_purpose_attnum = ANY (c.conkey))
        )
    LOOP
      EXECUTE format('ALTER TABLE %s DROP CONSTRAINT IF EXISTS %I', v_table::text, r.conname);
    END LOOP;
  END LOOP;
END;
$$;

COMMIT;

