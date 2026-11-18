BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(2);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sv.value->'roles', '[]'::jsonb)) AS role(value)
    WHERE s.category = 'access_control_policy'
      AND sv.approved_at IS NOT NULL
      AND sv.effective_until IS NULL
      AND role.value->>'key' = 'ops_admin'
      AND (
        NOT (COALESCE(role.value->'capability_keys', '[]'::jsonb) @> '"network.read"'::jsonb)
        OR NOT (COALESCE(role.value->'capability_keys', '[]'::jsonb) @> '"marketplace.read"'::jsonb)
      )
  ),
  'all active scoped access_control_policy rows with ops_admin include partner marketplace grants'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    CROSS JOIN (VALUES
      ('network.read'),
      ('marketplace.read')
    ) AS required(capability_key)
    WHERE s.category = 'access_control_policy'
      AND sv.approved_at IS NOT NULL
      AND sv.effective_until IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(COALESCE(sv.value->'capabilities', '[]'::jsonb)) AS cap(value)
        WHERE cap.value->>'key' = required.capability_key
      )
  ),
  'all active access_control_policy rows include partner marketplace capability definitions'
);

SELECT * FROM finish();

ROLLBACK;
