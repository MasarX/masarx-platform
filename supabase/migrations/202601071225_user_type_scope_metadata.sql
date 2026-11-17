-- Migration: Seed user_type default scope metadata
BEGIN;
SELECT pg_advisory_lock(hashtext('202601071225_user_type_scope_metadata'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

WITH target AS (
  SELECT lv.id,
         lv.metadata,
         lv.value
  FROM public.lookup_definitions ld
  JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
  WHERE ld.category = 'user_type'
)
UPDATE public.lookup_values lv
SET metadata = jsonb_set(COALESCE(target.metadata, '{}'::jsonb), '{default_scope_type}', to_jsonb(
    CASE target.value
      WHEN 'super_admin' THEN 'platform'
      WHEN 'ops_admin' THEN 'tenant'
      WHEN 'account_manager' THEN 'tenant'
      WHEN 'client_admin' THEN 'client'
      WHEN 'sender_user' THEN 'sender'
      ELSE 'tenant'
    END
  )::jsonb, true),
    updated_at = now()
FROM target
WHERE lv.id = target.id;

SELECT pg_advisory_unlock(hashtext('202601071225_user_type_scope_metadata'));
COMMIT;
