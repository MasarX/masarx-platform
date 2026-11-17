-- Migration: Fixup request_entry_point lookup values (platform workflow wrappers)

BEGIN;

SET search_path TO public, extensions, pg_temp;

INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, status)
SELECT d.id, 'label_job_wrapper', 'Label Job Wrapper', 45, false, 'active'
FROM public.lookup_definitions d
WHERE d.category = 'request_entry_point'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, is_default, status)
SELECT d.id, 'enqueue_outbound_call', 'Enqueue Outbound Call', 46, false, 'active'
FROM public.lookup_definitions d
WHERE d.category = 'request_entry_point'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

COMMIT;
