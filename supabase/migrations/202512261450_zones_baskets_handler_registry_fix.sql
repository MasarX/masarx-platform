-- Migration: Zones + Baskets handler registry fix
-- Purpose:
--   - Ensure zone_assign + basket_assign handlers exist before workflow step repairs.
-- Alignment: SIMPLE | SCALABLE | DYNAMIC | SSOT | ZERO-HARDCODING
-- Date: 2025-12-26

BEGIN;

SET search_path TO public, workflow_handlers, extensions, pg_temp;

INSERT INTO public.operation_handlers AS oh (
  handler_key,
  handler_schema,
  handler_name,
  handler_signature,
  handler_version,
  is_active,
  notes,
  doc_url
)
VALUES (
  'zone_assign',
  'workflow_handlers',
  'execute_zone_assign_v1',
  '(public.workflow_run_steps,public.workflow_runs,jsonb)',
  'v1',
  TRUE,
  'Assign shipment zone_id from canonical district mapping (zones/zone_districts).',
  'docs/ops/plans/PLAN-202512-zones-baskets.md'
)
ON CONFLICT (handler_key) DO UPDATE
SET handler_schema = EXCLUDED.handler_schema,
    handler_name = EXCLUDED.handler_name,
    handler_signature = EXCLUDED.handler_signature,
    handler_version = EXCLUDED.handler_version,
    is_active = EXCLUDED.is_active,
    notes = EXCLUDED.notes,
    doc_url = EXCLUDED.doc_url,
    updated_at = now();

INSERT INTO public.operation_handlers AS oh (
  handler_key,
  handler_schema,
  handler_name,
  handler_signature,
  handler_version,
  is_active,
  notes,
  doc_url
)
VALUES (
  'basket_assign',
  'workflow_handlers',
  'execute_basket_assign_v1',
  '(public.workflow_run_steps,public.workflow_runs,jsonb)',
  'v1',
  TRUE,
  'Assign shipment to basket using basket_policy (settings ladder).',
  'docs/ops/plans/PLAN-202512-zones-baskets.md'
)
ON CONFLICT (handler_key) DO UPDATE
SET handler_schema = EXCLUDED.handler_schema,
    handler_name = EXCLUDED.handler_name,
    handler_signature = EXCLUDED.handler_signature,
    handler_version = EXCLUDED.handler_version,
    is_active = EXCLUDED.is_active,
    notes = EXCLUDED.notes,
    doc_url = EXCLUDED.doc_url,
    updated_at = now();

COMMIT;
