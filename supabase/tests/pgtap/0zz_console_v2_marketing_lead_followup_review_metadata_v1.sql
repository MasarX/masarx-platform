-- Console V2 Review Queue must resolve marketing lead follow-up task metadata
-- from canonical task_type lookup and task_type_catalog rows.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(4);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'task_type'
       AND lv.value = 'marketing_lead_followup'
       AND lv.status = 'active'
  ),
  'task_type lookup includes active marketing_lead_followup'
);

SELECT is(
  (
    SELECT lv.metadata->>'tone'
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'task_type'
       AND lv.value = 'marketing_lead_followup'
  ),
  'info',
  'marketing_lead_followup lookup resolves Console tone'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value->'task_types', '[]'::jsonb)) AS t(value)
     WHERE s.category = 'task_type_catalog'
       AND s.scope_type = 'global'
       AND lower(NULLIF(btrim(COALESCE(t.value->>'key', '')), '')) = 'marketing_lead_followup'
       AND NULLIF(btrim(COALESCE(t.value->>'reviewer_description', '')), '') IS NOT NULL
  ),
  'task_type_catalog carries reviewer_description for marketing_lead_followup'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value->'task_types', '[]'::jsonb)) AS t(value)
     WHERE s.category = 'task_type_catalog'
       AND s.scope_type = 'global'
       AND lower(NULLIF(btrim(COALESCE(t.value->>'key', '')), '')) = 'marketing_lead_followup'
       AND COALESCE((t.value->>'enabled')::boolean, FALSE) IS TRUE
       AND NULLIF(btrim(COALESCE(t.value->>'default_queue_key', '')), '') IS NOT NULL
  ),
  'task_type_catalog keeps marketing_lead_followup enabled with queue default'
);

SELECT * FROM finish();

ROLLBACK;
