-- Migration: Make label render status filters map to canonical backend statuses.
-- Purpose:
--   Console V2 shows operator-friendly label render chips (Queued, Rendering,
--   Completed, Failed), while public.label_jobs.status stores the canonical
--   backend values pending/in_progress/succeeded/failed. Store the mapping in
--   lookup metadata so the Platform > Labels print queue filters are row-driven.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605160205_console_v2_label_render_status_lookup_aliases_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, metadata, status)
SELECT ld.id, v.value, v.label, v.sort_order, v.metadata::jsonb, 'active'
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('queued',    'Queued',    10, '{"tone":"info","backend_values":["pending"]}'),
  ('rendering', 'Rendering', 20, '{"tone":"warn","backend_values":["in_progress"]}'),
  ('completed', 'Completed', 30, '{"tone":"good","backend_values":["succeeded"]}'),
  ('failed',    'Failed',    40, '{"tone":"danger","backend_values":["failed"]}')
) AS v(value, label, sort_order, metadata)
WHERE ld.category = 'label_render_job_status'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata,
    status = 'active',
    updated_at = now();

SELECT pg_advisory_unlock(hashtext('202605160205_console_v2_label_render_status_lookup_aliases_v1'));
COMMIT;
