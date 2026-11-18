-- pgTAP: Console V2 import-job lifecycle lookup metadata contract.
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(12);

SELECT is(
  (lv.metadata->>'is_active')::boolean,
  true,
  'import_job_status queued is active for no-reload cancel action visibility'
)
FROM public.lookup_values lv
JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
WHERE ld.category = 'import_job_status'
  AND lv.value = 'queued';

SELECT is(
  (lv.metadata->>'is_cancellable')::boolean,
  true,
  'import_job_status queued is cancellable'
)
FROM public.lookup_values lv
JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
WHERE ld.category = 'import_job_status'
  AND lv.value = 'queued';

SELECT is(
  (lv.metadata->>'is_queued')::boolean,
  true,
  'import_job_status queued is_queued flag is present'
)
FROM public.lookup_values lv
JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
WHERE ld.category = 'import_job_status'
  AND lv.value = 'queued';

SELECT is(
  (lv.metadata->>'is_active')::boolean,
  true,
  'import_job_status running is active for no-reload cancel action visibility'
)
FROM public.lookup_values lv
JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
WHERE ld.category = 'import_job_status'
  AND lv.value = 'running';

SELECT is(
  (lv.metadata->>'is_cancellable')::boolean,
  true,
  'import_job_status running is cancellable'
)
FROM public.lookup_values lv
JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
WHERE ld.category = 'import_job_status'
  AND lv.value = 'running';

SELECT is(
  (lv.metadata->>'is_running')::boolean,
  true,
  'import_job_status running is_running flag is present'
)
FROM public.lookup_values lv
JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
WHERE ld.category = 'import_job_status'
  AND lv.value = 'running';

SELECT is(
  (lv.metadata->>'is_completed')::boolean,
  true,
  'import_job_status completed is_completed flag is present'
)
FROM public.lookup_values lv
JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
WHERE ld.category = 'import_job_status'
  AND lv.value = 'completed';

SELECT is(
  (lv.metadata->>'is_active')::boolean,
  false,
  'import_job_status completed is not active'
)
FROM public.lookup_values lv
JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
WHERE ld.category = 'import_job_status'
  AND lv.value = 'completed';

SELECT is(
  (lv.metadata->>'is_failed')::boolean,
  true,
  'import_job_status failed is_failed flag is present'
)
FROM public.lookup_values lv
JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
WHERE ld.category = 'import_job_status'
  AND lv.value = 'failed';

SELECT is(
  (lv.metadata->>'is_active')::boolean,
  false,
  'import_job_status failed is not active'
)
FROM public.lookup_values lv
JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
WHERE ld.category = 'import_job_status'
  AND lv.value = 'failed';

SELECT is(
  (lv.metadata->>'is_terminal')::boolean,
  true,
  'import_job_status cancelled is terminal'
)
FROM public.lookup_values lv
JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
WHERE ld.category = 'import_job_status'
  AND lv.value = 'cancelled';

SELECT is(
  (lv.metadata->>'is_cancellable')::boolean,
  false,
  'import_job_status cancelled is not cancellable'
)
FROM public.lookup_values lv
JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
WHERE ld.category = 'import_job_status'
  AND lv.value = 'cancelled';

SELECT * FROM finish();
ROLLBACK;
