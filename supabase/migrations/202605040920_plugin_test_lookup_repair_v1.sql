-- Console V2's integration plugin tester persists a canonical validation run
-- and audit decision. Keep lookup-enforced catalogs aligned with that runtime
-- path instead of special-casing the write.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605031810_plugin_test_lookup_repair_v1'));
SET search_path TO public, extensions, pg_temp;

WITH validation_types(value, label, sort_order) AS (
  VALUES
    ('test', 'Test', 50)
),
definition AS (
  SELECT id
    FROM public.lookup_definitions
   WHERE category = 'integration_plugin_validation_type'
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
  t.value,
  t.label,
  'Operator-triggered integration plugin test run.',
  t.sort_order,
  FALSE,
  'active',
  jsonb_build_object(
    'source', 'plugin_test_lookup_repair_v1',
    'tone', 'info'
  )
FROM definition d
CROSS JOIN validation_types t
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    description = EXCLUDED.description,
    sort_order = EXCLUDED.sort_order,
    status = 'active',
    metadata = COALESCE(public.lookup_values.metadata, '{}'::jsonb) || EXCLUDED.metadata,
    updated_at = now();

WITH categories(value, label, sort_order) AS (
  VALUES
    ('integration_plugin.test', 'Integration Plugin Test', 2360)
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
  'Decision category emitted by canonical integration plugin test RPC.',
  c.sort_order,
  FALSE,
  'active',
  jsonb_build_object(
    'source', 'plugin_test_lookup_repair_v1',
    'tone', 'info'
  )
FROM definition d
CROSS JOIN categories c
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    description = EXCLUDED.description,
    sort_order = EXCLUDED.sort_order,
    status = 'active',
    metadata = COALESCE(public.lookup_values.metadata, '{}'::jsonb) || EXCLUDED.metadata,
    updated_at = now();

WITH outcomes(value, label, sort_order, tone) AS (
  VALUES
    ('test_succeeded', 'Test Succeeded', 2120, 'good')
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
  'Decision outcome emitted by canonical integration plugin test RPC.',
  o.sort_order,
  FALSE,
  'active',
  jsonb_build_object(
    'source', 'plugin_test_lookup_repair_v1',
    'tone', o.tone
  )
FROM definition d
CROSS JOIN outcomes o
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    description = EXCLUDED.description,
    sort_order = EXCLUDED.sort_order,
    status = 'active',
    metadata = COALESCE(public.lookup_values.metadata, '{}'::jsonb) || EXCLUDED.metadata,
    updated_at = now();

SELECT pg_advisory_unlock(hashtext('202605031810_plugin_test_lookup_repair_v1'));
COMMIT;
