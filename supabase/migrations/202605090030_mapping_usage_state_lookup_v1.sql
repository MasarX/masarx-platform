-- Seed Console V2 mapping usage-state lookup rows.
--
-- Mapping studio renders usage state through lookup_values so operator labels
-- and chip tones stay row-driven instead of hardcoded in the frontend.

BEGIN;

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

INSERT INTO public.lookup_definitions (
  id,
  category,
  description,
  owner_role,
  approval_policy,
  is_mutable,
  created_at,
  updated_at
)
VALUES (
  gen_random_uuid(),
  'mapping_usage_state',
  'Mapping config usage-state taxonomy projecting mapping directory usage onto Console labels and tones.',
  'operations',
  'tier_1',
  false,
  now(),
  now()
)
ON CONFLICT (category) DO UPDATE
SET description = EXCLUDED.description,
    owner_role = EXCLUDED.owner_role,
    approval_policy = EXCLUDED.approval_policy,
    is_mutable = EXCLUDED.is_mutable,
    updated_at = now();

WITH definition AS (
  SELECT id
    FROM public.lookup_definitions
   WHERE category = 'mapping_usage_state'
),
seed(value, label, description, sort_order, is_default, metadata) AS (
  VALUES
    ('unused', 'Unused', 'Mapping has no active source or rule usage.', 10, true,  '{"tone":"neutral"}'::jsonb),
    ('in_use', 'In use', 'Mapping is referenced by active source or rule usage.', 20, false, '{"tone":"good"}'::jsonb)
)
INSERT INTO public.lookup_values (
  id,
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
  gen_random_uuid(),
  definition.id,
  seed.value,
  seed.label,
  seed.description,
  seed.sort_order,
  seed.is_default,
  'active',
  seed.metadata,
  now(),
  now(),
  now()
FROM definition
CROSS JOIN seed
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    description = EXCLUDED.description,
    sort_order = EXCLUDED.sort_order,
    is_default = EXCLUDED.is_default,
    status = 'active',
    metadata = EXCLUDED.metadata,
    effective_from = COALESCE(public.lookup_values.effective_from, EXCLUDED.effective_from),
    updated_at = now();

COMMIT;
