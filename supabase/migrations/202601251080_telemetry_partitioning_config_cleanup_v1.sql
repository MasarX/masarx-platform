-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S04
-- Migration: Telemetry partitioning_config cleanup v1 (exclude user-facing tables)
-- Date: 2026-01-25
--
-- Purpose:
--   - `partitioning_config` is treated as a service-only "log/ops" partition registry and is
--     enforced by pgTAP to have NO anon/authenticated table privileges on parents/descendants.
--   - User-facing telemetry tables (location_pings, scan_events) must remain partitioned, but
--     must NOT live in partitioning_config to avoid being treated as log tables.
--   - Future: introduce a dedicated telemetry partition registry + maintenance job (separate plan).

BEGIN;
SELECT pg_advisory_lock(hashtext('202601251080_telemetry_partitioning_config_cleanup_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DELETE FROM public.partitioning_config
WHERE table_name IN ('location_pings', 'scan_events');

SELECT pg_advisory_unlock(hashtext('202601251080_telemetry_partitioning_config_cleanup_v1'));
COMMIT;

