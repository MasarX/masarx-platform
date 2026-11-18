-- Align Console V2 Plugin Studio/Catalog controls with the canonical
-- integration_plugins.write capability used by backend plugin lifecycle RPCs.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605221520_plugin_studio_capability_alignment_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES
  (
    'plugin_studio_source_type',
    'Integrations plugin-studio source-type taxonomy with payload parsing metadata',
    'engineering',
    'tier_1',
    false
  ),
  (
    'plugin_studio_plugin_kind',
    'Integrations plugin-studio semantic plugin-kind taxonomy',
    'engineering',
    'tier_1',
    false
  )
ON CONFLICT (category) DO UPDATE
SET description = EXCLUDED.description,
    owner_role = EXCLUDED.owner_role,
    approval_policy = EXCLUDED.approval_policy,
    is_mutable = EXCLUDED.is_mutable,
    updated_at = now();

WITH def AS (
  SELECT id
    FROM public.lookup_definitions
   WHERE category = 'plugin_studio_source_type'
)
INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  description,
  sort_order,
  is_default,
  status,
  metadata,
  published_at
)
SELECT
  def.id,
  v.value,
  v.label,
  v.description,
  v.sort_order,
  v.is_default,
  'active',
  v.metadata::jsonb,
  now()
FROM def
CROSS JOIN (VALUES
  (
    'curl',
    'cURL command',
    'Raw cURL command for outbound plugin synthesis',
    10,
    true,
    jsonb_build_object(
      'tone', 'info',
      'payload_mode', 'wrap_curl',
      'sample', 'curl -X POST https://api.example.com/v1/orders -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -d ''{"id":"ORD-1","status":"created","customer_phone":"+12025550123"}'''
    )
  ),
  (
    'openapi',
    'OpenAPI document',
    'OpenAPI JSON document for outbound plugin synthesis',
    20,
    false,
    jsonb_build_object(
      'tone', 'info',
      'payload_mode', 'parse_json',
      'sample', '{"openapi":"3.0.0","info":{"title":"Example API","version":"1.0.0"},"paths":{"/orders":{"post":{"summary":"Create order","requestBody":{"content":{"application/json":{"schema":{"type":"object"}}}}}}}}'
    )
  ),
  (
    'webhook_sample',
    'Webhook sample payload',
    'Webhook JSON payload for inbound plugin synthesis',
    30,
    false,
    jsonb_build_object(
      'tone', 'info',
      'payload_mode', 'parse_json',
      'sample', '{"event":"shipment.created","shipment":{"tracking_number":"TRK-99281","external_id":"EXT-12345","status":"created","customer_phone":"+12025550123"}}'
    )
  ),
  (
    'manual',
    'Manual config',
    'Manual JSON plugin configuration',
    40,
    false,
    jsonb_build_object(
      'tone', 'neutral',
      'payload_mode', 'parse_json',
      'sample', '{"webhook":{"sample_payload":{"event":"manual.config","data":{}}}}'
    )
  )
) AS v(value, label, description, sort_order, is_default, metadata)
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    description = EXCLUDED.description,
    sort_order = EXCLUDED.sort_order,
    is_default = EXCLUDED.is_default,
    status = EXCLUDED.status,
    metadata = EXCLUDED.metadata,
    published_at = COALESCE(public.lookup_values.published_at, EXCLUDED.published_at),
    updated_at = now();

WITH def AS (
  SELECT id
    FROM public.lookup_definitions
   WHERE category = 'plugin_studio_plugin_kind'
)
INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  description,
  sort_order,
  is_default,
  status,
  metadata,
  published_at
)
SELECT
  def.id,
  v.value,
  v.label,
  v.description,
  v.sort_order,
  v.is_default,
  'active',
  v.metadata::jsonb,
  now()
FROM def
CROSS JOIN (VALUES
  ('api', 'API', 'Outbound HTTP integration plugin', 10, true, '{"tone":"info","hint":"outbound HTTP"}'::jsonb),
  ('webhook', 'Webhook', 'Inbound webhook integration plugin', 20, false, '{"tone":"info","hint":"inbound"}'::jsonb)
) AS v(value, label, description, sort_order, is_default, metadata)
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    description = EXCLUDED.description,
    sort_order = EXCLUDED.sort_order,
    is_default = EXCLUDED.is_default,
    status = EXCLUDED.status,
    metadata = EXCLUDED.metadata,
    published_at = COALESCE(public.lookup_values.published_at, EXCLUDED.published_at),
    updated_at = now();

DO $read_registry$
DECLARE
  v_current JSONB;
  v_resources JSONB;
  v_resource JSONB := jsonb_build_object(
    'key', 'integration_plugin_directory',
    'label', 'Integration plugin directory',
    'relation', 'public.v_integration_plugin_directory',
    'id_column', 'id',
    'scope_columns', jsonb_build_object('tenant', 'organization_id'),
    'capability_read', 'integration_plugins.read',
    'select', jsonb_build_array(
      'id',
      'organization_id',
      'plugin_key',
      'name',
      'description',
      'plugin_kind',
      'status',
      'rollout_tier',
      'reusable_within_tenant',
      'base_plugin_id',
      'active_version_id',
      'managed_by',
      'metadata',
      'created_by',
      'updated_by',
      'created_at',
      'updated_at',
      'vendor',
      'version_label',
      'active_version_status',
      'version_count',
      'latest_version_no',
      'latest_version_status',
      'binding_count',
      'install_count',
      'active_binding_count',
      'has_active_version',
      'is_pending_review'
    ),
    'columns', jsonb_build_array(
      jsonb_build_object('key','name','label','Name','sortable',true),
      jsonb_build_object('key','plugin_key','label','Key','mono',true,'sortable',true,'filterable',true),
      jsonb_build_object('key','vendor','label','Vendor','sortable',true,'filterable',true),
      jsonb_build_object('key','plugin_kind','label','Kind','sortable',true,'filterable',true),
      jsonb_build_object('key','status','label','Status','sortable',true,'filterable',true),
      jsonb_build_object('key','version_label','label','Active version','mono',true,'sortable',true),
      jsonb_build_object('key','active_version_status','label','Active status','sortable',true,'filterable',true),
      jsonb_build_object('key','version_count','label','Versions','align','right','mono',true,'sortable',true,'type','number'),
      jsonb_build_object('key','latest_version_status','label','Latest status','sortable',true,'filterable',true),
      jsonb_build_object('key','binding_count','label','Bindings','align','right','mono',true,'sortable',true,'type','number'),
      jsonb_build_object('key','active_binding_count','label','Active','align','right','mono',true,'sortable',true,'type','number'),
      jsonb_build_object('key','install_count','label','Installs','align','right','mono',true,'sortable',true,'type','number'),
      jsonb_build_object('key','has_active_version','label','Has active','filterable',true,'sortable',true),
      jsonb_build_object('key','is_pending_review','label','Pending','filterable',true,'sortable',true),
      jsonb_build_object('key','updated_at','label','Updated','format','datetime','sortable',true)
    ),
    'filters', jsonb_build_array(
      jsonb_build_object('key','id','column','id','op','eq'),
      jsonb_build_object('key','organization_id','column','organization_id','op','eq'),
      jsonb_build_object('key','plugin_key','column','plugin_key','op','ilike'),
      jsonb_build_object('key','name','column','name','op','ilike'),
      jsonb_build_object('key','vendor','column','vendor','op','ilike'),
      jsonb_build_object('key','plugin_kind','column','plugin_kind','op','eq'),
      jsonb_build_object('key','status','column','status','op','eq'),
      jsonb_build_object('key','active_version_status','column','active_version_status','op','eq'),
      jsonb_build_object('key','latest_version_status','column','latest_version_status','op','eq'),
      jsonb_build_object('key','has_active_version','column','has_active_version','op','eq'),
      jsonb_build_object('key','is_pending_review','column','is_pending_review','op','eq')
    ),
    'default_sort', jsonb_build_object('column','updated_at','direction','desc')
  );
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

  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(v_resources) AS item
     WHERE item->>'key' = 'integration_plugin_directory'
  ) THEN
    SELECT jsonb_agg(CASE WHEN item->>'key' = 'integration_plugin_directory' THEN v_resource ELSE item END)
      INTO v_resources
      FROM jsonb_array_elements(v_resources) AS item;
  ELSE
    v_resources := v_resources || jsonb_build_array(v_resource);
  END IF;

  v_current := jsonb_set(v_current, '{resources}', v_resources, true);

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
           change_reason = 'Align integration_plugin_directory read registry for Plugin Studio readback',
           approved_at = now(),
           effective_from = now(),
           updated_at = now()
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
END;
$read_registry$;

DO $read_registry_scopes$
DECLARE
  v_scope RECORD;
  v_resource JSONB;
  v_current JSONB;
  v_resources JSONB;
BEGIN
  SELECT resource.value
    INTO v_resource
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id,
         jsonb_array_elements(COALESCE(sv.value->'resources', '[]'::jsonb)) AS resource(value)
   WHERE s.category = 'ui_read_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
     AND resource.value->>'key' = 'integration_plugin_directory'
   LIMIT 1;

  IF v_resource IS NULL THEN
    RAISE EXCEPTION 'integration_plugin_directory global registry resource missing';
  END IF;

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

    IF EXISTS (
      SELECT 1
        FROM jsonb_array_elements(v_resources) AS item
       WHERE item->>'key' = 'integration_plugin_directory'
    ) THEN
      SELECT jsonb_agg(CASE WHEN item->>'key' = 'integration_plugin_directory' THEN v_resource ELSE item END)
        INTO v_resources
        FROM jsonb_array_elements(v_resources) AS item;
    ELSE
      v_resources := v_resources || jsonb_build_array(v_resource);
    END IF;

    v_current := jsonb_set(v_current, '{resources}', v_resources, true);

    UPDATE public.settings_versions sv
       SET value = v_current,
           version = v_scope.version + 1,
           change_reason = 'Align scoped integration_plugin_directory read registry',
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
$read_registry_scopes$;

DO $navigation$
DECLARE
  v_scope RECORD;
  v_current JSONB;
  v_sections JSONB;
  v_new_sections JSONB;
  v_section JSONB;
  v_items JSONB;
  v_new_items JSONB;
  v_item JSONB;
BEGIN
  FOR v_scope IN
    SELECT s.id AS settings_id,
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
      CONTINUE;
    END IF;

    v_new_sections := '[]'::jsonb;
    FOR v_section IN SELECT value FROM jsonb_array_elements(v_sections) AS value LOOP
      v_items := COALESCE(v_section->'items', '[]'::jsonb);
      IF jsonb_typeof(v_items) IS DISTINCT FROM 'array' THEN
        v_new_sections := v_new_sections || jsonb_build_array(v_section);
        CONTINUE;
      END IF;

      v_new_items := '[]'::jsonb;
      FOR v_item IN SELECT value FROM jsonb_array_elements(v_items) AS value LOOP
        IF COALESCE(v_item->>'key', v_item->>'id') = 'int-plugin-studio'
           OR COALESCE(v_item->>'id', '') = 'integrations-plugin-studio'
           OR COALESCE(v_item->>'route', v_item->>'href', v_item->>'path') = '/integrations/plugin-studio' THEN
          v_item := jsonb_set(v_item, '{capability}', to_jsonb('integration_plugins.write'::text), true);
        END IF;
        v_new_items := v_new_items || jsonb_build_array(v_item);
      END LOOP;

      v_new_sections := v_new_sections || jsonb_build_array(
        jsonb_set(v_section, '{items}', v_new_items, true)
      );
    END LOOP;

    v_current := jsonb_set(v_current, '{apps,console,sections}', v_new_sections, true);

    UPDATE public.settings_versions sv
       SET value = v_current,
           version = v_scope.version + 1,
           change_reason = 'Align Plugin Studio navigation with integration_plugins.write',
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

DO $commands$
DECLARE
  v_scope RECORD;
  v_current JSONB;
  v_commands JSONB;
  v_new_commands JSONB;
  v_command JSONB;
BEGIN
  FOR v_scope IN
    SELECT s.id AS settings_id,
           s.settings_version_id,
           sv.version,
           COALESCE(sv.value, s.cached_value, '{"commands":[]}'::jsonb) AS value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_command_registry'
  LOOP
    v_current := COALESCE(v_scope.value, '{"commands":[]}'::jsonb);
    v_commands := COALESCE(v_current->'commands', '[]'::jsonb);
    IF jsonb_typeof(v_commands) IS DISTINCT FROM 'array' THEN
      CONTINUE;
    END IF;

    v_new_commands := '[]'::jsonb;
    FOR v_command IN SELECT value FROM jsonb_array_elements(v_commands) AS value LOOP
      IF v_command->>'key' IN (
        'integrations.install_plugin',
        'integrations.create_plugin',
        'integrations.uninstall_plugin'
      ) THEN
        v_command := jsonb_set(v_command, '{capability}', to_jsonb('integration_plugins.write'::text), true);
      END IF;
      v_new_commands := v_new_commands || jsonb_build_array(v_command);
    END LOOP;

    v_current := jsonb_set(v_current, '{commands}', v_new_commands, true);

    UPDATE public.settings_versions sv
       SET value = v_current,
           version = v_scope.version + 1,
           change_reason = 'Align plugin lifecycle commands with integration_plugins.write',
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
$commands$;

SELECT pg_advisory_unlock(hashtext('202605221520_plugin_studio_capability_alignment_v1'));

COMMIT;
