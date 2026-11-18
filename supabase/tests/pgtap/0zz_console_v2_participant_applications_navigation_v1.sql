-- pgTAP: Console V2 participant applications navigation discoverability.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(6);

WITH console_items AS (
  SELECT section->>'id' AS section_id,
         item->>'id' AS item_id,
         COALESCE(item->>'route', item->>'href') AS path,
         item->>'resource' AS resource_key,
         item->>'capability' AS capability
    FROM jsonb_array_elements(public.resolve_settings_merged('ui_navigation', 'global', NULL)#>'{apps,console,sections}') AS section
   CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section->'items', '[]'::jsonb)) AS item
)
SELECT ok(
  EXISTS (
    SELECT 1
      FROM console_items
     WHERE section_id = 'network'
       AND item_id = 'network-participant-applications'
       AND path = '/network/participant-applications'
       AND resource_key = 'marketplace_participant_requests'
       AND capability = 'marketplace_participant_requests.read'
  ),
  'global Console V2 navigation exposes Network Participant applications'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_navigation'
       AND NOT EXISTS (
         SELECT 1
           FROM jsonb_array_elements(COALESCE(sv.value#>'{apps,console,sections}', '[]'::jsonb)) AS section
          CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section->'items', '[]'::jsonb)) AS item
          WHERE section->>'id' = 'network'
            AND item->>'id' = 'network-participant-applications'
            AND COALESCE(item->>'route', item->>'href') = '/network/participant-applications'
            AND item->>'resource' = 'marketplace_participant_requests'
            AND item->>'capability' = 'marketplace_participant_requests.read'
       )
  ),
  'all Console V2 navigation scopes expose Participant applications'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sv.value#>'{apps,console,sections}', '[]'::jsonb)) AS section
     CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section->'items', '[]'::jsonb)) AS item
     WHERE s.category = 'ui_navigation'
       AND (
         COALESCE(item->>'id', item->>'key') IN (
           'network-participant-applications',
           'participant-applications'
         )
         OR COALESCE(item->>'resource', '') = 'marketplace_participant_requests'
       )
       AND COALESCE(item->>'route', item->>'href') LIKE '/console/resources/%'
  ),
  'Participant applications navigation avoids legacy raw resource routes in every scope'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings_category_registry
     WHERE category = 'marketplace_participant_application_filter'
       AND requires_global_default IS TRUE
  ),
  'participant application filter settings category is registered'
);

SELECT is(
  public.resolve_settings_merged('marketplace_participant_application_filter', 'global', NULL::uuid)
    ->'excluded_type_keys',
  '["freelancer_driver"]'::jsonb,
  'participant application filter excludes driver applications from Network queue'
);

SELECT is(
  (
    SELECT value->'excluded_type_keys'
      FROM api.resolve_settings_row_from_policy_context_v1(
        'marketplace_participant_application_filter',
        '{}'::jsonb
      )
     LIMIT 1
  ),
  '["freelancer_driver"]'::jsonb,
  'Console browser API resolver returns participant application filter'
);

SELECT * FROM finish();

ROLLBACK;
