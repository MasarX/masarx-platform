-- Migration: Console V2 partner finance handoff navigation
-- Purpose:
--   Keep the live row-driven Console navigation aligned with the Network
--   Partners operational surface so partner finance handoff is discoverable
--   from the shell before operators drill into scoped Settlements, Disputes,
--   and Ledger views.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605212220_console_v2_partner_finance_handoff_navigation_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $navigation$
DECLARE
  v_row RECORD;
  v_current JSONB;
  v_next JSONB;
  v_sections JSONB;
  v_updated_sections JSONB;
  v_section JSONB;
  v_items JSONB;
  v_clean_items JSONB;
  v_section_id TEXT;
  v_has_network BOOLEAN;
  v_new_settings_version_id UUID;
  v_next_version INTEGER;
  v_partner_item JSONB := jsonb_build_object(
    'id', 'partners',
    'key', 'partners',
    'label', 'Partners',
    'href', '/network/partners',
    'route', '/network/partners',
    'resource', 'marketplace_participants',
    'capability', 'marketplace.read',
    'icon', 'link'
  );
BEGIN
  FOR v_row IN
    SELECT
      s.id AS settings_id,
      s.settings_version_id,
      s.scope_type,
      s.scope_id,
      sv.version,
      sv.schema_version,
      COALESCE(sv.value, s.cached_value, '{}'::jsonb) AS value
    FROM public.settings s
    JOIN public.settings_versions sv
      ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_navigation'
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    v_sections := COALESCE(v_current#>'{apps,console,sections}', '[]'::jsonb);
    IF jsonb_typeof(v_sections) IS DISTINCT FROM 'array' THEN
      v_sections := '[]'::jsonb;
    END IF;

    v_updated_sections := '[]'::jsonb;
    v_has_network := FALSE;

    FOR v_section IN
      SELECT value
      FROM jsonb_array_elements(v_sections) AS value
    LOOP
      v_section_id := COALESCE(v_section->>'id', '');
      v_items := COALESCE(v_section->'items', '[]'::jsonb);
      IF jsonb_typeof(v_items) IS DISTINCT FROM 'array' THEN
        v_items := '[]'::jsonb;
      END IF;

      SELECT COALESCE(jsonb_agg(item.value ORDER BY item.ordinality), '[]'::jsonb)
        INTO v_clean_items
        FROM jsonb_array_elements(v_items) WITH ORDINALITY AS item(value, ordinality)
       WHERE COALESCE(item.value->>'id', item.value->>'key', '') NOT IN (
               'partners',
               'network-partners',
               'marketplace-participants'
             )
         AND COALESCE(item.value->>'resource', '') <> 'marketplace_participants'
         AND COALESCE(item.value->>'route', item.value->>'href', '') NOT IN (
               '/network/partners',
               '/console/resources/marketplace_participants'
             );

      IF v_section_id = 'network' THEN
        v_has_network := TRUE;
        v_section := jsonb_set(
          v_section || jsonb_build_object('id', 'network', 'label', COALESCE(v_section->>'label', 'Network')),
          '{items}',
          jsonb_build_array(v_partner_item) || v_clean_items,
          TRUE
        );
      ELSE
        v_section := jsonb_set(v_section, '{items}', v_clean_items, TRUE);
      END IF;

      v_updated_sections := v_updated_sections || jsonb_build_array(v_section);
    END LOOP;

    IF NOT v_has_network THEN
      v_updated_sections := v_updated_sections || jsonb_build_array(
        jsonb_build_object(
          'id', 'network',
          'label', 'Network',
          'items', jsonb_build_array(v_partner_item)
        )
      );
    END IF;

    v_next := jsonb_set(v_current, '{apps,console,sections}', v_updated_sections, TRUE);

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET effective_until = CASE
               WHEN now() <= effective_from THEN effective_from + interval '1 microsecond'
               ELSE now()
             END,
             updated_at = now()
       WHERE id = v_row.settings_version_id;

      SELECT COALESCE(MAX(version), 0) + 1
        INTO v_next_version
        FROM public.settings_versions
       WHERE category = 'ui_navigation'
         AND scope_type = v_row.scope_type
         AND scope_id IS NOT DISTINCT FROM v_row.scope_id;

      INSERT INTO public.settings_versions (
        category,
        scope_type,
        scope_id,
        version,
        value,
        schema_version,
        change_reason,
        approved_at,
        effective_from
      ) VALUES (
        'ui_navigation',
        v_row.scope_type,
        v_row.scope_id,
        v_next_version,
        v_next,
        COALESCE(v_row.schema_version, 1),
        'Expose Console V2 Partners for partner finance handoff',
        now(),
        now()
      )
      RETURNING id INTO v_new_settings_version_id;

      UPDATE public.settings
         SET settings_version_id = v_new_settings_version_id,
             cached_value = v_next,
             last_updated = now()
       WHERE id = v_row.settings_id;
    END IF;
  END LOOP;

  DELETE FROM public.settings_cache
   WHERE cache_key LIKE 'ui_navigation:%';
END;
$navigation$;

SELECT pg_advisory_unlock(hashtext('202605212220_console_v2_partner_finance_handoff_navigation_v1'));

COMMIT;
