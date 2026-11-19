-- Console V2 webhook-source mapping option repair.
--
-- Webhook source creation must only offer mapping profiles that can be bound by
-- the canonical plugin-backed source policy. The backend resolver requires a
-- plugin_version_id in mapping_configs.managed_metadata, so the directory
-- projection exposes managed metadata for the frontend to filter invalid ad-hoc
-- mapping profiles before submit.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605090145_console_v2_mapping_source_bindable_projection_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE VIEW public.v_mapping_config_directory
  WITH (security_invoker = true)
  AS
SELECT
  mc.id,
  mc.organization_id,
  mc.mapping_type,
  mc.mapping_key,
  mc.mapping_config,
  mc.mapping_version,
  mc.notes,
  mc.created_at,
  mc.updated_at,
  mc.mapping_config->>'target' AS target,
  mc.mapping_config->>'target_table' AS target_table,
  mc.mapping_config->>'target_action' AS target_action,
  CASE
    WHEN jsonb_typeof(mc.mapping_config->'rules') = 'array'
      THEN jsonb_array_length(mc.mapping_config->'rules')
    ELSE 0
  END AS rules_count,
  COALESCE(usage_agg.source_count, 0) AS source_count,
  COALESCE(usage_agg.rule_usage_count, 0) AS rule_usage_count,
  ((COALESCE(usage_agg.source_count, 0)
    + COALESCE(usage_agg.rule_usage_count, 0)) > 0) AS is_in_use,
  COALESCE(
    jsonb_typeof(mc.mapping_config->'rules') = 'array'
      AND jsonb_array_length(mc.mapping_config->'rules') > 0,
    FALSE
  ) AS has_rules,
  CASE
    WHEN mc.notes IS NULL THEN NULL
    WHEN length(mc.notes) <= 120 THEN mc.notes
    ELSE LEFT(mc.notes, 120) || '...'
  END AS notes_excerpt,
  GREATEST(0, EXTRACT(EPOCH FROM (now() - mc.updated_at)))::BIGINT AS age_seconds,
  mc.managed_by,
  mc.managed_metadata
FROM public.mapping_configs mc
LEFT JOIN LATERAL (
  SELECT
    (SELECT COUNT(*) FROM public.webhook_sources ws
      WHERE ws.mapping_config_id = mc.id) AS source_count,
    (SELECT COUNT(*) FROM public.webhook_rules wr
      WHERE wr.mapping_config_id = mc.id) AS rule_usage_count
) usage_agg ON TRUE;

COMMENT ON VIEW public.v_mapping_config_directory IS
  'FE-friendly projection of mapping_configs with organization_id for tenant-scoped Console V2 reads, derived target fields, usage counters, managed metadata for source-bindable mapping filtering, rules_count, boolean has_rules, notes excerpt, age_seconds, and status flags. Sources: mapping_configs + webhook_sources + webhook_rules. Read-only; SSOT remains mapping_configs.';

REVOKE ALL ON public.v_mapping_config_directory FROM PUBLIC;
REVOKE ALL ON public.v_mapping_config_directory FROM anon;
GRANT SELECT ON public.v_mapping_config_directory TO authenticated;
GRANT SELECT ON public.v_mapping_config_directory TO service_role;

DO $read_registry$
DECLARE
  v_scope RECORD;
  v_current JSONB;
  v_resources JSONB;
  v_filtered JSONB;
  v_resource JSONB := jsonb_build_object(
    'key', 'mapping_config_directory',
    'relation', 'public.v_mapping_config_directory',
    'id_column', 'id',
    'scope_columns', jsonb_build_object('tenant', 'organization_id'),
    'capability_read', 'mappings.read',
    'capability_write', 'mappings.write',
    'default_sort', jsonb_build_object('column', 'updated_at', 'direction', 'desc'),
    'filters', jsonb_build_array(
      jsonb_build_object('key', 'id', 'column', 'id', 'op', 'eq'),
      jsonb_build_object('key', 'organization_id', 'column', 'organization_id', 'op', 'eq'),
      jsonb_build_object('key', 'mapping_type', 'column', 'mapping_type', 'op', 'eq'),
      jsonb_build_object('key', 'mapping_key', 'column', 'mapping_key', 'op', 'ilike'),
      jsonb_build_object('key', 'target', 'column', 'target', 'op', 'eq'),
      jsonb_build_object('key', 'is_in_use', 'column', 'is_in_use', 'op', 'eq')
    ),
    'columns', jsonb_build_array(
      jsonb_build_object('key', 'mapping_type', 'label', 'Type', 'sortable', true, 'filterable', true, 'lookup', 'mapping_type'),
      jsonb_build_object('key', 'mapping_key', 'label', 'Key', 'mono', true, 'sortable', true, 'filterable', true),
      jsonb_build_object('key', 'target', 'label', 'Target', 'mono', true, 'sortable', true, 'filterable', true),
      jsonb_build_object('key', 'rules_count', 'label', 'Rules', 'align', 'right', 'mono', true, 'sortable', true, 'type', 'number'),
      jsonb_build_object('key', 'source_count', 'label', 'Sources', 'align', 'right', 'mono', true, 'sortable', true, 'type', 'number'),
      jsonb_build_object('key', 'rule_usage_count', 'label', 'Used by', 'align', 'right', 'mono', true, 'sortable', true, 'type', 'number'),
      jsonb_build_object('key', 'is_in_use', 'label', 'In use', 'filterable', true, 'sortable', true),
      jsonb_build_object('key', 'has_rules', 'label', 'Has rules', 'filterable', true, 'sortable', true),
      jsonb_build_object('key', 'mapping_version', 'label', 'Version', 'align', 'right', 'mono', true, 'sortable', true),
      jsonb_build_object('key', 'managed_by', 'label', 'Managed by', 'hidden', true),
      jsonb_build_object('key', 'managed_metadata', 'label', 'Managed metadata', 'hidden', true),
      jsonb_build_object('key', 'updated_at', 'label', 'Updated', 'format', 'datetime', 'sortable', true)
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
           change_reason = 'Expose source-bindable mapping metadata for Console V2 webhook source creation',
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

SELECT pg_advisory_unlock(hashtext('202605090145_console_v2_mapping_source_bindable_projection_v1'));

COMMIT;
