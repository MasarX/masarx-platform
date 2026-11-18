-- Migration: Console V2 service catalog status lifecycle metadata
-- Purpose:
--   Backend lookup values loaded by Console V2 must carry the same lifecycle
--   metadata used by the frontend seed. Without it, live cards can show
--   "active" while lifecycle-derived KPIs and bulk actions treat every offering
--   as non-active.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605042115_console_v2_service_catalog_status_lifecycle_v1'));

UPDATE public.lookup_values
   SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{lifecycle}', to_jsonb('active'::text), TRUE),
       updated_at = now()
  FROM public.lookup_definitions d
 WHERE d.id = lookup_values.lookup_definition_id
   AND d.category = 'service_offering_status'
   AND value = 'active';

UPDATE public.lookup_values
   SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{lifecycle}', to_jsonb('draft'::text), TRUE),
       updated_at = now()
  FROM public.lookup_definitions d
 WHERE d.id = lookup_values.lookup_definition_id
   AND d.category = 'service_offering_status'
   AND value = 'draft';

UPDATE public.lookup_values
   SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{lifecycle}', to_jsonb('terminal'::text), TRUE),
       updated_at = now()
  FROM public.lookup_definitions d
 WHERE d.id = lookup_values.lookup_definition_id
   AND d.category = 'service_offering_status'
   AND value = 'archived';

SELECT pg_advisory_unlock(hashtext('202605042115_console_v2_service_catalog_status_lifecycle_v1'));

COMMIT;
