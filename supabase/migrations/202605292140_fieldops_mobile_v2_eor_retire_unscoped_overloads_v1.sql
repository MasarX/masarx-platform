-- Migration: FieldOps Mobile V2 EOR retire unscoped overloads
-- Date: 2026-05-29
--
-- Purpose:
--   Mobile V2 EOR reconciliation is route-run scoped through the seven-arg
--   submit_fieldops_eod_recon_v1 contract. The retired six-arg overloads can
--   write decision_log rows without route lineage, which breaks same-context
--   latest reconciliation readback and creates an ambiguous browser/API
--   contract. Keep only the route-scoped public implementation and api wrapper.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605292140_fieldops_mobile_v2_eor_retire_unscoped_overloads_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
BEGIN
  IF to_regprocedure('public.submit_fieldops_eod_recon_v1(integer, integer, numeric, numeric, text, uuid, uuid)') IS NULL THEN
    RAISE EXCEPTION 'Cannot retire unscoped EOR overload: route-scoped public.submit_fieldops_eod_recon_v1 is missing';
  END IF;

  IF to_regprocedure('api.submit_fieldops_eod_recon_v1(integer, integer, numeric, numeric, text, uuid, uuid)') IS NULL THEN
    RAISE EXCEPTION 'Cannot retire unscoped EOR overload: route-scoped api.submit_fieldops_eod_recon_v1 is missing';
  END IF;
END $$;

DROP FUNCTION IF EXISTS api.submit_fieldops_eod_recon_v1(INT, INT, NUMERIC, NUMERIC, TEXT, UUID);
DROP FUNCTION IF EXISTS public.submit_fieldops_eod_recon_v1(INT, INT, NUMERIC, NUMERIC, TEXT, UUID);

DO $$
BEGIN
  IF to_regprocedure('api.submit_fieldops_eod_recon_v1(integer, integer, numeric, numeric, text, uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'Retired unscoped api.submit_fieldops_eod_recon_v1 overload still exists';
  END IF;

  IF to_regprocedure('public.submit_fieldops_eod_recon_v1(integer, integer, numeric, numeric, text, uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'Retired unscoped public.submit_fieldops_eod_recon_v1 overload still exists';
  END IF;

  IF to_regprocedure('public.submit_fieldops_eod_recon_v1(integer, integer, numeric, numeric, text, uuid, uuid)') IS NULL THEN
    RAISE EXCEPTION 'Route-scoped public.submit_fieldops_eod_recon_v1 was not preserved';
  END IF;

  IF to_regprocedure('api.submit_fieldops_eod_recon_v1(integer, integer, numeric, numeric, text, uuid, uuid)') IS NULL THEN
    RAISE EXCEPTION 'Route-scoped api.submit_fieldops_eod_recon_v1 was not preserved';
  END IF;
END $$;

SELECT pg_advisory_unlock(hashtext('202605292140_fieldops_mobile_v2_eor_retire_unscoped_overloads_v1'));
COMMIT;
