-- Seed lookup coverage for import job cancellation decision logs.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605031650_import_job_cancel_decision_lookup_v1'));
SET search_path TO public, extensions, pg_temp;

WITH categories(value, label, description, sort_order) AS (
  VALUES
    ('imports.create', 'Import Job Create', 'Decision category emitted by import_job_create_v1.', 1890),
    ('imports.cancel', 'Import Job Cancel', 'Decision category emitted by import_job_cancel_v1.', 1900)
),
definition AS (
  SELECT id
    FROM public.lookup_definitions
   WHERE category = 'decision_category'
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
  c.value,
  c.label,
  c.description,
  c.sort_order,
  FALSE,
  'active',
  jsonb_build_object('source', 'import_job_cancel_decision_lookup_v1')
FROM definition d
CROSS JOIN categories c
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

WITH outcomes(value, label, description, sort_order) AS (
  VALUES
    ('queued', 'Queued', 'Decision outcome emitted by import_job_create_v1.', 1890),
    ('cancelled', 'Cancelled', 'Decision outcome emitted by import_job_cancel_v1.', 1900)
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
  o.description,
  o.sort_order,
  FALSE,
  'active',
  jsonb_build_object('source', 'import_job_cancel_decision_lookup_v1')
FROM definition d
CROSS JOIN outcomes o
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

SELECT pg_advisory_unlock(hashtext('202605031650_import_job_cancel_decision_lookup_v1'));
COMMIT;
