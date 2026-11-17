-- Plan: PLAN-202603-resource-import-related-node-graph / Step: S04
-- Migration: Generic related-node import graph staging + execution

BEGIN;

SELECT pg_advisory_lock(hashtext('202603111100_tabular_import_related_node_graph_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Registry schema + row-driven inline-node config
-------------------------------------------------------------------------------

DO $$
DECLARE
  v_schema JSONB;
  v_current JSONB;
  v_resources JSONB := '[]'::jsonb;
  v_updated_resources JSONB := '[]'::jsonb;
  v_resource JSONB;
  v_columns JSONB;
  v_updated_columns JSONB;
  v_column JSONB;
  v_resource_key TEXT;
  v_column_key TEXT;
  v_column_import JSONB;
  v_reference JSONB;
  v_new_reference JSONB;
BEGIN
  SELECT schema
    INTO v_schema
    FROM public.schema_registry
   WHERE category = 'ui_read_registry'
     AND version = 1
   LIMIT 1;

  IF v_schema IS NULL THEN
    RAISE EXCEPTION 'ui_read_registry schema missing';
  END IF;

  v_schema := jsonb_set(
    v_schema,
    '{properties,resources,items,properties,columns,items,properties,import,properties,reference}',
    jsonb_build_object(
      'type', 'object',
      'properties', jsonb_build_object(
        'resource', jsonb_build_object('type', 'string'),
        'relation', jsonb_build_object('type', 'string'),
        'id_column', jsonb_build_object('type', 'string'),
        'label', jsonb_build_object('type', 'string'),
        'label_column', jsonb_build_object('type', 'string'),
        'display_columns', jsonb_build_object('type', 'array', 'items', jsonb_build_object('type', 'string')),
        'allow_inline_node', jsonb_build_object('type', 'boolean'),
        'inline_node_key', jsonb_build_object('type', 'string'),
        'inline_node_label', jsonb_build_object('type', 'string'),
        'mapping_prefixes', jsonb_build_object('type', 'array', 'items', jsonb_build_object('type', 'string')),
        'match_fields', jsonb_build_object('type', 'array', 'items', jsonb_build_object('type', 'string')),
        'create_mode', jsonb_build_object(
          'type', 'string',
          'enum', jsonb_build_array('match_or_create', 'create_only', 'link_only')
        )
      )
    ),
    TRUE
  );

  UPDATE public.schema_registry
     SET schema = v_schema,
         description = 'UI read registry (v1) with generic import/resource/reference contracts including inline related-node import graph metadata.',
         is_active = TRUE
   WHERE category = 'ui_read_registry'
     AND version = 1;

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

  FOR v_resource IN
    SELECT value
    FROM jsonb_array_elements(v_resources) AS value
  LOOP
    v_resource_key := NULLIF(btrim(COALESCE(v_resource->>'key', '')), '');
    v_columns := COALESCE(v_resource->'columns', '[]'::jsonb);
    IF jsonb_typeof(v_columns) IS DISTINCT FROM 'array' THEN
      v_updated_resources := v_updated_resources || jsonb_build_array(v_resource);
      CONTINUE;
    END IF;

    v_updated_columns := '[]'::jsonb;
    FOR v_column IN
      SELECT value
      FROM jsonb_array_elements(v_columns) AS value
    LOOP
      v_column_key := NULLIF(btrim(COALESCE(v_column->>'key', '')), '');
      v_column_import := COALESCE(v_column->'import', '{}'::jsonb);
      IF jsonb_typeof(v_column_import) IS DISTINCT FROM 'object' THEN
        v_column_import := '{}'::jsonb;
      END IF;

      v_reference := COALESCE(v_column_import->'reference', '{}'::jsonb);
      IF jsonb_typeof(v_reference) IS DISTINCT FROM 'object' THEN
        v_reference := '{}'::jsonb;
      END IF;
      v_new_reference := v_reference;

      IF v_resource_key = 'shipments' AND v_column_key = 'recipient_id' THEN
        v_new_reference := v_reference || jsonb_build_object(
          'allow_inline_node', TRUE,
          'inline_node_key', 'recipient',
          'inline_node_label', 'Recipient',
          'mapping_prefixes', jsonb_build_array('recipient', 'recipient_'),
          'match_fields', jsonb_build_array('external_id', 'phone_number', 'email'),
          'create_mode', 'match_or_create'
        );
      ELSIF v_resource_key = 'shipments' AND v_column_key = 'destination_address_id' THEN
        v_new_reference := v_reference || jsonb_build_object(
          'allow_inline_node', TRUE,
          'inline_node_key', 'destination_address',
          'inline_node_label', 'Destination address',
          'mapping_prefixes', jsonb_build_array('destination_address', 'destination', 'address'),
          'match_fields', jsonb_build_array('normalized_line1', 'city', 'postal_code', 'country'),
          'create_mode', 'match_or_create'
        );
      ELSIF v_resource_key = 'shipments' AND v_column_key = 'origin_address_id' THEN
        v_new_reference := v_reference || jsonb_build_object(
          'allow_inline_node', TRUE,
          'inline_node_key', 'origin_address',
          'inline_node_label', 'Origin address',
          'mapping_prefixes', jsonb_build_array('origin_address', 'origin'),
          'match_fields', jsonb_build_array('normalized_line1', 'city', 'postal_code', 'country'),
          'create_mode', 'match_or_create'
        );
      END IF;

      IF v_resource_key = 'recipients' THEN
        IF v_column_key = 'phone_number' THEN
          v_column_import := jsonb_set(
            v_column_import,
            '{aliases}',
            COALESCE(v_column_import->'aliases', '[]'::jsonb) ||
            jsonb_build_array('phone', 'mobile', 'mobile_number', 'recipient_phone'),
            TRUE
          );
        ELSIF v_column_key = 'name' THEN
          v_column_import := jsonb_set(
            v_column_import,
            '{aliases}',
            COALESCE(v_column_import->'aliases', '[]'::jsonb) ||
            jsonb_build_array('recipient_name', 'full_name', 'customer_name'),
            TRUE
          );
        END IF;
      ELSIF v_resource_key = 'addresses' THEN
        IF v_column_key = 'normalized_line1' THEN
          v_column_import := jsonb_set(
            v_column_import,
            '{aliases}',
            COALESCE(v_column_import->'aliases', '[]'::jsonb) ||
            jsonb_build_array('address', 'address_line_1', 'address_line1', 'line1', 'street'),
            TRUE
          );
        ELSIF v_column_key = 'normalized_line2' THEN
          v_column_import := jsonb_set(
            v_column_import,
            '{aliases}',
            COALESCE(v_column_import->'aliases', '[]'::jsonb) ||
            jsonb_build_array('address_line_2', 'address_line2', 'line2'),
            TRUE
          );
        ELSIF v_column_key = 'postal_code' THEN
          v_column_import := jsonb_set(
            v_column_import,
            '{aliases}',
            COALESCE(v_column_import->'aliases', '[]'::jsonb) ||
            jsonb_build_array('zip', 'zip_code', 'postcode'),
            TRUE
          );
        END IF;
      END IF;

      IF v_new_reference IS DISTINCT FROM v_reference THEN
        v_column_import := jsonb_set(v_column_import, '{reference}', v_new_reference, TRUE);
      END IF;

      v_updated_columns := v_updated_columns || jsonb_build_array(
        jsonb_set(v_column, '{import}', v_column_import, TRUE)
      );
    END LOOP;

    v_updated_resources := v_updated_resources || jsonb_build_array(
      jsonb_set(v_resource, '{columns}', v_updated_columns, TRUE)
    );
  END LOOP;

  v_current := jsonb_set(v_current, '{resources}', COALESCE(v_updated_resources, '[]'::jsonb), TRUE);

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
           change_reason = 'Add generic inline related-node import graph metadata to ui_read_registry',
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
-- 2) Generic related-node helpers
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.tabular_import_parse_target_field_v1(
  p_target_field TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  v_target TEXT := NULLIF(btrim(COALESCE(p_target_field, '')), '');
  v_delim INT := 0;
BEGIN
  IF v_target IS NULL THEN
    RETURN '{}'::jsonb;
  END IF;

  v_delim := strpos(v_target, '.');
  IF v_delim <= 0 THEN
    RETURN jsonb_build_object(
      'target_field', v_target,
      'is_related', FALSE,
      'column_key', v_target
    );
  END IF;

  RETURN jsonb_build_object(
    'target_field', v_target,
    'is_related', TRUE,
    'node_key', left(v_target, v_delim - 1),
    'column_key', substr(v_target, v_delim + 1)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.tabular_import_resolve_inline_node_contract_v1(
  p_node_contracts JSONB,
  p_node_key TEXT
)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT value
    FROM jsonb_array_elements(COALESCE(p_node_contracts, '[]'::jsonb)) AS value
   WHERE NULLIF(btrim(COALESCE(value->>'node_key', '')), '') = NULLIF(btrim(COALESCE(p_node_key, '')), '')
   LIMIT 1
$function$;

CREATE OR REPLACE FUNCTION public.tabular_import_apply_scope_defaults_v1(
  p_payload JSONB,
  p_scope_columns JSONB,
  p_org_id UUID,
  p_client_id UUID,
  p_sender_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  v_payload JSONB := CASE
    WHEN jsonb_typeof(p_payload) = 'object' THEN p_payload
    ELSE '{}'::jsonb
  END;
  v_scope_columns JSONB := CASE
    WHEN jsonb_typeof(p_scope_columns) = 'object' THEN p_scope_columns
    ELSE '{}'::jsonb
  END;
  v_target_field TEXT;
BEGIN
  v_target_field := NULLIF(btrim(COALESCE(v_scope_columns->>'tenant', '')), '');
  IF v_target_field IS NOT NULL AND p_org_id IS NOT NULL AND NOT (v_payload ? v_target_field) THEN
    v_payload := jsonb_set(v_payload, ARRAY[v_target_field], to_jsonb(p_org_id), TRUE);
  END IF;

  v_target_field := NULLIF(btrim(COALESCE(v_scope_columns->>'client', '')), '');
  IF v_target_field IS NOT NULL AND p_client_id IS NOT NULL AND NOT (v_payload ? v_target_field) THEN
    v_payload := jsonb_set(v_payload, ARRAY[v_target_field], to_jsonb(p_client_id), TRUE);
  END IF;

  v_target_field := NULLIF(btrim(COALESCE(v_scope_columns->>'sender', '')), '');
  IF v_target_field IS NOT NULL AND p_sender_id IS NOT NULL AND NOT (v_payload ? v_target_field) THEN
    v_payload := jsonb_set(v_payload, ARRAY[v_target_field], to_jsonb(p_sender_id), TRUE);
  END IF;

  RETURN v_payload;
END;
$function$;

CREATE OR REPLACE FUNCTION public.tabular_import_resolve_inline_node_contracts_v1(
  p_resource JSONB,
  p_registry JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_resource JSONB := COALESCE(p_resource, '{}'::jsonb);
  v_registry JSONB := COALESCE(p_registry, '{}'::jsonb);
  v_resources JSONB := COALESCE(v_registry->'resources', '[]'::jsonb);
  v_columns JSONB := COALESCE(v_resource->'columns', '[]'::jsonb);
  v_result JSONB := '[]'::jsonb;
  v_column JSONB;
  v_column_key TEXT;
  v_column_import JSONB;
  v_reference JSONB;
  v_target_resource_key TEXT;
  v_target_resource JSONB;
  v_target_columns JSONB;
  v_required_targets JSONB;
  v_node_key TEXT;
  v_mapping_prefixes JSONB;
  v_match_fields JSONB;
BEGIN
  IF jsonb_typeof(v_columns) IS DISTINCT FROM 'array' THEN
    RETURN '[]'::jsonb;
  END IF;

  FOR v_column IN
    SELECT value
    FROM jsonb_array_elements(v_columns) AS value
  LOOP
    v_column_key := NULLIF(btrim(COALESCE(v_column->>'key', '')), '');
    IF v_column_key IS NULL THEN
      CONTINUE;
    END IF;

    v_column_import := COALESCE(v_column->'import', '{}'::jsonb);
    IF jsonb_typeof(v_column_import) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    v_reference := COALESCE(v_column_import->'reference', '{}'::jsonb);
    IF jsonb_typeof(v_reference) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;
    IF COALESCE(NULLIF(v_reference->>'allow_inline_node', '')::boolean, FALSE) IS DISTINCT FROM TRUE THEN
      CONTINUE;
    END IF;

    v_target_resource_key := NULLIF(btrim(COALESCE(v_reference->>'resource', '')), '');
    IF v_target_resource_key IS NULL THEN
      CONTINUE;
    END IF;

    SELECT value
      INTO v_target_resource
      FROM jsonb_array_elements(v_resources) AS value
     WHERE NULLIF(btrim(COALESCE(value->>'key', '')), '') = v_target_resource_key
     LIMIT 1;

    IF v_target_resource IS NULL THEN
      CONTINUE;
    END IF;

    SELECT COALESCE(jsonb_agg(target_column.value ORDER BY target_column.value->>'key'), '[]'::jsonb)
      INTO v_target_columns
      FROM jsonb_array_elements(COALESCE(v_target_resource->'columns', '[]'::jsonb)) AS target_column(value)
     WHERE NULLIF(btrim(COALESCE(target_column.value->>'key', '')), '') IS NOT NULL
       AND (
         COALESCE(
           NULLIF(target_column.value#>>ARRAY['import','enabled'], '')::boolean,
           CASE
             WHEN lower(COALESCE(target_column.value->>'edit_mode', '')) IN ('none', 'read') THEN FALSE
             ELSE TRUE
           END
         ) IS TRUE
       );

    SELECT COALESCE(
      jsonb_agg(to_jsonb(value->>'key') ORDER BY value->>'key'),
      '[]'::jsonb
    )
      INTO v_required_targets
      FROM jsonb_array_elements(COALESCE(v_target_columns, '[]'::jsonb)) AS value
     WHERE COALESCE(NULLIF(value#>>ARRAY['import','required'], '')::boolean, FALSE) IS TRUE;

    v_node_key := COALESCE(
      NULLIF(btrim(COALESCE(v_reference->>'inline_node_key', '')), ''),
      regexp_replace(v_column_key, '_id$', '')
    );
    v_mapping_prefixes := CASE
      WHEN jsonb_typeof(v_reference->'mapping_prefixes') = 'array'
           AND jsonb_array_length(v_reference->'mapping_prefixes') > 0
        THEN v_reference->'mapping_prefixes'
      ELSE jsonb_build_array(v_node_key)
    END;
    v_match_fields := CASE
      WHEN jsonb_typeof(v_reference->'match_fields') = 'array'
           AND jsonb_array_length(v_reference->'match_fields') > 0
        THEN v_reference->'match_fields'
      WHEN jsonb_typeof(v_target_resource#>'{import,identity_columns}') = 'array'
        THEN v_target_resource#>'{import,identity_columns}'
      ELSE '[]'::jsonb
    END;

    v_result := v_result || jsonb_build_array(
      jsonb_strip_nulls(
        jsonb_build_object(
          'node_key', v_node_key,
          'node_label', COALESCE(
            NULLIF(btrim(COALESCE(v_reference->>'inline_node_label', '')), ''),
            NULLIF(btrim(COALESCE(v_reference->>'label', '')), ''),
            NULLIF(btrim(COALESCE(v_target_resource->>'label', '')), ''),
            initcap(replace(v_node_key, '_', ' '))
          ),
          'reference_field', v_column_key,
          'target_resource', v_target_resource_key,
          'target_label', NULLIF(btrim(COALESCE(v_target_resource->>'label', '')), ''),
          'relation', NULLIF(btrim(COALESCE(v_target_resource->>'relation', '')), ''),
          'id_column', COALESCE(NULLIF(btrim(COALESCE(v_target_resource->>'id_column', '')), ''), 'id'),
          'scope_columns', COALESCE(v_target_resource->'scope_columns', '{}'::jsonb),
          'columns', COALESCE(v_target_columns, '[]'::jsonb),
          'required_targets', COALESCE(v_required_targets, '[]'::jsonb),
          'mapping_prefixes', v_mapping_prefixes,
          'match_fields', v_match_fields,
          'create_mode', COALESCE(NULLIF(btrim(COALESCE(v_reference->>'create_mode', '')), ''), 'match_or_create')
        )
      )
    );
  END LOOP;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.tabular_import_refresh_run_rollups_v1(
  p_run_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_run public.tabular_import_runs%ROWTYPE;
  v_total_rows INT := 0;
  v_will_create INT := 0;
  v_will_update INT := 0;
  v_will_skip INT := 0;
  v_blocked_count INT := 0;
  v_warning_count INT := 0;
  v_created_count INT := 0;
  v_updated_count INT := 0;
  v_skipped_count INT := 0;
  v_failed_count INT := 0;
  v_automatic_corrections JSONB := '[]'::jsonb;
  v_blocking_diagnostics JSONB := '[]'::jsonb;
  v_warning_diagnostics JSONB := '[]'::jsonb;
  v_rows_preview JSONB := '[]'::jsonb;
  v_related_node_summary JSONB := '[]'::jsonb;
BEGIN
  IF p_run_id IS NULL THEN
    RAISE EXCEPTION 'tabular_import_refresh_run_rollups_v1 requires run id';
  END IF;

  SELECT *
    INTO v_run
    FROM public.tabular_import_runs
   WHERE id = p_run_id
   FOR UPDATE;

  IF v_run.id IS NULL THEN
    RAISE EXCEPTION 'tabular_import_refresh_run_rollups_v1 run % not found', p_run_id;
  END IF;

  SELECT
    count(*)::int,
    count(*) FILTER (WHERE action = 'create')::int,
    count(*) FILTER (WHERE action = 'update')::int,
    count(*) FILTER (WHERE action = 'skip')::int,
    count(*) FILTER (WHERE action = 'block' OR execution_status = 'blocked')::int,
    count(*) FILTER (WHERE action = 'create' AND execution_status = 'succeeded')::int,
    count(*) FILTER (WHERE action = 'update' AND execution_status = 'succeeded')::int,
    count(*) FILTER (WHERE action = 'skip' OR execution_status = 'skipped')::int,
    count(*) FILTER (WHERE action = 'failed' OR execution_status = 'failed')::int
  INTO
    v_total_rows,
    v_will_create,
    v_will_update,
    v_will_skip,
    v_blocked_count,
    v_created_count,
    v_updated_count,
    v_skipped_count,
    v_failed_count
  FROM public.tabular_import_run_rows
  WHERE run_id = p_run_id;

  SELECT COALESCE(count(*), 0)::int
    INTO v_warning_count
    FROM public.tabular_import_run_rows r
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(r.diagnostics, '[]'::jsonb)) AS diag
   WHERE r.run_id = p_run_id
     AND lower(COALESCE(diag->>'level', '')) = 'warning';

  SELECT COALESCE(jsonb_agg(coercion), '[]'::jsonb)
    INTO v_automatic_corrections
    FROM (
      SELECT coercion
      FROM public.tabular_import_run_rows r
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(r.coercions, '[]'::jsonb)) AS coercion
      WHERE r.run_id = p_run_id
    ) entries;

  SELECT COALESCE(jsonb_agg(diag), '[]'::jsonb)
    INTO v_blocking_diagnostics
    FROM (
      SELECT diag
      FROM public.tabular_import_run_rows r
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(r.diagnostics, '[]'::jsonb)) AS diag
      WHERE r.run_id = p_run_id
        AND COALESCE((diag->>'blocking')::boolean, FALSE) IS TRUE
    ) entries;

  SELECT COALESCE(jsonb_agg(diag), '[]'::jsonb)
    INTO v_warning_diagnostics
    FROM (
      SELECT diag
      FROM public.tabular_import_run_rows r
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(r.diagnostics, '[]'::jsonb)) AS diag
      WHERE r.run_id = p_run_id
        AND lower(COALESCE(diag->>'level', '')) = 'warning'
    ) entries;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_strip_nulls(
        jsonb_build_object(
          'row_number', row_number,
          'execution_status', execution_status,
          'action', action,
          'diagnostics', diagnostics,
          'coercions', coercions,
          'original_row', original_row,
          'mapped_row', mapped_row,
          'target_record_id', target_record_id,
          'reason_codes', reason_codes,
          'reason_messages', reason_messages,
          'related_nodes', COALESCE(metadata->'related_nodes', '[]'::jsonb)
        )
      )
      ORDER BY row_number ASC
    ),
    '[]'::jsonb
  )
    INTO v_rows_preview
    FROM (
      SELECT *
      FROM public.tabular_import_run_rows
      WHERE run_id = p_run_id
      ORDER BY row_number ASC
      LIMIT 25
    ) sample_rows;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_strip_nulls(
        jsonb_build_object(
          'node_key', node_key,
          'node_label', node_label,
          'target_resource', target_resource,
          'will_create', will_create,
          'will_link', will_link,
          'blocked_count', blocked_count,
          'skipped_count', skipped_count,
          'created_count', created_count,
          'linked_count', linked_count,
          'failed_count', failed_count
        )
      )
      ORDER BY node_key
    ),
    '[]'::jsonb
  )
    INTO v_related_node_summary
    FROM (
      SELECT
        NULLIF(btrim(COALESCE(node->>'node_key', '')), '') AS node_key,
        COALESCE(
          NULLIF(btrim(COALESCE(node->>'node_label', '')), ''),
          initcap(replace(COALESCE(node->>'node_key', ''), '_', ' '))
        ) AS node_label,
        NULLIF(btrim(COALESCE(node->>'target_resource', '')), '') AS target_resource,
        count(*) FILTER (
          WHERE COALESCE(node->>'action', '') = 'create'
            AND COALESCE(node->>'execution_status', '') IN ('queued', 'processing')
        )::int AS will_create,
        count(*) FILTER (
          WHERE COALESCE(node->>'action', '') = 'link'
            AND COALESCE(node->>'execution_status', '') IN ('queued', 'processing')
        )::int AS will_link,
        count(*) FILTER (WHERE COALESCE(node->>'execution_status', '') = 'blocked')::int AS blocked_count,
        count(*) FILTER (WHERE COALESCE(node->>'execution_status', '') = 'skipped')::int AS skipped_count,
        count(*) FILTER (
          WHERE COALESCE(node->>'action', '') = 'create'
            AND COALESCE(node->>'execution_status', '') = 'succeeded'
        )::int AS created_count,
        count(*) FILTER (
          WHERE COALESCE(node->>'action', '') = 'link'
            AND COALESCE(node->>'execution_status', '') = 'succeeded'
        )::int AS linked_count,
        count(*) FILTER (WHERE COALESCE(node->>'execution_status', '') = 'failed')::int AS failed_count
      FROM public.tabular_import_run_rows r
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(r.metadata->'related_nodes', '[]'::jsonb)) AS node
      WHERE r.run_id = p_run_id
        AND NULLIF(btrim(COALESCE(node->>'node_key', '')), '') IS NOT NULL
      GROUP BY 1, 2, 3
    ) rollup;

  UPDATE public.tabular_import_runs
     SET total_rows = v_total_rows,
         will_create = v_will_create,
         will_update = v_will_update,
         will_skip = v_will_skip,
         blocked_count = v_blocked_count,
         warning_count = v_warning_count,
         created_count = v_created_count,
         updated_count = v_updated_count,
         skipped_count = v_skipped_count,
         failed_count = v_failed_count,
         summary = jsonb_strip_nulls(
           COALESCE(summary, '{}'::jsonb) || jsonb_build_object(
             'automatic_corrections', COALESCE(v_automatic_corrections, '[]'::jsonb),
             'blocking_diagnostics', COALESCE(v_blocking_diagnostics, '[]'::jsonb),
             'warning_diagnostics', COALESCE(v_warning_diagnostics, '[]'::jsonb),
             'rows_preview', COALESCE(v_rows_preview, '[]'::jsonb),
             'related_node_summary', COALESCE(v_related_node_summary, '[]'::jsonb)
           )
         ),
         updated_at = now()
   WHERE id = p_run_id;

  RETURN jsonb_build_object(
    'run_id', p_run_id,
    'total_rows', v_total_rows,
    'will_create', v_will_create,
    'will_update', v_will_update,
    'will_skip', v_will_skip,
    'blocked_count', v_blocked_count,
    'warning_count', v_warning_count,
    'created_count', v_created_count,
    'updated_count', v_updated_count,
    'skipped_count', v_skipped_count,
    'failed_count', v_failed_count,
    'related_node_summary', COALESCE(v_related_node_summary, '[]'::jsonb)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.tabular_import_stage_related_nodes_v1(
  p_run_id UUID,
  p_node_contracts JSONB,
  p_node_rules JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_run public.tabular_import_runs%ROWTYPE;
  v_row public.tabular_import_run_rows%ROWTYPE;
  v_node_contracts JSONB := COALESCE(p_node_contracts, '[]'::jsonb);
  v_node_rules JSONB := COALESCE(p_node_rules, '[]'::jsonb);
  v_node_contract JSONB;
  v_node_rule JSONB;
  v_parse JSONB;
  v_node_key TEXT;
  v_column_key TEXT;
  v_reference_field TEXT;
  v_node_payload JSONB;
  v_node_diagnostics JSONB;
  v_node_coercions JSONB;
  v_node_columns JSONB;
  v_node_column JSONB;
  v_raw_value JSONB;
  v_value_result JSONB;
  v_match_fields TEXT[] := ARRAY[]::TEXT[];
  v_match_result JSONB;
  v_match_count INT := 0;
  v_node_target_id TEXT;
  v_node_action TEXT;
  v_node_execution_status TEXT;
  v_related_nodes JSONB;
  v_row_diagnostics JSONB;
  v_row_coercions JSONB;
  v_reason_codes JSONB;
  v_reason_messages JSONB;
  v_has_rules BOOLEAN;
  v_has_payload BOOLEAN;
  v_primary_action TEXT;
  v_primary_status TEXT;
  v_existing_reference TEXT;
BEGIN
  IF p_run_id IS NULL THEN
    RAISE EXCEPTION 'tabular_import_stage_related_nodes_v1 requires run id';
  END IF;

  SELECT *
    INTO v_run
    FROM public.tabular_import_runs
   WHERE id = p_run_id;

  IF v_run.id IS NULL THEN
    RAISE EXCEPTION 'tabular_import_stage_related_nodes_v1 run % not found', p_run_id;
  END IF;

  IF jsonb_typeof(v_node_contracts) IS DISTINCT FROM 'array' THEN
    v_node_contracts := '[]'::jsonb;
  END IF;
  IF jsonb_typeof(v_node_rules) IS DISTINCT FROM 'array' THEN
    v_node_rules := '[]'::jsonb;
  END IF;

  FOR v_row IN
    SELECT *
    FROM public.tabular_import_run_rows
    WHERE run_id = p_run_id
    ORDER BY row_number ASC
    FOR UPDATE
  LOOP
    v_related_nodes := '[]'::jsonb;
    v_row_diagnostics := COALESCE(v_row.diagnostics, '[]'::jsonb);
    v_row_coercions := COALESCE(v_row.coercions, '[]'::jsonb);
    v_primary_action := COALESCE(v_row.action, 'create');
    v_primary_status := COALESCE(v_row.execution_status, 'queued');

    FOR v_node_contract IN
      SELECT value
      FROM jsonb_array_elements(v_node_contracts) AS value
    LOOP
      v_node_key := NULLIF(btrim(COALESCE(v_node_contract->>'node_key', '')), '');
      v_reference_field := NULLIF(btrim(COALESCE(v_node_contract->>'reference_field', '')), '');
      IF v_node_key IS NULL OR v_reference_field IS NULL THEN
        CONTINUE;
      END IF;

      v_node_payload := '{}'::jsonb;
      v_node_diagnostics := '[]'::jsonb;
      v_node_coercions := '[]'::jsonb;
      v_node_columns := COALESCE(v_node_contract->'columns', '[]'::jsonb);
      v_has_rules := FALSE;

      FOR v_node_rule IN
        SELECT value
        FROM jsonb_array_elements(v_node_rules) AS value
      LOOP
        v_parse := public.tabular_import_parse_target_field_v1(v_node_rule->>'target_field');
        IF COALESCE(v_parse->>'node_key', '') <> v_node_key THEN
          CONTINUE;
        END IF;

        v_has_rules := TRUE;
        v_column_key := NULLIF(btrim(COALESCE(v_parse->>'column_key', '')), '');
        IF v_column_key IS NULL THEN
          CONTINUE;
        END IF;

        v_node_column := public.tabular_import_resolve_column_v1(v_node_columns, v_column_key);
        IF v_node_column IS NULL THEN
          v_node_diagnostics := v_node_diagnostics || jsonb_build_array(
            jsonb_build_object(
              'level', 'error',
              'blocking', TRUE,
              'code', 'related_target_unknown',
              'fieldPath', format('%s.%s', v_node_key, v_column_key),
              'message', format('Related target %s.%s is not importable.', v_node_key, v_column_key),
              'why', 'The selected related-node field is not enabled by the target resource import contract.',
              'recommended_fix', 'Choose one of the import-enabled fields for this related node.'
            )
          );
          CONTINUE;
        END IF;

        v_raw_value := COALESCE(
          v_row.original_row -> NULLIF(btrim(COALESCE(v_node_rule->>'source_column', '')), ''),
          'null'::jsonb
        );
        v_value_result := public.tabular_import_coerce_value_v1(
          v_raw_value,
          v_node_column,
          NULLIF(btrim(COALESCE(v_node_rule->>'source_column', '')), '')
        );
        IF v_value_result ? 'diagnostics' THEN
          v_node_diagnostics := v_node_diagnostics || COALESCE(v_value_result->'diagnostics', '[]'::jsonb);
        END IF;
        IF v_value_result ? 'coercion' THEN
          v_node_coercions := v_node_coercions || jsonb_build_array(v_value_result->'coercion');
        END IF;
        IF v_value_result ? 'value' THEN
          v_node_payload := jsonb_set(
            v_node_payload,
            ARRAY[v_column_key],
            COALESCE(v_value_result->'value', 'null'::jsonb),
            TRUE
          );
        END IF;
      END LOOP;

      IF NOT v_has_rules THEN
        CONTINUE;
      END IF;

      v_node_payload := public.tabular_import_apply_scope_defaults_v1(
        v_node_payload,
        COALESCE(v_node_contract->'scope_columns', '{}'::jsonb),
        v_run.organization_id,
        v_run.client_id,
        v_run.sender_id
      );

      SELECT EXISTS (
        SELECT 1
        FROM jsonb_each(v_node_payload)
        WHERE value IS NOT NULL
          AND value <> 'null'::jsonb
          AND (jsonb_typeof(value) <> 'string' OR NULLIF(btrim(value#>>'{}'), '') IS NOT NULL)
      )
        INTO v_has_payload;

      IF v_has_payload THEN
        FOR v_column_key IN
          SELECT value
          FROM jsonb_array_elements_text(COALESCE(v_node_contract->'required_targets', '[]'::jsonb)) AS value
        LOOP
          IF NOT (v_node_payload ? v_column_key)
             OR v_node_payload->v_column_key IS NULL
             OR v_node_payload->v_column_key = 'null'::jsonb
             OR (
               jsonb_typeof(v_node_payload->v_column_key) = 'string'
               AND NULLIF(btrim(v_node_payload->>v_column_key), '') IS NULL
             ) THEN
            v_node_diagnostics := v_node_diagnostics || jsonb_build_array(
              jsonb_build_object(
                'level', 'error',
                'blocking', TRUE,
                'code', 'related_required_field_missing',
                'fieldPath', format('%s.%s', v_node_key, v_column_key),
                'message', format('Required related field %s.%s is missing on row %s.', v_node_key, v_column_key, v_row.row_number),
                'why', 'The staged related record does not contain a value for one of its required target columns.',
                'recommended_fix', 'Map or override this related-node field before approval.'
              )
            );
          END IF;
        END LOOP;
      END IF;

      v_existing_reference := NULLIF(btrim(COALESCE(v_row.mapped_row->>v_reference_field, '')), '');
      IF v_existing_reference IS NOT NULL AND v_has_payload THEN
        v_node_diagnostics := v_node_diagnostics || jsonb_build_array(
          jsonb_build_object(
            'level', 'error',
            'blocking', TRUE,
            'code', 'related_reference_conflict',
            'fieldPath', v_reference_field,
            'message', format('Row %s maps both %s and related-node fields for %s.', v_row.row_number, v_reference_field, v_node_key),
            'why', 'The importer cannot decide whether to link the existing reference id or create/match a related node from the worksheet data.',
            'recommended_fix', 'Either keep the direct reference id mapping or use only the related-node fields for this relationship.'
          )
        );
      END IF;

      v_node_action := 'skip';
      v_node_execution_status := CASE
        WHEN v_primary_action = 'block' OR v_primary_status = 'blocked' THEN 'blocked'
        WHEN v_primary_action = 'skip' OR v_primary_status = 'skipped' THEN 'skipped'
        ELSE 'queued'
      END;
      v_node_target_id := NULL;
      v_match_count := 0;

      IF v_existing_reference IS NOT NULL AND NOT v_has_payload THEN
        v_node_action := 'link';
        v_node_target_id := v_existing_reference;
      ELSIF v_has_payload THEN
        SELECT ARRAY(
          SELECT value
          FROM jsonb_array_elements_text(COALESCE(v_node_contract->'match_fields', '[]'::jsonb)) AS value
          WHERE NULLIF(btrim(value), '') IS NOT NULL
        )
          INTO v_match_fields;

        IF v_primary_action IN ('create', 'update')
           AND v_primary_status = 'queued'
           AND NOT EXISTS (
             SELECT 1
             FROM jsonb_array_elements(v_node_diagnostics) AS diag
             WHERE COALESCE((diag->>'blocking')::boolean, FALSE) IS TRUE
           ) THEN
          IF array_length(v_match_fields, 1) IS NOT NULL
             AND COALESCE(NULLIF(v_node_contract->>'create_mode', ''), 'match_or_create') <> 'create_only' THEN
            v_match_result := public.tabular_import_match_target_v1(
              COALESCE(v_node_contract->>'relation', ''),
              COALESCE(v_node_contract->>'id_column', 'id'),
              v_node_payload,
              v_match_fields
            );
            BEGIN
              v_match_count := COALESCE(NULLIF(v_match_result->>'match_count', '')::int, 0);
            EXCEPTION
              WHEN OTHERS THEN
                v_match_count := 0;
            END;
            v_node_target_id := NULLIF(btrim(COALESCE(v_match_result->>'target_record_id', '')), '');
          END IF;

          IF v_match_count > 1 THEN
            v_node_action := 'block';
            v_node_execution_status := 'blocked';
            v_node_diagnostics := v_node_diagnostics || jsonb_build_array(
              jsonb_build_object(
                'level', 'error',
                'blocking', TRUE,
                'code', 'related_identity_match_ambiguous',
                'fieldPath', v_reference_field,
                'message', format('Row %s matched multiple %s records.', v_row.row_number, COALESCE(v_node_contract->>'target_label', v_node_key)),
                'why', 'Configured related-node match fields resolved to more than one existing target row.',
                'recommended_fix', 'Provide a more specific identifier or fix the target data before approval.'
              )
            );
          ELSIF v_match_count = 1 AND v_node_target_id IS NOT NULL THEN
            v_node_action := 'link';
          ELSIF COALESCE(NULLIF(v_node_contract->>'create_mode', ''), 'match_or_create') = 'link_only' THEN
            v_node_action := 'block';
            v_node_execution_status := 'blocked';
            v_node_diagnostics := v_node_diagnostics || jsonb_build_array(
              jsonb_build_object(
                'level', 'error',
                'blocking', TRUE,
                'code', 'related_match_missing',
                'fieldPath', v_reference_field,
                'message', format('Row %s could not match an existing %s record.', v_row.row_number, COALESCE(v_node_contract->>'target_label', v_node_key)),
                'why', 'This related node is configured to link existing records only, but no target record matched the provided data.',
                'recommended_fix', 'Choose an existing related record or widen the match fields/configuration.'
              )
            );
          ELSE
            v_node_action := 'create';
          END IF;
        ELSE
          v_node_action := CASE
            WHEN v_primary_action = 'block' OR v_primary_status = 'blocked' THEN 'block'
            WHEN v_primary_action = 'skip' OR v_primary_status = 'skipped' THEN 'skip'
            ELSE 'skip'
          END;
        END IF;
      END IF;

      IF EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_node_diagnostics) AS diag
        WHERE COALESCE((diag->>'blocking')::boolean, FALSE) IS TRUE
      ) THEN
        IF v_primary_action IN ('create', 'update') THEN
          v_primary_action := 'block';
          v_primary_status := 'blocked';
        END IF;
        IF v_node_execution_status = 'queued' THEN
          v_node_execution_status := 'blocked';
        END IF;
      END IF;

      v_related_nodes := v_related_nodes || jsonb_build_array(
        jsonb_strip_nulls(
          jsonb_build_object(
            'node_key', v_node_key,
            'node_label', COALESCE(v_node_contract->>'node_label', v_node_key),
            'reference_field', v_reference_field,
            'target_resource', v_node_contract->>'target_resource',
            'target_label', v_node_contract->>'target_label',
            'relation', v_node_contract->>'relation',
            'id_column', v_node_contract->>'id_column',
            'create_mode', v_node_contract->>'create_mode',
            'match_fields', COALESCE(v_node_contract->'match_fields', '[]'::jsonb),
            'payload', v_node_payload,
            'action', v_node_action,
            'execution_status', v_node_execution_status,
            'match_count', v_match_count,
            'target_record_id', v_node_target_id,
            'diagnostics', COALESCE(v_node_diagnostics, '[]'::jsonb),
            'coercions', COALESCE(v_node_coercions, '[]'::jsonb)
          )
        )
      );

      v_row_diagnostics := v_row_diagnostics || COALESCE(v_node_diagnostics, '[]'::jsonb);
      v_row_coercions := v_row_coercions || COALESCE(v_node_coercions, '[]'::jsonb);
    END LOOP;

    SELECT COALESCE(jsonb_agg(diag->>'code'), '[]'::jsonb),
           COALESCE(jsonb_agg(diag->>'message'), '[]'::jsonb)
      INTO v_reason_codes, v_reason_messages
      FROM jsonb_array_elements(COALESCE(v_row_diagnostics, '[]'::jsonb)) AS diag;

    UPDATE public.tabular_import_run_rows
       SET action = v_primary_action,
           execution_status = v_primary_status,
           diagnostics = COALESCE(v_row_diagnostics, '[]'::jsonb),
           coercions = COALESCE(v_row_coercions, '[]'::jsonb),
           reason_codes = COALESCE(v_reason_codes, '[]'::jsonb),
           reason_messages = COALESCE(v_reason_messages, '[]'::jsonb),
           metadata = jsonb_strip_nulls(
             COALESCE(v_row.metadata, '{}'::jsonb) || jsonb_build_object(
               'related_nodes', COALESCE(v_related_nodes, '[]'::jsonb)
             )
           ),
           updated_at = now()
     WHERE id = v_row.id;
  END LOOP;

  RETURN public.tabular_import_refresh_run_rollups_v1(p_run_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.tabular_import_execute_row_graph_v1(
  p_run_id UUID,
  p_row_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_run public.tabular_import_runs%ROWTYPE;
  v_row public.tabular_import_run_rows%ROWTYPE;
  v_resource JSONB;
  v_relation TEXT;
  v_id_column TEXT;
  v_primary_payload JSONB;
  v_related_nodes JSONB := '[]'::jsonb;
  v_node JSONB;
  v_node_action TEXT;
  v_node_status TEXT;
  v_reference_field TEXT;
  v_node_target_id TEXT;
  v_node_result JSONB;
  v_primary_result JSONB;
  v_primary_target_id TEXT;
BEGIN
  IF p_run_id IS NULL OR p_row_id IS NULL THEN
    RAISE EXCEPTION 'tabular_import_execute_row_graph_v1 requires run id and row id';
  END IF;

  SELECT *
    INTO v_run
    FROM public.tabular_import_runs
   WHERE id = p_run_id;

  IF v_run.id IS NULL THEN
    RAISE EXCEPTION 'tabular_import_execute_row_graph_v1 run % not found', p_run_id;
  END IF;

  SELECT *
    INTO v_row
    FROM public.tabular_import_run_rows
   WHERE id = p_row_id
     AND run_id = p_run_id;

  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'tabular_import_execute_row_graph_v1 row % not found', p_row_id;
  END IF;

  v_resource := public.tabular_import_resolve_resource_v1(v_run.resource_key);
  v_relation := COALESCE(NULLIF(btrim(COALESCE(v_resource->>'relation', '')), ''), v_run.relation_name);
  v_id_column := COALESCE(NULLIF(btrim(COALESCE(v_resource->>'id_column', '')), ''), 'id');
  v_primary_payload := COALESCE(v_row.mapped_row, '{}'::jsonb);

  FOR v_node IN
    SELECT value
    FROM jsonb_array_elements(COALESCE(v_row.metadata->'related_nodes', '[]'::jsonb)) AS value
  LOOP
    v_node_action := COALESCE(NULLIF(btrim(COALESCE(v_node->>'action', '')), ''), 'skip');
    v_node_status := COALESCE(NULLIF(btrim(COALESCE(v_node->>'execution_status', '')), ''), 'skipped');
    v_reference_field := NULLIF(btrim(COALESCE(v_node->>'reference_field', '')), '');

    IF v_node_status NOT IN ('queued', 'processing') OR v_node_action NOT IN ('create', 'link') THEN
      v_related_nodes := v_related_nodes || jsonb_build_array(v_node);
      CONTINUE;
    END IF;

    IF v_reference_field IS NULL THEN
      RAISE EXCEPTION 'related node missing reference_field on row %', v_row.row_number;
    END IF;

    IF v_node_action = 'link' THEN
      v_node_target_id := NULLIF(btrim(COALESCE(v_node->>'target_record_id', '')), '');
      IF v_node_target_id IS NULL THEN
        RAISE EXCEPTION 'related node % missing target_record_id on row %', COALESCE(v_node->>'node_key', '?'), v_row.row_number;
      END IF;
      v_node_result := jsonb_build_object('id', v_node_target_id, 'mode', 'linked');
    ELSE
      v_node_result := public.tabular_import_write_row_v1(
        COALESCE(v_node->>'relation', ''),
        COALESCE(NULLIF(btrim(COALESCE(v_node->>'id_column', '')), ''), 'id'),
        COALESCE(v_node->'payload', '{}'::jsonb),
        NULL
      );
      v_node_target_id := COALESCE(
        NULLIF(btrim(COALESCE(v_node_result->>COALESCE(NULLIF(btrim(COALESCE(v_node->>'id_column', '')), ''), 'id'), '')), ''),
        NULLIF(btrim(COALESCE(v_node_result->>'id', '')), '')
      );
      IF v_node_target_id IS NULL THEN
        RAISE EXCEPTION 'related node % did not return target id on row %', COALESCE(v_node->>'node_key', '?'), v_row.row_number;
      END IF;
    END IF;

    IF v_primary_payload ? v_reference_field
       AND NULLIF(btrim(COALESCE(v_primary_payload->>v_reference_field, '')), '') IS NOT NULL
       AND NULLIF(btrim(COALESCE(v_primary_payload->>v_reference_field, '')), '') IS DISTINCT FROM v_node_target_id THEN
      RAISE EXCEPTION 'related node % resolved % but primary payload already contains conflicting %',
        COALESCE(v_node->>'node_key', '?'),
        v_node_target_id,
        v_primary_payload->>v_reference_field;
    END IF;

    v_primary_payload := jsonb_set(v_primary_payload, ARRAY[v_reference_field], to_jsonb(v_node_target_id), TRUE);
    v_related_nodes := v_related_nodes || jsonb_build_array(
      jsonb_strip_nulls(
        v_node ||
        jsonb_build_object(
          'execution_status', 'succeeded',
          'target_record_id', v_node_target_id,
          'processed_at', to_jsonb(now()),
          'result', v_node_result
        )
      )
    );
  END LOOP;

  v_primary_result := public.tabular_import_write_row_v1(
    v_relation,
    v_id_column,
    v_primary_payload,
    CASE WHEN v_row.action = 'update' THEN v_row.target_record_id ELSE NULL END
  );
  v_primary_target_id := COALESCE(
    NULLIF(btrim(COALESCE(v_primary_result->>v_id_column, '')), ''),
    NULLIF(btrim(COALESCE(v_row.target_record_id, '')), '')
  );

  RETURN jsonb_build_object(
    'mapped_row', v_primary_payload,
    'target_record_id', v_primary_target_id,
    'primary_result', v_primary_result,
    'related_nodes', COALESCE(v_related_nodes, '[]'::jsonb)
  );
END;
$function$;

-------------------------------------------------------------------------------
-- 3) Prepare wrapper / worker / read API
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.tabular_import_prepare_v1(
  p_payload JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_payload JSONB := COALESCE(p_payload, '{}'::jsonb);
  v_original_headers JSONB := COALESCE(v_payload->'headers', '[]'::jsonb);
  v_candidate_rules JSONB := COALESCE(v_payload->'rules', '[]'::jsonb);
  v_selected_rules JSONB := '[]'::jsonb;
  v_profile_match JSONB := NULL;
  v_rule_source TEXT := lower(COALESCE(NULLIF(btrim(COALESCE(v_payload->>'rule_source', '')), ''), 'auto'));
  v_effective_rule_source TEXT := CASE WHEN v_rule_source = 'manual' THEN 'manual' ELSE 'auto' END;
  v_resource_key TEXT := NULLIF(btrim(COALESCE(v_payload->>'resource_key', '')), '');
  v_header_fingerprint TEXT := NULLIF(btrim(COALESCE(v_payload->>'header_fingerprint', '')), '');
  v_scope_resolution JSONB := public.ui_resolve_import_scope_context_v1(v_payload);
  v_row_override_count INT := 0;
  v_registry JSONB;
  v_resource JSONB;
  v_node_contracts JSONB := '[]'::jsonb;
  v_materialized_payload JSONB;
  v_primary_rules JSONB := '[]'::jsonb;
  v_node_rules JSONB := '[]'::jsonb;
  v_rule JSONB;
  v_parse JSONB;
  v_base_result JSONB;
  v_run_id UUID;
  v_run_preview JSONB;
BEGIN
  IF jsonb_typeof(v_candidate_rules) = 'array' AND jsonb_array_length(v_candidate_rules) > 0 THEN
    v_selected_rules := v_candidate_rules;
  END IF;

  IF v_rule_source <> 'manual' AND v_resource_key IS NOT NULL THEN
    IF v_header_fingerprint IS NULL THEN
      SELECT string_agg(normalized_header, '|' ORDER BY normalized_header)
        INTO v_header_fingerprint
        FROM (
          SELECT regexp_replace(lower(btrim(value)), '[^a-z0-9]+', '_', 'g') AS normalized_header
          FROM jsonb_array_elements_text(COALESCE(v_original_headers, '[]'::jsonb)) AS value
          WHERE NULLIF(btrim(value), '') IS NOT NULL
        ) normalized;
    END IF;

    SELECT value
      INTO v_profile_match
      FROM (
        SELECT jsonb_build_object(
          'id', profile.id,
          'profile_name', profile.profile_name,
          'profile_slug', profile.profile_slug,
          'header_fingerprint', profile.header_fingerprint,
          'sheet_hint', profile.sheet_hint,
          'write_mode', profile.write_mode,
          'mapping_key', profile.mapping_key,
          'mapping_config', profile.mapping_config,
          'created_at', profile.created_at,
          'updated_at', profile.updated_at
        ) AS value
        FROM public.ui_tabular_import_profiles_v1(
          v_resource_key,
          COALESCE(v_scope_resolution->'scope_context', '{}'::jsonb)
        ) AS profile
      ) profiles
     WHERE COALESCE(value->>'header_fingerprint', '') = COALESCE(v_header_fingerprint, '')
     ORDER BY COALESCE(value->>'updated_at', value->>'created_at', '') DESC
     LIMIT 1;

    IF v_profile_match IS NOT NULL
       AND jsonb_typeof(v_profile_match#>'{mapping_config,field_rules}') = 'array'
       AND jsonb_array_length(v_profile_match#>'{mapping_config,field_rules}') > 0 THEN
      v_selected_rules := COALESCE(v_profile_match#>'{mapping_config,field_rules}', '[]'::jsonb);
      v_effective_rule_source := 'profile';
    END IF;
  END IF;

  IF jsonb_typeof(v_selected_rules) IS DISTINCT FROM 'array' THEN
    v_selected_rules := '[]'::jsonb;
  END IF;

  IF jsonb_typeof(v_payload->'row_overrides') = 'object' THEN
    SELECT count(*)
      INTO v_row_override_count
      FROM jsonb_each(v_payload->'row_overrides') AS row_entry(row_key, row_value)
      CROSS JOIN LATERAL jsonb_each(
        CASE
          WHEN jsonb_typeof(row_entry.row_value) = 'object' THEN row_entry.row_value
          ELSE '{}'::jsonb
        END
      ) AS field_entry(key, value);
  END IF;

  v_payload := jsonb_set(v_payload, '{rules}', v_selected_rules, TRUE);
  v_payload := jsonb_set(
    v_payload,
    '{scope_context}',
    COALESCE(v_scope_resolution->'scope_context', '{}'::jsonb),
    TRUE
  );
  IF v_header_fingerprint IS NOT NULL THEN
    v_payload := jsonb_set(v_payload, '{header_fingerprint}', to_jsonb(v_header_fingerprint), TRUE);
  END IF;

  v_registry := public.ui_read_registry_v1();
  v_resource := public.tabular_import_resolve_resource_v1(v_resource_key);
  v_node_contracts := public.tabular_import_resolve_inline_node_contracts_v1(v_resource, v_registry);

  v_materialized_payload := public.tabular_import_materialize_row_overrides_v1(
    public.tabular_import_materialize_fixed_rules_v1(v_payload)
  );

  IF jsonb_typeof(v_materialized_payload->'rules') = 'array' THEN
    FOR v_rule IN
      SELECT value
      FROM jsonb_array_elements(v_materialized_payload->'rules') AS value
    LOOP
      v_parse := public.tabular_import_parse_target_field_v1(v_rule->>'target_field');
      IF COALESCE((v_parse->>'is_related')::boolean, FALSE) IS TRUE THEN
        v_node_rules := v_node_rules || jsonb_build_array(v_rule);
      ELSE
        v_primary_rules := v_primary_rules || jsonb_build_array(v_rule);
      END IF;
    END LOOP;
  END IF;

  v_materialized_payload := jsonb_set(v_materialized_payload, '{rules}', COALESCE(v_primary_rules, '[]'::jsonb), TRUE);
  v_base_result := public.tabular_import_prepare_base_v1(v_materialized_payload);
  v_run_id := public.mapping_studio_try_uuid_v1(v_base_result->>'run_id');

  IF v_run_id IS NOT NULL THEN
    UPDATE public.tabular_import_runs
       SET summary = jsonb_strip_nulls(
             COALESCE(summary, '{}'::jsonb) || jsonb_build_object(
               'headers', COALESCE(v_original_headers, '[]'::jsonb),
               'resolved_rules', COALESCE(v_selected_rules, '[]'::jsonb),
               'rule_source', v_effective_rule_SOURCE,
               'row_override_count', v_row_override_count,
               'scope_context', COALESCE(v_scope_resolution->'scope_context', '{}'::jsonb),
               'available_related_nodes', COALESCE(v_node_contracts, '[]'::jsonb),
               'related_node_rules', COALESCE(v_node_rules, '[]'::jsonb),
               'profile_match', v_profile_match
             )
           ),
           updated_at = now()
     WHERE id = v_run_id;

    PERFORM public.tabular_import_stage_related_nodes_v1(
      v_run_id,
      COALESCE(v_node_contracts, '[]'::jsonb),
      COALESCE(v_node_rules, '[]'::jsonb)
    );

    SELECT public.ui_get_tabular_import_run_v1(v_run_id)
      INTO v_run_preview;

    RETURN jsonb_build_object(
      'run_id', v_run_preview->>'id',
      'resource', v_run_preview->>'resource_key',
      'write_mode', v_run_preview->>'write_mode',
      'source_format', v_run_preview->>'source_format',
      'source_file_name', v_run_preview->>'source_file_name',
      'header_fingerprint', v_run_preview->>'header_fingerprint',
      'sheet_name', v_run_preview->>'sheet_name',
      'unmatched_headers', COALESCE(v_run_preview#>'{summary,unmatched_headers}', '[]'::jsonb),
      'unresolved_targets', COALESCE(v_run_preview#>'{summary,unresolved_targets}', '[]'::jsonb),
      'total_rows', COALESCE((v_run_preview->>'total_rows')::int, 0),
      'will_create', COALESCE((v_run_preview->>'will_create')::int, 0),
      'will_update', COALESCE((v_run_preview->>'will_update')::int, 0),
      'will_skip', COALESCE((v_run_preview->>'will_skip')::int, 0),
      'blocked_count', COALESCE((v_run_preview->>'blocked_count')::int, 0),
      'warning_count', COALESCE((v_run_preview->>'warning_count')::int, 0),
      'automatic_corrections', COALESCE(v_run_preview#>'{summary,automatic_corrections}', '[]'::jsonb),
      'blocking_diagnostics', COALESCE(v_run_preview#>'{summary,blocking_diagnostics}', '[]'::jsonb),
      'warning_diagnostics', COALESCE(v_run_preview#>'{summary,warning_diagnostics}', '[]'::jsonb),
      'rows', COALESCE(v_run_preview->'rows', '[]'::jsonb),
      'profile', v_run_preview#>'{summary,profile_match}',
      'available_profiles', COALESCE(v_run_preview#>'{summary,available_profiles}', '[]'::jsonb),
      'resolved_rules', COALESCE(v_selected_rules, '[]'::jsonb),
      'related_nodes', COALESCE(v_run_preview#>'{summary,related_node_summary}', '[]'::jsonb),
      'available_related_nodes', COALESCE(v_run_preview#>'{summary,available_related_nodes}', '[]'::jsonb)
    );
  END IF;

  RETURN v_base_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.process_tabular_import_run_v1(
  p_run_id UUID,
  p_batch_size INT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_claims JSONB := NULL;
  v_role TEXT := NULL;
  v_run public.tabular_import_runs%ROWTYPE;
  v_policy_row RECORD;
  v_policy JSONB := '{}'::jsonb;
  v_batch_size INT := p_batch_size;
  v_row public.tabular_import_run_rows%ROWTYPE;
  v_result JSONB;
  v_remaining INT := 0;
  v_created_count INT := 0;
  v_updated_count INT := 0;
  v_skipped_count INT := 0;
  v_failed_count INT := 0;
  v_blocked_count INT := 0;
  v_final_status TEXT := 'processing';
BEGIN
  BEGIN
    v_claims := current_setting('request.jwt.claims', true)::jsonb;
  EXCEPTION
    WHEN OTHERS THEN
      v_claims := NULL;
  END;
  v_role := NULLIF(btrim(COALESCE(v_claims->>'role', '')), '');

  IF COALESCE(v_role, '') NOT IN ('service_role', 'supabase_admin') AND current_user <> 'postgres' THEN
    RAISE EXCEPTION 'process_tabular_import_run_v1 requires service role context'
      USING ERRCODE = '42501';
  END IF;
  IF p_run_id IS NULL THEN
    RAISE EXCEPTION 'process_tabular_import_run_v1 requires run id';
  END IF;

  SELECT *
    INTO v_run
    FROM public.tabular_import_runs
   WHERE id = p_run_id
   FOR UPDATE;

  IF v_run.id IS NULL THEN
    RAISE EXCEPTION 'process_tabular_import_run_v1 run % not found', p_run_id;
  END IF;
  IF v_run.status IN ('completed', 'completed_with_errors', 'failed', 'canceled') THEN
    RETURN public.ui_get_tabular_import_run_v1(v_run.id);
  END IF;

  SELECT *
    INTO v_policy_row
    FROM public.resolve_tabular_import_policy_v1(
      jsonb_strip_nulls(
        jsonb_build_object(
          'organization_id', v_run.organization_id,
          'client_id', v_run.client_id,
          'sender_id', v_run.sender_id,
          'resource_key', v_run.resource_key
        )
      )
    )
   LIMIT 1;
  v_policy := COALESCE(v_policy_row.value, '{}'::jsonb);

  BEGIN
    v_batch_size := COALESCE(v_batch_size, NULLIF(v_policy->>'worker_batch_size', '')::int, 200);
  EXCEPTION
    WHEN OTHERS THEN
      v_batch_size := COALESCE(v_batch_size, 200);
  END;
  IF v_batch_size < 1 THEN
    v_batch_size := 1;
  END IF;

  UPDATE public.tabular_import_runs
     SET status = 'processing',
         started_at = COALESCE(started_at, now()),
         updated_at = now()
   WHERE id = v_run.id;

  FOR v_row IN
    SELECT *
    FROM public.tabular_import_run_rows
    WHERE run_id = v_run.id
      AND action IN ('create', 'update')
      AND execution_status = 'queued'
    ORDER BY row_number ASC
    LIMIT v_batch_size
    FOR UPDATE SKIP LOCKED
  LOOP
    BEGIN
      v_result := public.tabular_import_execute_row_graph_v1(v_run.id, v_row.id);

      UPDATE public.tabular_import_run_rows
         SET execution_status = 'succeeded',
             processed_at = now(),
             mapped_row = COALESCE(v_result->'mapped_row', mapped_row),
             target_record_id = NULLIF(btrim(COALESCE(v_result->>'target_record_id', '')), ''),
             metadata = jsonb_strip_nulls(
               COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                 'related_nodes', COALESCE(v_result->'related_nodes', '[]'::jsonb),
                 'primary_result', COALESCE(v_result->'primary_result', '{}'::jsonb)
               )
             ),
             updated_at = now()
       WHERE id = v_row.id;
    EXCEPTION
      WHEN OTHERS THEN
        UPDATE public.tabular_import_run_rows
           SET action = 'failed',
               execution_status = 'failed',
               processed_at = now(),
               diagnostics = COALESCE(diagnostics, '[]'::jsonb) || jsonb_build_array(
                 jsonb_build_object(
                   'level', 'error',
                   'blocking', TRUE,
                   'code', 'execution_failed',
                   'message', format('Row %s failed during execution.', v_row.row_number),
                   'why', SQLERRM,
                   'recommended_fix', 'Review the row error export or fix the staged related-node/primary payload before retrying.'
                 )
               ),
               reason_codes = COALESCE(reason_codes, '[]'::jsonb) || jsonb_build_array('execution_failed'),
               reason_messages = COALESCE(reason_messages, '[]'::jsonb) || jsonb_build_array(SQLERRM),
               metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('execution_error', SQLERRM),
               updated_at = now()
         WHERE id = v_row.id;
    END;
  END LOOP;

  PERFORM public.tabular_import_refresh_run_rollups_v1(v_run.id);

  SELECT count(*)
    INTO v_remaining
    FROM public.tabular_import_run_rows
   WHERE run_id = v_run.id
     AND action IN ('create', 'update')
     AND execution_status = 'queued';

  SELECT
    count(*) FILTER (WHERE action = 'create' AND execution_status = 'succeeded'),
    count(*) FILTER (WHERE action = 'update' AND execution_status = 'succeeded'),
    count(*) FILTER (WHERE action = 'skip' OR execution_status = 'skipped'),
    count(*) FILTER (WHERE action = 'failed' OR execution_status = 'failed'),
    count(*) FILTER (WHERE action = 'block' OR execution_status = 'blocked')
  INTO
    v_created_count,
    v_updated_count,
    v_skipped_count,
    v_failed_count,
    v_blocked_count
  FROM public.tabular_import_run_rows
  WHERE run_id = v_run.id;

  IF v_remaining > 0 THEN
    v_final_status := 'processing';
  ELSIF v_failed_count > 0 OR v_blocked_count > 0 OR v_skipped_count > 0 THEN
    v_final_status := 'completed_with_errors';
  ELSE
    v_final_status := 'completed';
  END IF;

  UPDATE public.tabular_import_runs
     SET status = v_final_status,
         created_count = v_created_count,
         updated_count = v_updated_count,
         skipped_count = v_skipped_count,
         failed_count = v_failed_count,
         blocked_count = v_blocked_count,
         completed_at = CASE WHEN v_remaining = 0 THEN now() ELSE completed_at END,
         updated_at = now()
   WHERE id = v_run.id;

  IF v_remaining = 0 AND v_run.task_id IS NOT NULL THEN
    PERFORM public.tabular_import_transition_task_system_v1(
      v_run.task_id,
      'completed',
      CASE WHEN v_final_status = 'completed_with_errors' THEN 'completed_with_errors' ELSE 'completed' END,
      jsonb_build_object(
        'run_id', v_run.id,
        'status', v_final_status,
        'created_count', v_created_count,
        'updated_count', v_updated_count,
        'skipped_count', v_skipped_count,
        'failed_count', v_failed_count,
        'blocked_count', v_blocked_count
      ),
      'tabular_import_worker'
    );
  END IF;

  RETURN public.ui_get_tabular_import_run_v1(v_run.id);
EXCEPTION
  WHEN OTHERS THEN
    IF v_run.id IS NOT NULL THEN
      UPDATE public.tabular_import_runs
         SET status = 'failed',
             completed_at = now(),
             updated_at = now(),
             summary = COALESCE(summary, '{}'::jsonb) || jsonb_build_object('fatal_error', SQLERRM)
       WHERE id = v_run.id;

      IF v_run.task_id IS NOT NULL THEN
        PERFORM public.tabular_import_transition_task_system_v1(
          v_run.task_id,
          'failed',
          'tabular_import_failed',
          jsonb_build_object('run_id', v_run.id, 'error', SQLERRM),
          'tabular_import_worker'
        );
      END IF;
    END IF;

    RETURN jsonb_build_object(
      'run_id', p_run_id,
      'status', 'failed',
      'error', SQLERRM
    );
END;
$function$;

CREATE OR REPLACE FUNCTION public.ui_get_tabular_import_run_v1(
  p_run_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_run public.tabular_import_runs%ROWTYPE;
  v_resource JSONB;
  v_capability TEXT;
  v_artifacts JSONB := '[]'::jsonb;
  v_rows JSONB := '[]'::jsonb;
  v_report JSONB := NULL;
BEGIN
  IF p_run_id IS NULL THEN
    RAISE EXCEPTION 'ui_get_tabular_import_run_v1 requires run id';
  END IF;

  SELECT *
    INTO v_run
    FROM public.tabular_import_runs
   WHERE id = p_run_id;

  IF v_run.id IS NULL THEN
    RAISE EXCEPTION 'ui_get_tabular_import_run_v1 run % not found', p_run_id;
  END IF;

  IF NOT public.is_platform_user()
     AND v_run.organization_id IS DISTINCT FROM public.current_user_org_id() THEN
    RAISE EXCEPTION 'ui_get_tabular_import_run_v1 cannot read another organization';
  END IF;

  v_resource := public.tabular_import_resolve_resource_v1(v_run.resource_key);
  v_capability := COALESCE(
    NULLIF(btrim(COALESCE(v_resource#>>ARRAY['import','capability'], '')), ''),
    NULLIF(btrim(COALESCE(v_resource->>'capability_write', '')), ''),
    NULLIF(btrim(COALESCE(v_resource->>'capability_read', '')), ''),
    'system.write'
  );
  PERFORM public.assert_capability_v1(v_capability, 'tenant', v_run.organization_id);

  SELECT COALESCE(
    jsonb_agg(
      jsonb_strip_nulls(
        jsonb_build_object(
          'artifact_id', a.id,
          'relation_type', link.relation_type,
          'storage_bucket', a.storage_bucket,
          'storage_key', a.storage_key,
          'mime_type', a.mime_type,
          'file_name', COALESCE(NULLIF(btrim(COALESCE(a.metadata->>'file_name', '')), ''), split_part(a.storage_key, '/', array_length(string_to_array(a.storage_key, '/'), 1))),
          'metadata', a.metadata
        )
      )
      ORDER BY link.created_at ASC
    ),
    '[]'::jsonb
  )
    INTO v_artifacts
    FROM public.artifact_links link
    JOIN public.artifacts a ON a.id = link.artifact_id
   WHERE link.organization_id = v_run.organization_id
     AND link.resource_type = 'tabular_import_runs'
     AND link.resource_id = v_run.id;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_strip_nulls(
        jsonb_build_object(
          'row_number', row_number,
          'execution_status', execution_status,
          'action', action,
          'diagnostics', diagnostics,
          'coercions', coercions,
          'original_row', original_row,
          'mapped_row', mapped_row,
          'target_record_id', target_record_id,
          'reason_codes', reason_codes,
          'reason_messages', reason_messages,
          'related_nodes', COALESCE(metadata->'related_nodes', '[]'::jsonb)
        )
      )
      ORDER BY row_number ASC
    ),
    '[]'::jsonb
  )
    INTO v_rows
    FROM (
      SELECT *
      FROM public.tabular_import_run_rows
      WHERE run_id = v_run.id
      ORDER BY row_number ASC
      LIMIT 25
    ) sample_rows;

  IF v_run.report_id IS NOT NULL THEN
    SELECT to_jsonb(r.*)
      INTO v_report
      FROM public.mapping_operation_reports r
     WHERE r.id = v_run.report_id;
  END IF;

  RETURN jsonb_strip_nulls(
    to_jsonb(v_run) || jsonb_build_object(
      'artifacts', COALESCE(v_artifacts, '[]'::jsonb),
      'rows', COALESCE(v_rows, '[]'::jsonb),
      'report', v_report
    )
  );
END;
$function$;

COMMENT ON FUNCTION public.tabular_import_parse_target_field_v1(TEXT) IS
  'Parse a target field into primary or related-node parts for the generic import graph.';
COMMENT ON FUNCTION public.tabular_import_resolve_inline_node_contract_v1(JSONB, TEXT) IS
  'Resolve one inline related-node contract by node key.';
COMMENT ON FUNCTION public.tabular_import_apply_scope_defaults_v1(JSONB, JSONB, UUID, UUID, UUID) IS
  'Apply organization/client/sender defaults to a staged payload using scope_columns metadata.';
COMMENT ON FUNCTION public.tabular_import_resolve_inline_node_contracts_v1(JSONB, JSONB) IS
  'Resolve allowed inline related-node contracts for a primary resource from ui_read_registry import/reference metadata.';
COMMENT ON FUNCTION public.tabular_import_refresh_run_rollups_v1(UUID) IS
  'Refresh canonical tabular import run counters and summary previews from the staged row ledger, including related-node rollups.';
COMMENT ON FUNCTION public.tabular_import_stage_related_nodes_v1(UUID, JSONB, JSONB) IS
  'Stage related-node payloads, diagnostics, create/link plans, and per-row graph preview metadata for a prepared tabular import run.';
COMMENT ON FUNCTION public.tabular_import_execute_row_graph_v1(UUID, UUID) IS
  'Execute related-node create/link steps for one staged row, then write the primary row and return the resolved graph result.';

REVOKE ALL ON FUNCTION public.tabular_import_parse_target_field_v1(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tabular_import_parse_target_field_v1(TEXT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.tabular_import_resolve_inline_node_contract_v1(JSONB, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tabular_import_resolve_inline_node_contract_v1(JSONB, TEXT) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.tabular_import_apply_scope_defaults_v1(JSONB, JSONB, UUID, UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tabular_import_apply_scope_defaults_v1(JSONB, JSONB, UUID, UUID, UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.tabular_import_resolve_inline_node_contracts_v1(JSONB, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tabular_import_resolve_inline_node_contracts_v1(JSONB, JSONB) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.tabular_import_refresh_run_rollups_v1(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tabular_import_refresh_run_rollups_v1(UUID) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.tabular_import_stage_related_nodes_v1(UUID, JSONB, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tabular_import_stage_related_nodes_v1(UUID, JSONB, JSONB) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.tabular_import_execute_row_graph_v1(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tabular_import_execute_row_graph_v1(UUID, UUID) TO service_role;

REVOKE ALL ON FUNCTION public.tabular_import_prepare_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tabular_import_prepare_v1(JSONB) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.process_tabular_import_run_v1(UUID, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.process_tabular_import_run_v1(UUID, INT) TO service_role;

REVOKE ALL ON FUNCTION public.ui_get_tabular_import_run_v1(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_get_tabular_import_run_v1(UUID) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202603111100_tabular_import_related_node_graph_v1'));

COMMIT;
