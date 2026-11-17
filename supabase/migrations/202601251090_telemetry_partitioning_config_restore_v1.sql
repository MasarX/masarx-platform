-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S04
-- Migration: Telemetry partitioning_config restore v1 (log posture + partition security)
-- Date: 2026-01-25
--
-- Purpose:
--   - Telemetry ledgers (location_pings, scan_events) are HASH+RANGE time-partitioned and must be
--     registered in partitioning_config (SSOT enforced by pgTAP).
--   - All HASH+RANGE tables in partitioning_config are treated as log/ops tables:
--       - Parents and all descendants must have RLS enabled
--       - No anon/authenticated table privileges on parents/partitions
--       - Service-only access; clients write via RPCs (SECURITY DEFINER) instead of table grants

BEGIN;
SELECT pg_advisory_lock(hashtext('202601251090_telemetry_partitioning_config_restore_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-- Restore partitioning_config rows (if removed) with supported retention policies.
INSERT INTO public.partitioning_config (
  table_name,
  partition_strategy,
  partition_key,
  partition_interval,
  partitions_ahead,
  retention_months,
  config
)
VALUES
  (
    'location_pings',
    'HASH+RANGE',
    'organization_id|captured_at',
    'monthly',
    NULL,
    3,
    '{"hash_modulus": 1, "range_interval": "monthly", "retention_policy": "delete"}'::jsonb
  ),
  (
    'scan_events',
    'HASH+RANGE',
    'organization_id|captured_at',
    'monthly',
    NULL,
    12,
    '{"hash_modulus": 1, "range_interval": "monthly", "retention_policy": "delete"}'::jsonb
  )
ON CONFLICT (table_name) DO UPDATE
SET
  partition_strategy = EXCLUDED.partition_strategy,
  partition_key = EXCLUDED.partition_key,
  partition_interval = EXCLUDED.partition_interval,
  partitions_ahead = EXCLUDED.partitions_ahead,
  retention_months = EXCLUDED.retention_months,
  config = EXCLUDED.config,
  updated_at = now();

-- Enforce log-table privilege posture on parents (no anon/auth grants).
REVOKE ALL ON TABLE public.location_pings FROM authenticated;
REVOKE ALL ON TABLE public.location_pings FROM anon;
REVOKE ALL ON TABLE public.scan_events FROM authenticated;
REVOKE ALL ON TABLE public.scan_events FROM anon;

-- Ensure HASH parents are locked down (RLS enabled + service_role policy; prevents bypass).
DO $$
BEGIN
  IF to_regclass('public.location_pings_p0') IS NOT NULL THEN
    PERFORM public.enforce_service_only_rls_v1('public.location_pings_p0'::regclass);
  END IF;

  IF to_regclass('public.scan_events_p0') IS NOT NULL THEN
    PERFORM public.enforce_service_only_rls_v1('public.scan_events_p0'::regclass);
  END IF;
END $$;

-- Ensure future partitions exist (idempotent) and are locked down on creation.
SELECT * FROM public.create_next_partitions();

SELECT pg_advisory_unlock(hashtext('202601251090_telemetry_partitioning_config_restore_v1'));
COMMIT;

