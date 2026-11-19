-- Console V2 first-tenant readiness: client lifecycle actions must resolve
-- their target status from lookup metadata, not frontend literals.

SELECT pg_advisory_lock(hashtext('202605110005_console_v2_client_status_lifecycle_metadata_v1'));

WITH lifecycle_rows(value, lifecycle, tone) AS (
  VALUES
    ('active', 'active', 'good'),
    ('suspended', 'suspended', 'warn'),
    ('terminated', 'terminal', 'danger')
)
UPDATE public.lookup_values lv
SET metadata = COALESCE(lv.metadata, '{}'::jsonb)
  || jsonb_build_object('lifecycle', lr.lifecycle, 'tone', lr.tone),
    updated_at = now()
FROM public.lookup_definitions ld
JOIN lifecycle_rows lr ON true
WHERE ld.id = lv.lookup_definition_id
  AND ld.category = 'client_status'
  AND lv.value = lr.value;

COMMENT ON TABLE public.lookup_values
  IS 'Lookup values. Console V2 client_status rows must carry metadata.lifecycle so client suspend/reactivate actions stay row-driven.';

SELECT pg_advisory_unlock(hashtext('202605110005_console_v2_client_status_lifecycle_metadata_v1'));
