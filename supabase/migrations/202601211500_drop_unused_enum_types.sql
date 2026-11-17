-- Plan: PLAN-202601-schema-audit-improvements / Step: S95
-- Migration: Remove unused legacy ENUM types to eliminate redundancy and reduce schema confusion.
-- Notes:
--   - These types are not referenced by any column or function in the current schema.
--   - Business enumerations are governed via lookup tables (lookup_definitions/lookup_values) instead.

BEGIN;

DROP TYPE IF EXISTS public.shipment_status;
DROP TYPE IF EXISTS public.service_type;
DROP TYPE IF EXISTS public.priority_level;

COMMIT;

