-- Provider auth status lifecycle metadata for Console V2 credential actions.
--
-- Credential terminal behavior is row-driven from provider_auth_status metadata.
-- Keep lifecycle/is_revoked/is_terminal flags available in live backends so
-- revoked credentials cannot expose rotate/revoke actions or active timelines.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605111240_provider_auth_status_lifecycle_metadata_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, metadata)
SELECT
  ld.id,
  v.value,
  v.label,
  v.sort_order,
  v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('active',   'Active',   10, '{"tone":"good","lifecycle":"active","is_active":true,"is_revoked":false,"is_terminal":false}'),
  ('pending',  'Pending',  20, '{"tone":"info","lifecycle":"pending","is_active":false,"is_revoked":false,"is_terminal":false}'),
  ('rotating', 'Rotating', 30, '{"tone":"warn","lifecycle":"rotating","is_active":false,"is_revoked":false,"is_terminal":false}'),
  ('revoked',  'Revoked',  40, '{"tone":"danger","lifecycle":"revoked","is_active":false,"is_revoked":true,"is_terminal":true}'),
  ('expired',  'Expired',  50, '{"tone":"danger","lifecycle":"expired","is_active":false,"is_revoked":false,"is_terminal":true}')
) AS v(value, label, sort_order, metadata)
WHERE ld.category = 'provider_auth_status'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    sort_order = EXCLUDED.sort_order,
    metadata = COALESCE(public.lookup_values.metadata, '{}'::jsonb) || EXCLUDED.metadata,
    updated_at = now();

SELECT pg_advisory_unlock(hashtext('202605111240_provider_auth_status_lifecycle_metadata_v1'));

COMMIT;
