-- Console V2 webhook tester force-status lookup.
--
-- The linked inbox tester reads forced HTTP status options from the live
-- lookup catalog. Keep this row-driven so Browser proof cannot depend on
-- seed-only frontend values.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605210930_console_v2_webhook_forced_status_lookup_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

INSERT INTO public.lookup_definitions (
  category,
  description,
  owner_role,
  approval_policy,
  is_mutable,
  scope_type
)
VALUES (
  'webhook_forced_status',
  'Webhook tester force-status options. metadata.target_status maps HTTP status choices to processing_status.',
  'engineering',
  'tier_1',
  false,
  'global'
)
ON CONFLICT (category) DO UPDATE
SET description = EXCLUDED.description,
    owner_role = EXCLUDED.owner_role,
    approval_policy = EXCLUDED.approval_policy,
    is_mutable = EXCLUDED.is_mutable,
    scope_type = EXCLUDED.scope_type,
    updated_at = now();

WITH definition AS (
  SELECT id
    FROM public.lookup_definitions
   WHERE category = 'webhook_forced_status'
   LIMIT 1
),
rows(value, label, tone, sort_order, is_default, metadata) AS (
  VALUES
    ('auto', 'Auto', 'neutral', 10, true, '{}'::jsonb),
    ('200', '200', 'good', 20, false, '{"target_status":"succeeded"}'::jsonb),
    ('400', '400', 'warn', 30, false, '{"target_status":"failed"}'::jsonb),
    ('422', '422', 'warn', 40, false, '{"target_status":"failed"}'::jsonb),
    ('500', '500', 'danger', 50, false, '{"target_status":"failed"}'::jsonb),
    ('503', '503', 'danger', 60, false, '{"target_status":"failed"}'::jsonb)
)
INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  description,
  sort_order,
  is_default,
  status,
  metadata,
  effective_from,
  created_at,
  updated_at
)
SELECT
  definition.id,
  rows.value,
  rows.label,
  'Console V2 webhook tester force-status option: ' || rows.label,
  rows.sort_order,
  rows.is_default,
  'active',
  rows.metadata || jsonb_build_object('tone', rows.tone),
  now(),
  now(),
  now()
FROM definition
CROSS JOIN rows
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    description = EXCLUDED.description,
    sort_order = EXCLUDED.sort_order,
    is_default = EXCLUDED.is_default,
    status = 'active',
    metadata = EXCLUDED.metadata,
    effective_from = COALESCE(public.lookup_values.effective_from, EXCLUDED.effective_from),
    retired_at = NULL,
    updated_at = now();

SELECT pg_advisory_unlock(hashtext('202605210930_console_v2_webhook_forced_status_lookup_v1'));

COMMIT;
