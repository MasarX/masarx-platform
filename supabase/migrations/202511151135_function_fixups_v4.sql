-- Migration: Function search_path adjustments (v4)
-- Date: 2025-11-15

BEGIN;

ALTER FUNCTION public.create_next_partitions()
    SET search_path = public, extensions;

ALTER FUNCTION public.archive_old_partitions()
    SET search_path = public, extensions;

ALTER FUNCTION public.expand_hash_partitions(text, integer)
    SET search_path = public, extensions;

ALTER FUNCTION public.apply_workflow_transition(uuid, uuid, jsonb, jsonb)
    SET search_path = public, extensions;

ALTER FUNCTION public.orchestrate_api_response_processing(uuid)
    SET search_path = public, extensions;

ALTER FUNCTION public.request_label_generation(uuid, text, uuid, text, uuid, text)
    SET search_path = public, extensions;

COMMIT;
