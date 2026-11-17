-- Migration: Access control policy read scope fix
-- Purpose: Ensure client_admin and sender_user can read their own client/sender records.
BEGIN;

SET search_path TO public, pg_temp;
SET LOCAL lock_timeout = '30s';
SELECT pg_advisory_lock(hashtext('202601022300_access_control_policy_read_scope'));

WITH current AS (
  SELECT s.settings_version_id,
         sv.version,
         sv.value,
         sv.schema_version
  FROM public.settings s
  JOIN public.settings_versions sv ON sv.id = s.settings_version_id
  WHERE s.category = 'access_control_policy'
    AND s.scope_type = 'global'
    AND s.scope_id IS NULL
  LIMIT 1
),
roles AS (
  SELECT jsonb_agg(
    CASE
      WHEN role->>'key' = 'client_admin' THEN
        jsonb_set(
          role,
          '{capability_keys}',
          to_jsonb(ARRAY(
            SELECT DISTINCT cap
            FROM (
              SELECT jsonb_array_elements_text(COALESCE(role->'capability_keys', '[]'::jsonb)) AS cap
              UNION ALL
              SELECT unnest(ARRAY['clients.read','senders.read']) AS cap
            ) AS caps
            ORDER BY cap
          )),
          false
        )
      WHEN role->>'key' = 'sender_user' THEN
        jsonb_set(
          role,
          '{capability_keys}',
          to_jsonb(ARRAY(
            SELECT DISTINCT cap
            FROM (
              SELECT jsonb_array_elements_text(COALESCE(role->'capability_keys', '[]'::jsonb)) AS cap
              UNION ALL
              SELECT unnest(ARRAY['senders.read']) AS cap
            ) AS caps
            ORDER BY cap
          )),
          false
        )
      ELSE role
    END
  ) AS roles
  FROM current, jsonb_array_elements(current.value->'roles') role
),
updated AS (
  SELECT current.*, jsonb_set(current.value, '{roles}', roles.roles, false) AS next_value
  FROM current, roles
),
applied AS (
  UPDATE public.settings_versions sv
  SET value = updated.next_value,
      version = updated.version + 1,
      change_reason = 'Grant client_admin clients.read/senders.read and sender_user senders.read',
      approved_at = now(),
      effective_from = now()
  FROM updated
  WHERE sv.id = updated.settings_version_id
    AND updated.next_value IS DISTINCT FROM updated.value
  RETURNING sv.id, sv.value
)
UPDATE public.settings s
SET cached_value = applied.value,
    last_updated = now()
FROM applied
WHERE s.category = 'access_control_policy'
  AND s.scope_type = 'global'
  AND s.scope_id IS NULL
  AND s.settings_version_id = applied.id;

SELECT pg_advisory_unlock(hashtext('202601022300_access_control_policy_read_scope'));
COMMIT;
