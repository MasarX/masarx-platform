-- Cover update_user_profile_v1 self-managed decision outcomes.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605031620_user_profile_decision_outcome_coverage_v1'));
SET search_path TO public, extensions, pg_temp;

WITH outcomes(value, label, sort_order) AS (
  VALUES
    ('managed_updated', 'Managed Updated', 2080),
    ('self_updated', 'Self Updated', 2090)
),
definition AS (
  SELECT id
    FROM public.lookup_definitions
   WHERE category = 'decision_outcome'
   LIMIT 1
)
INSERT INTO public.lookup_values (
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
  d.id,
  o.value,
  o.label,
  'Decision outcome emitted by canonical user profile RPCs.',
  o.sort_order,
  FALSE,
  'active',
  jsonb_build_object('source', 'user_profile_decision_outcome_coverage_v1')
FROM definition d
CROSS JOIN outcomes o
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

SELECT pg_advisory_unlock(hashtext('202605031620_user_profile_decision_outcome_coverage_v1'));
COMMIT;
