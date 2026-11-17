-- Plan: PLAN-202602-tenant-signup-approval-onboarding-defaults / Step: S04
-- Migration: UI registry + console navigation wiring for tenant signup requests queue

BEGIN;
SELECT pg_advisory_lock(hashtext('202602201030_ui_navigation_registry_tenant_signup_requests_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) ui_read_registry resource: tenant_signup_requests
-------------------------------------------------------------------------------
DO $$
DECLARE
  v_current JSONB;
  v_resources JSONB := '[]'::jsonb;
  v_resource JSONB := jsonb_build_object(
    'key', 'tenant_signup_requests',
    'label', 'Tenant signup requests',
    'relation', 'public.tenant_signup_requests',
    'id_column', 'id',
    'capability_read', 'tenant_signup_requests.read',
    'select', jsonb_build_array(
      'id',
      'status',
      'review_decision',
      'email',
      'full_name',
      'organization_name',
      'organization_slug',
      'website_url',
      'phone',
      'locale',
      'created_at',
      'reviewed_at',
      'reviewed_by',
      'review_reason',
      'approved_organization_id',
      'approved_user_id',
      'invite_email_sent_at',
      'invite_redirect_to',
      'last_error_code',
      'last_error_message'
    ),
    'filters', jsonb_build_array(
      jsonb_build_object('key', 'status', 'column', 'status', 'op', 'eq'),
      jsonb_build_object('key', 'review_decision', 'column', 'review_decision', 'op', 'eq'),
      jsonb_build_object('key', 'email', 'column', 'email', 'op', 'ilike'),
      jsonb_build_object('key', 'organization_name', 'column', 'organization_name', 'op', 'ilike'),
      jsonb_build_object('key', 'reviewed_by', 'column', 'reviewed_by', 'op', 'eq')
    ),
    'default_sort', jsonb_build_object('column', 'created_at', 'direction', 'desc')
  );
  v_item JSONB;
  v_updated JSONB := '[]'::jsonb;
  v_found BOOLEAN := FALSE;
BEGIN
  SELECT sv.value
    INTO v_current
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'ui_read_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'ui_read_registry global settings missing';
  END IF;

  v_resources := COALESCE(v_current->'resources', '[]'::jsonb);

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_resources) LOOP
    IF v_item->>'key' = 'tenant_signup_requests' THEN
      v_found := TRUE;
      v_item := v_resource;
    END IF;
    v_updated := v_updated || jsonb_build_array(v_item);
  END LOOP;

  IF v_found IS FALSE THEN
    v_updated := v_updated || jsonb_build_array(v_resource);
  END IF;

  v_current := jsonb_set(v_current, '{resources}', v_updated, true);

  WITH current AS (
    SELECT s.settings_version_id,
           sv.version,
           sv.value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
     LIMIT 1
  ),
  applied AS (
    UPDATE public.settings_versions sv
       SET value = v_current,
           version = current.version + 1,
           change_reason = 'Add tenant_signup_requests to ui_read_registry',
           approved_at = now(),
           effective_from = now()
      FROM current
     WHERE sv.id = current.settings_version_id
       AND v_current IS DISTINCT FROM current.value
    RETURNING sv.id, sv.value
  )
  UPDATE public.settings s
     SET cached_value = applied.value,
         last_updated = now()
    FROM applied
   WHERE s.category = 'ui_read_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
     AND s.settings_version_id = applied.id;
END $$;

-------------------------------------------------------------------------------
-- 2) ui_navigation console entry: Organizations -> Organization requests
-------------------------------------------------------------------------------
DO $$
DECLARE
  v_current JSONB;
  v_console_sections JSONB := '[]'::jsonb;
  v_section JSONB;
  v_items JSONB;
  v_configuration_found BOOLEAN := FALSE;
  v_item JSONB := jsonb_build_object(
    'id', 'console-organization-requests',
    'label', 'Organization requests',
    'href', '/console/organizations/requests',
    'resource', 'tenant_signup_requests',
    'capability', 'tenant_signup_requests.read'
  );
BEGIN
  SELECT sv.value
    INTO v_current
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'ui_navigation'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'ui_navigation global settings missing';
  END IF;

  FOR v_section IN
    SELECT *
    FROM jsonb_array_elements(COALESCE(v_current#>'{apps,console,sections}', '[]'::jsonb))
  LOOP
    IF v_section->>'id' = 'configuration' THEN
      v_configuration_found := TRUE;
      v_items := COALESCE(v_section->'items', '[]'::jsonb);

      IF NOT EXISTS (
        SELECT 1
          FROM jsonb_array_elements(v_items) AS item
         WHERE item->>'id' = 'console-organization-requests'
      ) THEN
        v_items := v_items || jsonb_build_array(v_item);
      END IF;

      v_section := jsonb_set(v_section, '{items}', v_items, TRUE);
    END IF;

    v_console_sections := v_console_sections || jsonb_build_array(v_section);
  END LOOP;

  IF v_configuration_found IS FALSE THEN
    v_console_sections := v_console_sections || jsonb_build_array(
      jsonb_build_object(
        'id', 'configuration',
        'label', 'Configuration',
        'items', jsonb_build_array(v_item)
      )
    );
  END IF;

  v_current := jsonb_set(v_current, '{apps,console,sections}', v_console_sections, TRUE);

  WITH current AS (
    SELECT s.settings_version_id,
           sv.version,
           sv.value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_navigation'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
     LIMIT 1
  ),
  applied AS (
    UPDATE public.settings_versions sv
       SET value = v_current,
           version = current.version + 1,
           change_reason = 'Add organization requests route to console navigation',
           approved_at = now(),
           effective_from = now()
      FROM current
     WHERE sv.id = current.settings_version_id
       AND v_current IS DISTINCT FROM current.value
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
END $$;

SELECT pg_advisory_unlock(hashtext('202602201030_ui_navigation_registry_tenant_signup_requests_v1'));
COMMIT;
