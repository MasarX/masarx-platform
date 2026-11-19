-- Console V2 API/webhook shipment intake navigation and lookup readiness.
--
-- API/provider shipment creation is a first-tenant core path, not a secondary
-- demo. Keep the operator surfaces discoverable through row-driven navigation
-- and keep intake status labels sourced from canonical lookup rows.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605081230_console_v2_api_webhook_intake_nav_lookup_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES
  (
    'turnstile_status',
    'Turnstile verification status for inbound intake and tenant registration events.',
    'operations',
    'tier_1',
    false
  ),
  (
    'dedupe_status',
    'Dedupe outcome taxonomy for inbound intake events.',
    'operations',
    'tier_1',
    false
  ),
  (
    'rate_limit_status',
    'Rate-limit decision taxonomy for inbound intake events.',
    'operations',
    'tier_1',
    false
  )
ON CONFLICT (category) DO UPDATE
SET
  description = EXCLUDED.description,
  owner_role = EXCLUDED.owner_role,
  approval_policy = EXCLUDED.approval_policy,
  is_mutable = EXCLUDED.is_mutable,
  updated_at = now();

WITH lookup_rows AS (
  SELECT *
  FROM (
    VALUES
      ('turnstile_status', 'verified', 'Verified', 'Turnstile verification passed.', 10, true, '{"tone":"good"}'::jsonb),
      ('turnstile_status', 'pending', 'Pending', 'Turnstile verification has not completed.', 20, false, '{"tone":"warn"}'::jsonb),
      ('turnstile_status', 'failed', 'Failed', 'Turnstile verification failed.', 30, false, '{"tone":"danger"}'::jsonb),
      ('turnstile_status', 'unknown', 'Unknown', 'Turnstile verification status is unavailable.', 40, false, '{"tone":"neutral"}'::jsonb),
      ('dedupe_status', 'new', 'New', 'Inbound event was accepted as a new event.', 10, true, '{"tone":"good"}'::jsonb),
      ('dedupe_status', 'duplicate', 'Duplicate', 'Inbound event matched a previous event.', 20, false, '{"tone":"warn"}'::jsonb),
      ('dedupe_status', 'unknown', 'Unknown', 'Dedupe status is unavailable.', 30, false, '{"tone":"neutral"}'::jsonb),
      ('rate_limit_status', 'ok', 'OK', 'Inbound event passed rate-limit checks.', 10, true, '{"tone":"good"}'::jsonb),
      ('rate_limit_status', 'limited', 'Limited', 'Inbound event was rate-limited.', 20, false, '{"tone":"warn"}'::jsonb),
      ('rate_limit_status', 'unknown', 'Unknown', 'Rate-limit status is unavailable.', 30, false, '{"tone":"neutral"}'::jsonb)
  ) AS v(category, value, label, description, sort_order, is_default, metadata)
)
INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  description,
  sort_order,
  is_default,
  status,
  metadata
)
SELECT
  d.id,
  r.value,
  r.label,
  r.description,
  r.sort_order,
  r.is_default,
  'active',
  r.metadata
FROM public.lookup_definitions d
JOIN lookup_rows r
  ON r.category = d.category
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  is_default = EXCLUDED.is_default,
  status = 'active',
  effective_until = NULL,
  retired_at = NULL,
  metadata = COALESCE(public.lookup_values.metadata, '{}'::jsonb) || EXCLUDED.metadata,
  updated_at = now();

DO $read_registry$
DECLARE
  v_scope RECORD;
  v_current JSONB;
  v_resources JSONB;
  v_filtered JSONB;
  v_resource JSONB := jsonb_build_object(
    'key', 'webhook_inbox_directory',
    'relation', 'public.v_webhook_inbox_directory',
    'id_column', 'id',
    'capability_read', 'webhooks.read',
    'capability_write', 'webhooks.write',
    'default_sort', jsonb_build_object('column', 'created_at', 'direction', 'desc'),
    'filters', jsonb_build_array(
      jsonb_build_object('key', 'processing_status', 'column', 'processing_status', 'op', 'eq'),
      jsonb_build_object('key', 'event_type', 'column', 'event_type', 'op', 'eq'),
      jsonb_build_object('key', 'webhook_source_id', 'column', 'webhook_source_id', 'op', 'eq'),
      jsonb_build_object('key', 'external_id', 'column', 'external_id', 'op', 'ilike'),
      jsonb_build_object('key', 'correlation_id', 'column', 'correlation_id', 'op', 'eq')
    )
  );
BEGIN
  FOR v_scope IN
    SELECT s.id AS settings_id,
           s.settings_version_id,
           sv.version,
           COALESCE(sv.value, s.cached_value, '{"resources":[]}'::jsonb) AS value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
  LOOP
    v_current := COALESCE(v_scope.value, '{"resources":[]}'::jsonb);
    v_resources := COALESCE(v_current->'resources', '[]'::jsonb);
    IF jsonb_typeof(v_resources) IS DISTINCT FROM 'array' THEN
      v_resources := '[]'::jsonb;
    END IF;

    SELECT COALESCE(jsonb_agg(value), '[]'::jsonb)
      INTO v_filtered
      FROM jsonb_array_elements(v_resources) AS value
     WHERE value->>'key' <> v_resource->>'key';

    v_current := jsonb_set(v_current, '{resources}', v_filtered || jsonb_build_array(v_resource), TRUE);

    UPDATE public.settings_versions sv
       SET value = v_current,
           version = v_scope.version + 1,
           change_reason = 'Expose Console V2 webhook inbox directory read registry',
           approved_at = now(),
           effective_from = now(),
           updated_at = now()
     WHERE sv.id = v_scope.settings_version_id
       AND sv.value IS DISTINCT FROM v_current;

    UPDATE public.settings s
       SET cached_value = v_current,
           last_updated = now()
     WHERE s.id = v_scope.settings_id
       AND s.cached_value IS DISTINCT FROM v_current;
  END LOOP;
END;
$read_registry$;

DO $navigation$
DECLARE
  v_routes JSONB := jsonb_build_array(
    jsonb_build_object('id', 'integrations-catalog', 'key', 'int-catalog', 'label', 'Plugin catalog', 'icon', 'grid', 'path', '/integrations/catalog', 'resource', 'integration_plugins', 'capability', 'integration_plugins.read'),
    jsonb_build_object('id', 'integrations-plugin-studio', 'key', 'int-plugin-studio', 'label', 'Plugin studio', 'icon', 'edit', 'path', '/integrations/plugin-studio', 'resource', 'integration_plugins', 'capability', 'integrations.write'),
    jsonb_build_object('id', 'int-mapping', 'key', 'int-mapping', 'label', 'Mapping studio', 'icon', 'git', 'path', '/integrations/mapping', 'resource', 'mapping_configs', 'capability', 'mappings.read'),
    jsonb_build_object('id', 'integrations-health', 'key', 'int-health', 'label', 'Provider health', 'icon', 'cloud', 'path', '/integrations/health', 'resource', 'integration_plugins', 'capability', 'integrations.read'),
    jsonb_build_object('id', 'integrations-webhook-tester', 'key', 'int-webhook', 'label', 'Webhook tester', 'icon', 'webhook', 'path', '/integrations/webhook-tester', 'resource', 'webhook_inbox_directory', 'capability', 'webhooks.read'),
    jsonb_build_object('id', 'integrations-credentials', 'key', 'int-credentials', 'label', 'Credentials', 'icon', 'key', 'path', '/integrations/credentials', 'resource', 'provider_auth_configs', 'capability', 'provider_auth.read'),
    jsonb_build_object('id', 'integrations-intake', 'key', 'int-intake', 'label', 'Inbound intake monitor', 'icon', 'download', 'path', '/integrations/intake', 'resource', 'webhook_inbox_directory', 'capability', 'webhooks.read'),
    jsonb_build_object('id', 'integrations-sources', 'key', 'integrations-sources', 'label', 'Webhook sources', 'icon', 'plug', 'path', '/integrations/sources', 'resource', 'webhook_sources', 'capability', 'webhooks.read')
  );
  v_scope RECORD;
  v_current JSONB;
  v_sections JSONB;
  v_new_sections JSONB;
  v_section JSONB;
  v_items JSONB;
  v_new_items JSONB;
  v_item JSONB;
  v_route JSONB;
  v_route_item JSONB;
  v_found_section BOOLEAN;
  v_found_item BOOLEAN;
BEGIN
  FOR v_scope IN
    SELECT s.id AS settings_id,
           s.scope_type,
           s.scope_id,
           s.settings_version_id,
           sv.version,
           COALESCE(sv.value, s.cached_value, '{}'::jsonb) AS value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_navigation'
  LOOP
    v_current := COALESCE(v_scope.value, '{}'::jsonb);
    v_sections := COALESCE(v_current#>'{apps,console,sections}', '[]'::jsonb);
    IF jsonb_typeof(v_sections) IS DISTINCT FROM 'array' THEN
      v_sections := '[]'::jsonb;
    END IF;

    FOR v_route IN SELECT value FROM jsonb_array_elements(v_routes) AS value LOOP
      v_route_item := jsonb_strip_nulls(jsonb_build_object(
        'id', v_route->>'id',
        'key', v_route->>'key',
        'label', v_route->>'label',
        'icon', v_route->>'icon',
        'href', v_route->>'path',
        'route', v_route->>'path',
        'resource', v_route->>'resource',
        'capability', v_route->>'capability'
      ));
      v_new_sections := '[]'::jsonb;
      v_found_section := FALSE;

      FOR v_section IN SELECT value FROM jsonb_array_elements(v_sections) AS value LOOP
        IF lower(COALESCE(v_section->>'id', '')) = 'integrations' THEN
          v_found_section := TRUE;
          v_items := COALESCE(v_section->'items', '[]'::jsonb);
          IF jsonb_typeof(v_items) IS DISTINCT FROM 'array' THEN
            v_items := '[]'::jsonb;
          END IF;
          v_new_items := '[]'::jsonb;
          v_found_item := FALSE;

          FOR v_item IN SELECT value FROM jsonb_array_elements(v_items) AS value LOOP
            IF COALESCE(v_item->>'route', v_item->>'href') = v_route->>'path'
               OR v_item->>'id' = v_route->>'id'
               OR v_item->>'key' = v_route->>'key' THEN
              v_new_items := v_new_items || jsonb_build_array(v_item || v_route_item);
              v_found_item := TRUE;
            ELSE
              v_new_items := v_new_items || jsonb_build_array(v_item);
            END IF;
          END LOOP;

          IF NOT v_found_item THEN
            v_new_items := v_new_items || jsonb_build_array(v_route_item);
          END IF;

          v_section := jsonb_set(
            v_section || jsonb_build_object('id', 'integrations', 'label', 'Integrations'),
            '{items}',
            v_new_items,
            TRUE
          );
        END IF;

        v_new_sections := v_new_sections || jsonb_build_array(v_section);
      END LOOP;

      IF NOT v_found_section THEN
        v_new_sections := v_new_sections || jsonb_build_array(jsonb_build_object(
          'id', 'integrations',
          'label', 'Integrations',
          'items', jsonb_build_array(v_route_item)
        ));
      END IF;

      v_sections := v_new_sections;
    END LOOP;

    v_current := jsonb_set(v_current, '{apps,console,sections}', v_sections, TRUE);

    UPDATE public.settings_versions sv
       SET value = v_current,
           version = v_scope.version + 1,
           change_reason = 'Expose Console V2 API/webhook shipment intake navigation and lookup readiness',
           approved_at = now(),
           effective_from = now(),
           updated_at = now()
     WHERE sv.id = v_scope.settings_version_id
       AND sv.value IS DISTINCT FROM v_current;

    UPDATE public.settings s
       SET cached_value = v_current,
           last_updated = now()
     WHERE s.id = v_scope.settings_id
       AND s.cached_value IS DISTINCT FROM v_current;
  END LOOP;
END;
$navigation$;

SELECT pg_advisory_unlock(hashtext('202605081230_console_v2_api_webhook_intake_nav_lookup_v1'));

COMMIT;
