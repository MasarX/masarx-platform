-- Migration: Dispatch task-contact policy examples no hardcoded contacts v1
-- Purpose:
--   - Keep task-contact support examples row-driven by avoiding seeded phone
--     numbers in communication_policy schema examples.

BEGIN;
SELECT pg_advisory_lock(hashtext('202606291735_dispatch_task_contact_policy_examples_no_hardcoded_contacts_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

UPDATE public.schema_registry
   SET examples = jsonb_build_array(
         jsonb_build_object(
           'version', 1,
           'allowed_channels', jsonb_build_array('call', 'sms', 'whatsapp'),
           'support_contacts', jsonb_build_array(),
           'templates', jsonb_build_array()
         )
       ),
       updated_at = now()
 WHERE category = 'communication_policy'
   AND version = 1
   AND (
     examples::text LIKE '%+12025550123%'
     OR examples #> '{0,support_contacts}' IS DISTINCT FROM '[]'::jsonb
   );

SELECT pg_advisory_unlock(hashtext('202606291735_dispatch_task_contact_policy_examples_no_hardcoded_contacts_v1'));
COMMIT;
