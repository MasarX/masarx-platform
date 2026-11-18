-- Migration: Finance partner marketplace participant projection
-- Purpose: expose the Console's marketplace_participants resource key through
-- an explicit security_invoker projection backed by canonical participant profiles.

BEGIN;

SELECT pg_advisory_lock(hashtext('202606061030_finance_partner_marketplace_participants_projection_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE VIEW public.marketplace_participants
WITH (security_invoker = true) AS
SELECT
  p.id,
  p.id AS partner_id,
  p.id AS participant_id,
  p.id AS supplier_participant_profile_id,
  p.organization_id,
  p.participant_type_key,
  p.status,
  p.listing_status,
  p.compliance_state,
  p.display_name,
  p.legal_name,
  COALESCE(NULLIF(p.display_name, ''), NULLIF(p.legal_name, ''), p.id::text) AS name,
  COALESCE(NULLIF(p.display_name, ''), NULLIF(p.legal_name, ''), p.id::text) AS label,
  COALESCE(NULLIF(p.display_name, ''), NULLIF(p.legal_name, ''), p.id::text) AS partner_name,
  p.contact_email,
  p.contact_phone,
  p.locale,
  p.timezone,
  p.rating_overall,
  p.rating_count,
  p.network_metadata,
  p.profile,
  p.last_verified_at,
  p.suspended_at,
  p.created_at,
  p.updated_at
FROM public.marketplace_participant_profiles p;

COMMENT ON VIEW public.marketplace_participants IS
  'Console V2 read projection for marketplace participant profiles. Security-invoker preserves marketplace_participant_profiles RLS while exposing the stable marketplace_participants resource key used by Network and Finance partner scope readback.';

GRANT SELECT ON public.marketplace_participants TO authenticated, service_role;

DO $registry$
DECLARE
  v_setting RECORD;
  v_current JSONB;
  v_next JSONB;
  v_resources JSONB;
BEGIN
  FOR v_setting IN
    SELECT s.id AS setting_id,
           s.settings_version_id,
           sv.version,
           COALESCE(sv.value, s.cached_value, '{"resources":[]}'::jsonb) AS value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
  LOOP
    v_current := COALESCE(v_setting.value, '{"resources":[]}'::jsonb);

    SELECT COALESCE(
             jsonb_agg(
               CASE
                 WHEN resource->>'key' = 'marketplace_participants' THEN
                   resource
                   || jsonb_build_object(
                        'relation', 'public.marketplace_participants',
                        'write_relation', 'public.marketplace_participant_profiles',
                        'select', jsonb_build_array(
                          'id',
                          'partner_id',
                          'participant_id',
                          'supplier_participant_profile_id',
                          'organization_id',
                          'participant_type_key',
                          'status',
                          'listing_status',
                          'compliance_state',
                          'display_name',
                          'legal_name',
                          'name',
                          'label',
                          'partner_name',
                          'contact_email',
                          'contact_phone',
                          'locale',
                          'timezone',
                          'rating_overall',
                          'rating_count',
                          'network_metadata',
                          'profile',
                          'last_verified_at',
                          'suspended_at',
                          'created_at',
                          'updated_at'
                        ),
                        'filters', jsonb_build_array(
                          jsonb_build_object('key', 'participant_type_key', 'column', 'participant_type_key', 'op', 'eq'),
                          jsonb_build_object('key', 'status', 'column', 'status', 'op', 'eq'),
                          jsonb_build_object('key', 'listing_status', 'column', 'listing_status', 'op', 'eq'),
                          jsonb_build_object('key', 'display_name', 'column', 'display_name', 'op', 'ilike'),
                          jsonb_build_object('key', 'name', 'column', 'name', 'op', 'ilike')
                        )
                      )
                 ELSE resource
               END
               ORDER BY ordinality
             ),
             '[]'::jsonb
           )
      INTO v_resources
      FROM jsonb_array_elements(COALESCE(v_current->'resources', '[]'::jsonb))
           WITH ORDINALITY AS r(resource, ordinality);

    v_next := jsonb_set(v_current, '{resources}', v_resources, TRUE);

    UPDATE public.settings_versions sv
       SET value = v_next,
           version = v_setting.version + 1,
           change_reason = 'Console V2: route marketplace participants through stable projection',
           approved_at = now(),
           effective_from = now(),
           updated_at = now()
     WHERE sv.id = v_setting.settings_version_id
       AND sv.value IS DISTINCT FROM v_next;

    UPDATE public.settings s
       SET cached_value = v_next,
           last_updated = now()
     WHERE s.id = v_setting.setting_id
       AND s.cached_value IS DISTINCT FROM v_next;
  END LOOP;

  DELETE FROM public.settings_cache
   WHERE cache_key LIKE 'ui_read_registry:%'
      OR cache_key LIKE 'ui_list_resource:%marketplace_participants%'
      OR cache_key LIKE 'ui_get_resource:%marketplace_participants%';
END;
$registry$;

DO $assert$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'marketplace_participants'
       AND c.relkind = 'v'
       AND COALESCE(c.reloptions, ARRAY[]::text[]) @> ARRAY['security_invoker=true']
  ) THEN
    RAISE EXCEPTION 'marketplace_participants must be a security_invoker view';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(COALESCE(sv.value->'resources', '[]'::jsonb)) AS resource
          WHERE resource->>'key' = 'marketplace_participants'
            AND (
              resource->>'relation' <> 'public.marketplace_participants'
              OR resource->>'write_relation' <> 'public.marketplace_participant_profiles'
              OR EXISTS (
                SELECT 1
                  FROM (VALUES
                    ('partner_id'),
                    ('participant_id'),
                    ('supplier_participant_profile_id'),
                    ('display_name'),
                    ('name')
                  ) AS required(column_name)
                 WHERE NOT EXISTS (
                   SELECT 1
                     FROM jsonb_array_elements_text(COALESCE(resource->'select', '[]'::jsonb)) AS selected(column_name)
                    WHERE selected.column_name = required.column_name
                 )
              )
            )
       )
  ) THEN
    RAISE EXCEPTION 'marketplace_participants registry entries are missing finance partner scope projection metadata';
  END IF;
END;
$assert$;

SELECT pg_advisory_unlock(hashtext('202606061030_finance_partner_marketplace_participants_projection_v1'));

COMMIT;
