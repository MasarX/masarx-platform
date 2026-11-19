-- Console V2 inbox force-status needs row-driven terminal failure taxonomy.

BEGIN;

SET search_path TO public, extensions, pg_temp;

UPDATE public.lookup_values lv
   SET metadata = jsonb_strip_nulls(
     COALESCE(lv.metadata, '{}'::jsonb)
     || jsonb_build_object('is_terminal_failure', true)
   ),
       updated_at = now()
  FROM public.lookup_definitions ld
 WHERE ld.id = lv.lookup_definition_id
   AND ld.category = 'processing_status'
   AND lv.value = 'failed';

COMMIT;
