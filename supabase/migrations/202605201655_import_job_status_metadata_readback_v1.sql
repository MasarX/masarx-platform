-- Console V2 import job lifecycle metadata contract.
--
-- The Import Jobs UI resolves cancellable/queued/running/completed/failed
-- behavior from lookup metadata instead of inline status literals. Keep the
-- lookup rows as the backend-owned lifecycle policy.

WITH status_metadata(value, metadata_patch) AS (
  VALUES
    ('queued',    '{"is_queued":true,"is_running":false,"is_completed":false,"is_failed":false,"is_active":true,"is_terminal":false,"is_cancellable":true}'::jsonb),
    ('running',   '{"is_queued":false,"is_running":true,"is_completed":false,"is_failed":false,"is_active":true,"is_terminal":false,"is_cancellable":true}'::jsonb),
    ('completed', '{"is_queued":false,"is_running":false,"is_completed":true,"is_failed":false,"is_active":false,"is_terminal":true,"is_cancellable":false}'::jsonb),
    ('failed',    '{"is_queued":false,"is_running":false,"is_completed":false,"is_failed":true,"is_active":false,"is_terminal":true,"is_cancellable":false}'::jsonb),
    ('cancelled', '{"is_queued":false,"is_running":false,"is_completed":false,"is_failed":false,"is_active":false,"is_terminal":true,"is_cancellable":false}'::jsonb)
)
UPDATE public.lookup_values AS lv
   SET metadata = COALESCE(lv.metadata, '{}'::jsonb) || status_metadata.metadata_patch,
       updated_at = now()
  FROM public.lookup_definitions AS ld,
       status_metadata
 WHERE ld.id = lv.lookup_definition_id
   AND ld.category = 'import_job_status'
   AND lv.value = status_metadata.value;
