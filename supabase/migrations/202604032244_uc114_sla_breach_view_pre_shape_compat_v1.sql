-- Plan: B09 Exception, reattempt & returns loop
-- Migration: UC114 NDR SLA breach view pre-shape compatibility v1
-- Date: 2026-04-03
--
-- Purpose:
--   - Allow 202604032245_uc114_ndr_sla_sweeper_reporting_v1.sql to run
--     against environments where the SLA breach reporting view was already
--     widened outside the recorded migration order.
--   - Preserve append-only migration history by pre-shaping the dependent
--     API/public views before the original UC114 migration recreates them.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604032244_uc114_sla_breach_view_pre_shape_compat_v1'));
SET search_path TO public, api, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DROP VIEW IF EXISTS api.dispatch_exception_review_sla_breaches_v;
DROP VIEW IF EXISTS public.dispatch_exception_review_sla_breaches_v;

SELECT pg_advisory_unlock(hashtext('202604032244_uc114_sla_breach_view_pre_shape_compat_v1'));
COMMIT;
