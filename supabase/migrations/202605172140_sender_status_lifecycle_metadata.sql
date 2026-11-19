BEGIN;
SELECT pg_advisory_lock(hashtext('202605172140_sender_status_lifecycle_metadata'));
SET search_path TO public, extensions, pg_temp;

WITH def AS (
  SELECT id
  FROM public.lookup_definitions
  WHERE category = 'sender_status'
)
INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  sort_order,
  is_default,
  status,
  metadata
)
SELECT
  def.id,
  'suspended',
  'Suspended',
  30,
  false,
  'active',
  jsonb_build_object('lifecycle', 'suspended')
FROM def
WHERE NOT EXISTS (
  SELECT 1
  FROM public.lookup_values lv
  WHERE lv.lookup_definition_id = def.id
    AND lv.value = 'suspended'
);

WITH lifecycle(value, lifecycle) AS (
  VALUES
    ('active', 'active'),
    ('inactive', 'inactive'),
    ('suspended', 'suspended')
)
UPDATE public.lookup_values lv
SET metadata = COALESCE(lv.metadata, '{}'::jsonb)
  || jsonb_build_object('lifecycle', lifecycle.lifecycle)
FROM public.lookup_definitions ld, lifecycle
WHERE lv.lookup_definition_id = ld.id
  AND ld.category = 'sender_status'
  AND lifecycle.value = lv.value;

SELECT pg_advisory_unlock(hashtext('202605172140_sender_status_lifecycle_metadata'));
COMMIT;
