-- Plan: PLAN-202604-b06-closeout / Step: Seed target-neutral label_type lookup values

BEGIN;

SELECT pg_advisory_lock(hashtext('202604102290_uc078_label_type_lookup_target_neutral_v1'));
SET search_path TO public, pg_temp;
SET LOCAL lock_timeout = '30s';

INSERT INTO public.lookup_values (
  id,
  lookup_definition_id,
  value,
  label,
  description,
  sort_order,
  is_default,
  status,
  metadata
)
SELECT
  gen_random_uuid(),
  ld.id,
  v.value,
  v.label,
  v.description,
  v.sort_order,
  false,
  'active',
  '{}'::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (
  VALUES
    ('route', 'Route', 'Target-neutral route label type', 40),
    ('container', 'Container', 'Target-neutral container label type', 50),
    ('transfer', 'Transfer', 'Target-neutral transfer label type', 60)
) AS v(value, label, description, sort_order)
WHERE ld.category = 'label_type'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

SELECT pg_advisory_unlock(hashtext('202604102290_uc078_label_type_lookup_target_neutral_v1'));

COMMIT;
