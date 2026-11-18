-- pgTAP: Console V2 API/webhook shipment intake is discoverable by clicked
-- navigation and its intake status chips resolve through API-visible lookups.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(21);

SELECT has_function(
  'api',
  'list_lookup_values_v1',
  ARRAY['text'],
  'api.list_lookup_values_v1(text) exists for browser lookup hydration'
);

WITH nav_items AS (
  SELECT item.item
    FROM jsonb_array_elements(
           COALESCE(
             public.resolve_settings_merged('ui_navigation', 'global', NULL)#>'{apps,console,sections}',
             '[]'::jsonb
           )
         ) AS section(section)
   CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section.section->'items', '[]'::jsonb)) AS item(item)
)
SELECT ok(
  EXISTS (
    SELECT 1
      FROM nav_items
     WHERE COALESCE(item->>'route', item->>'href') = '/integrations/webhook-tester'
       AND item->>'label' = 'Webhook tester'
       AND item->>'capability' = 'webhooks.read'
  ),
  'Webhook tester navigation is present for API/provider shipment intake review'
);

WITH nav_items AS (
  SELECT item.item
    FROM jsonb_array_elements(
           COALESCE(
             public.resolve_settings_merged('ui_navigation', 'global', NULL)#>'{apps,console,sections}',
             '[]'::jsonb
           )
         ) AS section(section)
   CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section.section->'items', '[]'::jsonb)) AS item(item)
)
SELECT ok(
  EXISTS (
    SELECT 1
      FROM nav_items
     WHERE COALESCE(item->>'route', item->>'href') = '/integrations/intake'
       AND item->>'label' = 'Inbound intake monitor'
       AND item->>'capability' = 'webhooks.read'
  ),
  'Inbound intake monitor navigation is present for webhook shipment intake review'
);

WITH nav_items AS (
  SELECT section.section,
         item.item
    FROM jsonb_array_elements(
           COALESCE(
             public.resolve_settings_merged('ui_navigation', 'global', NULL)#>'{apps,console,sections}',
             '[]'::jsonb
           )
         ) AS section(section)
   CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section.section->'items', '[]'::jsonb)) AS item(item)
)
SELECT ok(
  EXISTS (
    SELECT 1
      FROM nav_items
     WHERE section->>'id' = 'integrations'
       AND COALESCE(item->>'route', item->>'href') = '/insights/api-gateway'
       AND item->>'label' = 'API request intake'
       AND item->>'capability' = 'api_gateway.read'
       AND item->'capabilities' ? 'api_gateway.read'
  ),
  'API request intake navigation is present under External Intake with api_gateway.read'
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
          WHERE COALESCE(item->>'route', item->>'href') = '/integrations/webhook-tester'
            AND item->>'capability' = 'webhooks.read'
       )
  ),
  'all Console V2 navigation scopes expose Webhook tester'
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
          WHERE COALESCE(item->>'route', item->>'href') = '/integrations/intake'
            AND item->>'capability' = 'webhooks.read'
       )
  ),
  'all Console V2 navigation scopes expose Inbound intake monitor'
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
          WHERE section->>'id' = 'integrations'
            AND COALESCE(item->>'route', item->>'href') = '/insights/api-gateway'
            AND item->>'capability' = 'api_gateway.read'
            AND item->'capabilities' ? 'api_gateway.read'
       )
  ),
  'all Console V2 navigation scopes expose API request intake through External Intake'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_navigation', 'global', NULL)#>'{apps,console,sections}') AS section
     CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section->'items', '[]'::jsonb)) AS item
     WHERE COALESCE(item->>'route', item->>'href') IN ('/integrations/webhook-tester', '/integrations/intake')
       AND COALESCE(item->>'route', item->>'href') LIKE '/console/%'
  ),
  'API/webhook intake navigation avoids legacy raw console routes'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sv.value#>'{apps,console,sections}', '[]'::jsonb)) AS section
     CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section->'items', '[]'::jsonb)) AS item
     WHERE s.category = 'ui_navigation'
       AND COALESCE(item->>'route', item->>'href') IN (
         '/console/resources/api_call_log',
         '/console/resources/api_route_packs',
         '/console/resources/api_routes'
       )
  ),
  'all Console V2 navigation scopes remove legacy raw API gateway resource links'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(COALESCE(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources', '[]'::jsonb)) AS resource
     WHERE resource->>'key' = 'webhook_inbox_directory'
       AND resource->>'relation' = 'public.v_webhook_inbox_directory'
       AND resource->>'capability_read' = 'webhooks.read'
  ),
  'global read registry exposes webhook_inbox_directory for Inbound intake'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
       AND NOT EXISTS (
         SELECT 1
           FROM jsonb_array_elements(COALESCE(sv.value->'resources', '[]'::jsonb)) AS resource
          WHERE resource->>'key' = 'webhook_inbox_directory'
            AND resource->>'relation' = 'public.v_webhook_inbox_directory'
            AND resource->>'capability_read' = 'webhooks.read'
       )
  ),
  'all read registry scopes expose webhook_inbox_directory'
);

INSERT INTO public.organizations (id, name, slug)
VALUES (
  '83f5c5d9-bd0d-465e-8405-3ba62ef26151'::uuid,
  'Console V2 API Intake Lookup Org',
  'console-v2-api-intake-lookup-org'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.users (
  id,
  organization_id,
  email,
  full_name,
  user_type,
  access_scope_type,
  access_scope_id,
  status
)
VALUES (
  'c0d417c5-4052-4afc-b376-e7153d6ece04'::uuid,
  '83f5c5d9-bd0d-465e-8405-3ba62ef26151'::uuid,
  'console-v2-api-intake-lookups@example.test',
  'Console V2 API Intake Lookup Admin',
  'super_admin',
  'platform',
  NULL,
  'active'
)
ON CONFLICT (id) DO NOTHING;

SELECT set_config('request.jwt.claim.sub', 'c0d417c5-4052-4afc-b376-e7153d6ece04', true);
SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', 'c0d417c5-4052-4afc-b376-e7153d6ece04',
    'role', 'authenticated',
    'email', 'console-v2-api-intake-lookups@example.test'
  )::text,
  true
);
SET LOCAL ROLE authenticated;

SELECT lives_ok(
  $$ SELECT api.ui_list_resource_v1('webhook_inbox_directory', '{"organization_id":"83f5c5d9-bd0d-465e-8405-3ba62ef26151"}'::jsonb, 5, 0, NULL::jsonb) $$,
  'api.ui_list_resource_v1 can list webhook_inbox_directory for Console V2 Inbound intake'
);

SELECT is(
  (SELECT row.label FROM api.list_lookup_values_v1('turnstile_status') AS row WHERE row.value = 'verified'),
  'Verified',
  'turnstile_status.verified resolves for Inbound intake chips'
);

SELECT is(
  (SELECT row.label FROM api.list_lookup_values_v1('dedupe_status') AS row WHERE row.value = 'new'),
  'New',
  'dedupe_status.new resolves for Inbound intake chips'
);

SELECT is(
  (SELECT row.label FROM api.list_lookup_values_v1('rate_limit_status') AS row WHERE row.value = 'ok'),
  'OK',
  'rate_limit_status.ok resolves for Inbound intake chips'
);

SELECT is(
  (
    SELECT count(*)::int
      FROM api.list_lookup_values_v1('turnstile_status') AS row
     WHERE row.value IN ('verified', 'pending', 'failed', 'unknown')
  ),
  4,
  'all turnstile_status values are API-visible'
);

SELECT is(
  (
    SELECT count(*)::int
      FROM api.list_lookup_values_v1('dedupe_status') AS row
     WHERE row.value IN ('new', 'duplicate', 'unknown')
  ),
  3,
  'all dedupe_status values are API-visible'
);

SELECT is(
  (
    SELECT count(*)::int
      FROM api.list_lookup_values_v1('rate_limit_status') AS row
     WHERE row.value IN ('ok', 'limited', 'unknown')
  ),
  3,
  'all rate_limit_status values are API-visible'
);

SELECT is(
  (SELECT row.metadata->>'tone' FROM api.list_lookup_values_v1('turnstile_status') AS row WHERE row.value = 'verified'),
  'good',
  'turnstile_status.verified has good tone metadata'
);

SELECT is(
  (SELECT row.metadata->>'tone' FROM api.list_lookup_values_v1('dedupe_status') AS row WHERE row.value = 'duplicate'),
  'warn',
  'dedupe_status.duplicate has warn tone metadata'
);

SELECT is(
  (SELECT row.metadata->>'tone' FROM api.list_lookup_values_v1('rate_limit_status') AS row WHERE row.value = 'limited'),
  'warn',
  'rate_limit_status.limited has warn tone metadata'
);

RESET ROLE;

SELECT * FROM finish();

ROLLBACK;
