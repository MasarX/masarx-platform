-- Keep the receiving workflow terminal status and lifecycle lookup vocabulary.
BEGIN;
SET LOCAL lock_timeout = '30s';

DO $status$
DECLARE
  v_definition TEXT := pg_get_functiondef('public.workflow_run_triggers_before_write_v1()'::regprocedure);
  v_alias TEXT := $old$IF v_status = 'completed' THEN
      v_status := 'succeeded';$old$;
BEGIN
  IF position(v_alias IN v_definition) = 0 THEN
    RAISE EXCEPTION 'Workflow trigger terminal status normalization has changed';
  END IF;
  EXECUTE replace(
    replace(v_definition, v_alias, $new$IF v_status = 'succeeded' THEN
      v_status := 'completed';$new$),
    'ARRAY[''succeeded'']', 'ARRAY[''completed'']'
  );
END;
$status$;

ALTER TABLE public.workflow_run_triggers ALTER COLUMN source_statuses SET DEFAULT ARRAY['completed']::TEXT[];
UPDATE public.workflow_run_triggers
   SET source_statuses = array_replace(source_statuses, 'succeeded', 'completed')
 WHERE 'succeeded' = ANY(source_statuses);

UPDATE public.lookup_values v
   SET status = 'archived',
       archived_at = COALESCE(v.archived_at, now()),
       updated_at = now()
  FROM public.lookup_definitions d
 WHERE d.id = v.lookup_definition_id
   AND d.category = 'workflow_status'
   AND v.value IN ('inactive', 'retired')
   AND v.status = 'active';

UPDATE public.lookup_values v
   SET metadata = COALESCE(v.metadata, '{}'::jsonb)
       || '{"toggle_to":"archived","toggle_label":"Archive"}'::jsonb,
       updated_at = now()
  FROM public.lookup_definitions d
 WHERE d.id = v.lookup_definition_id
   AND d.category = 'workflow_status'
   AND v.value = 'active'
   AND v.metadata->>'toggle_to' = 'inactive';

UPDATE public.lookup_values v
   SET metadata = COALESCE(v.metadata, '{}'::jsonb) ||
       CASE WHEN v.value = 'compliance_document_mismatch' THEN '{"decision":"reject","tone":"danger"}'::jsonb
            ELSE '{"tone":"neutral"}'::jsonb END,
       updated_at = now()
  FROM public.lookup_definitions d
 WHERE d.id = v.lookup_definition_id
   AND d.category = 'marketplace_participant_review_reason'
   AND v.status = 'active'
   AND ((v.value = 'compliance_document_mismatch' AND v.metadata->>'edge_case' = 'compliance_denied')
        OR v.value = 'other')
   AND (v.metadata->>'tone' IS NULL
        OR (v.value = 'compliance_document_mismatch' AND v.metadata->>'decision' IS NULL));

COMMIT;
