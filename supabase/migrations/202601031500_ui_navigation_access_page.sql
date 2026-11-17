-- Migration: UI navigation access page
BEGIN;
SELECT pg_advisory_lock(hashtext('202601031500_ui_navigation_access_page'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

WITH current AS (
  SELECT s.settings_version_id,
         sv.version,
         sv.value,
         sv.schema_version
  FROM public.settings s
  JOIN public.settings_versions sv ON sv.id = s.settings_version_id
  WHERE s.category = 'ui_navigation'
    AND s.scope_type = 'global'
    AND s.scope_id IS NULL
  LIMIT 1
),
console_section AS (
  SELECT jsonb_build_object(
    'id', 'access',
    'label', 'Access',
    'items', jsonb_build_array(
      jsonb_build_object(
        'id', 'console-access',
        'label', 'My access',
        'href', '/console/access'
      )
    )
  ) AS section
),
portal_section AS (
  SELECT jsonb_build_object(
    'id', 'access',
    'label', 'Access',
    'items', jsonb_build_array(
      jsonb_build_object(
        'id', 'portal-access',
        'label', 'My access',
        'href', '/portal/access'
      )
    )
  ) AS section
),
with_console AS (
  SELECT current.*,
    CASE
      WHEN EXISTS (
        SELECT 1
        FROM jsonb_array_elements(COALESCE(current.value#>'{apps,console,sections}', '[]'::jsonb)) AS section
        WHERE section->>'id' = 'access'
      )
      THEN current.value
      ELSE jsonb_set(
        current.value,
        '{apps,console,sections}',
        COALESCE(current.value#>'{apps,console,sections}', '[]'::jsonb) || jsonb_build_array(console_section.section),
        true
      )
    END AS value_with_console
  FROM current, console_section
),
with_portal AS (
  SELECT with_console.*,
    CASE
      WHEN EXISTS (
        SELECT 1
        FROM jsonb_array_elements(COALESCE(with_console.value_with_console#>'{apps,portal,sections}', '[]'::jsonb)) AS section
        WHERE section->>'id' = 'access'
      )
      THEN with_console.value_with_console
      ELSE jsonb_set(
        with_console.value_with_console,
        '{apps,portal,sections}',
        COALESCE(with_console.value_with_console#>'{apps,portal,sections}', '[]'::jsonb)
          || jsonb_build_array(portal_section.section),
        true
      )
    END AS next_value
  FROM with_console, portal_section
),
applied AS (
  UPDATE public.settings_versions sv
  SET value = with_portal.next_value,
      version = with_portal.version + 1,
      change_reason = 'Add access overview to ui_navigation',
      approved_at = now(),
      effective_from = now()
  FROM with_portal
  WHERE sv.id = with_portal.settings_version_id
    AND with_portal.next_value IS DISTINCT FROM with_portal.value
  RETURNING sv.id, sv.value
)
UPDATE public.settings s
SET cached_value = applied.value,
    last_updated = now()
FROM applied
WHERE s.category = 'ui_navigation'
  AND s.scope_type = 'global'
  AND s.scope_id IS NULL
  AND s.settings_version_id = applied.id;

SELECT pg_advisory_unlock(hashtext('202601031500_ui_navigation_access_page'));
COMMIT;
