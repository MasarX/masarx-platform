-- Plan: PLAN-202601-schema-audit-improvements / Step: S95
-- Migration: Extend lookup contracts for domain enum-like columns (row-driven; no hardcoded CHECK IN)
-- Goals:
-- - Add missing lookup categories + seed baseline values (enterprise readiness).
-- - Map core domain columns to lookup categories via public.lookup_column_contracts (SSOT).
-- - Normalize pre-live data to comply with the contracts before enforcing them.
-- - Remove redundant hardcoded CHECK constraints where contract enforcement is the SSOT.

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
-- 2) Seed lookup values (include discovered live values + documented values)
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
-- 3) Normalize pre-live data to comply with SSOT categories
-------------------------------------------------------------------------------

-- Some callers historically used shipments.service_type for the service level (e.g., 'standard').
-- Normalize: move that value into service_level and default service_type to 'delivery'.
UPDATE public.shipments
SET
  service_level = COALESCE(service_level, lower(service_type)),
  service_type = 'delivery',
  updated_at = now()
WHERE service_type IS NOT NULL
  AND lower(service_type) IN ('economy', 'standard', 'premium', 'express');

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
  r record;
BEGIN
  EXECUTE 'ALTER TABLE public.label_jobs DROP CONSTRAINT IF EXISTS label_jobs_status_chk';
  EXECUTE 'ALTER TABLE public.label_jobs DROP CONSTRAINT IF EXISTS label_jobs_job_purpose_chk';

  FOR r IN
    SELECT inhrelid::regclass::text AS child
    FROM pg_inherits
    WHERE inhparent = 'public.label_jobs'::regclass
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT IF EXISTS label_jobs_status_chk', r.child);
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT IF EXISTS label_jobs_job_purpose_chk', r.child);
  END LOOP;
END;
$$;

COMMIT;
