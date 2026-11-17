-- Migration: Raise default label bundle download concurrency (label_print_policy global)
-- Purpose:
--  - Reduce end-user latency for label bundling by increasing parallel storage downloads.
--  - Keep behavior row-driven (settings ladder still overrides per tenant/client/sender).

BEGIN;

SET search_path TO public, pg_temp;

UPDATE settings_versions
SET
  value = jsonb_set(value, '{bundle_download_concurrency}', '25'::jsonb, TRUE),
  change_reason = 'Raise global label_print_policy.bundle_download_concurrency to 25',
  approved_at = workflow_now(),
  effective_from = workflow_now()
WHERE category = 'label_print_policy'
  AND scope_type = 'global'
  AND scope_hash = '00000000-0000-0000-0000-000000000000'::uuid;

UPDATE settings
SET
  cached_value = jsonb_set(cached_value, '{bundle_download_concurrency}', '25'::jsonb, TRUE),
  last_updated = workflow_now()
WHERE category = 'label_print_policy'
  AND scope_type = 'global'
  AND scope_hash = '00000000-0000-0000-0000-000000000000'::uuid;

COMMIT;

