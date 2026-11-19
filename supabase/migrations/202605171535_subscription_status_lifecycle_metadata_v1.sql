-- Migration: Subscription status lifecycle metadata repair
-- Date: 2026-05-17
--
-- Console V2 cancellation actions are row-driven from subscription_status
-- metadata. Shared/live rows already had is_final on some terminal statuses,
-- but lifecycle was missing, so canceled subscriptions could still expose the
-- cancel action after backend readback.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605171535_subscription_status_lifecycle_metadata_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

WITH subscription_status_definition AS (
  SELECT id
  FROM public.lookup_definitions
  WHERE category = 'subscription_status'
)
UPDATE public.lookup_values lv
SET metadata = COALESCE(lv.metadata, '{}'::jsonb) || jsonb_build_object('lifecycle', 'terminal', 'is_final', true),
    updated_at = now()
FROM subscription_status_definition d
WHERE lv.lookup_definition_id = d.id
  AND lv.value IN ('canceled', 'expired', 'ended');

WITH subscription_status_definition AS (
  SELECT id
  FROM public.lookup_definitions
  WHERE category = 'subscription_status'
)
UPDATE public.lookup_values lv
SET metadata = COALESCE(lv.metadata, '{}'::jsonb) || jsonb_build_object('lifecycle', 'active', 'is_final', false),
    updated_at = now()
FROM subscription_status_definition d
WHERE lv.lookup_definition_id = d.id
  AND lv.value IN ('active', 'paused');

COMMIT;
