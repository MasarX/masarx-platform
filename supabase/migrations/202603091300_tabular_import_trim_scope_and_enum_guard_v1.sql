-- Plan: PLAN-202603-shared-mapping-studio / Step: S05
-- Migration: Align tabular import dry-run coercion with live execution needs
--
-- Purpose:
--   - Persist trimmed text values through the authoritative SQL coercion path.
--   - Block missing scope-bound columns when the current import context cannot
--     auto-inject them.
--   - Add recipients import enum guidance so preferred language is validated
--     before execution and surfaced during dry-run review.

BEGIN;

SELECT pg_advisory_lock(hashtext('202603091300_tabular_import_trim_scope_and_enum_guard_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.tabular_import_coerce_value_v1(
  p_value JSONB,
  p_column JSONB,
  p_source_column TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  v_value JSONB := COALESCE(p_value, 'null'::jsonb);
  v_prepared_value JSONB := v_value;
  v_column JSONB := COALESCE(p_column, '{}'::jsonb);
  v_import JSONB := COALESCE(v_column->'import', '{}'::jsonb);
  v_target_type TEXT := public.tabular_import_resolve_column_type_v1(v_column);
  v_original_type TEXT := COALESCE(jsonb_typeof(v_value), 'null');
  v_source_path TEXT := format('column:%s', COALESCE(NULLIF(p_source_column, ''), 'source'));
  v_text TEXT := NULL;
  v_trimmed TEXT := NULL;
  v_required BOOLEAN := FALSE;
  v_numeric NUMERIC;
  v_bigint BIGINT;
  v_bool BOOLEAN;
  v_enum_value TEXT;
  v_date DATE;
  v_timestamp TIMESTAMPTZ;
  v_result JSONB := jsonb_build_object('value', v_prepared_value);
  v_diagnostics JSONB := '[]'::jsonb;
  v_trim_coercion JSONB := NULL;
BEGIN
  BEGIN
    v_required := COALESCE(NULLIF(v_import->>'required', '')::boolean, FALSE);
  EXCEPTION
    WHEN OTHERS THEN
      v_required := FALSE;
  END;

  IF v_original_type = 'null' THEN
    RETURN v_result;
  END IF;

  IF v_original_type = 'string' THEN
    v_text := v_value #>> '{}';
    v_trimmed := btrim(COALESCE(v_text, ''));

    IF v_trimmed = '' AND NOT v_required THEN
      RETURN jsonb_build_object(
        'value', 'null'::jsonb,
        'coercion', jsonb_build_object(
          'target_field', v_column->>'key',
          'source_path', v_source_path,
          'original_type', v_original_type,
          'original_value', v_value,
          'converted_type', 'null',
          'converted_value', 'null'::jsonb,
          'reason', 'Blank text normalized to null for an optional field.',
          'can_override', TRUE
        )
      );
    END IF;

    IF v_trimmed IS DISTINCT FROM COALESCE(v_text, '') THEN
      v_prepared_value := to_jsonb(v_trimmed);
      v_trim_coercion := jsonb_build_object(
        'target_field', v_column->>'key',
        'source_path', v_source_path,
        'original_type', v_original_type,
        'original_value', v_value,
        'converted_type', 'string',
        'converted_value', to_jsonb(v_trimmed),
        'reason', 'Trimmed surrounding whitespace to match the target field format.',
        'can_override', TRUE
      );
    END IF;

    IF jsonb_typeof(v_import->'enum_values') = 'array' THEN
      SELECT enum_value
        INTO v_enum_value
        FROM (
          SELECT jsonb_array_elements_text(v_import->'enum_values') AS enum_value
        ) valueset
       WHERE public.tabular_import_slug_v1(enum_value) = public.tabular_import_slug_v1(v_trimmed)
       LIMIT 1;

      IF v_enum_value IS NOT NULL AND v_enum_value <> v_trimmed THEN
        RETURN jsonb_build_object(
          'value', to_jsonb(v_enum_value),
          'coercion', jsonb_build_object(
            'target_field', v_column->>'key',
            'source_path', v_source_path,
            'original_type', v_original_type,
            'original_value', v_value,
            'converted_type', 'string',
            'converted_value', to_jsonb(v_enum_value),
            'reason', 'Matched the input to a configured enum value.',
            'can_override', TRUE
          )
        );
      ELSIF v_enum_value IS NULL THEN
        v_diagnostics := v_diagnostics || jsonb_build_array(
          jsonb_build_object(
            'level', 'error',
            'blocking', TRUE,
            'code', 'enum_value_invalid',
            'fieldPath', v_column->>'key',
            'message', format(
              '%s must match one of the configured values.',
              COALESCE(NULLIF(v_column->>'label', ''), v_column->>'key')
            ),
            'why', format(
              'The source value "%s" does not match the configured import values for this field.',
              COALESCE(v_trimmed, '')
            ),
            'recommended_fix', format(
              'Use one of: %s.',
              COALESCE(
                (
                  SELECT string_agg(enum_value, ', ' ORDER BY enum_value)
                    FROM jsonb_array_elements_text(v_import->'enum_values') AS enum_value
                ),
                'the configured allowed values'
              )
            )
          )
        );
      END IF;
    END IF;

    IF v_target_type IN ('integer', 'number') THEN
      BEGIN
        v_numeric := replace(v_trimmed, ',', '')::numeric;
        IF v_target_type = 'integer' THEN
          v_bigint := v_numeric::bigint;
          IF v_numeric = v_bigint THEN
            RETURN jsonb_build_object(
              'value', to_jsonb(v_bigint),
              'coercion', jsonb_build_object(
                'target_field', v_column->>'key',
                'source_path', v_source_path,
                'original_type', v_original_type,
                'original_value', v_value,
                'converted_type', 'integer',
                'converted_value', to_jsonb(v_bigint),
                'reason', 'String value converted to an integer to match the target column type.',
                'can_override', TRUE
              )
            );
          END IF;
        ELSE
          RETURN jsonb_build_object(
            'value', to_jsonb(v_numeric),
            'coercion', jsonb_build_object(
              'target_field', v_column->>'key',
              'source_path', v_source_path,
              'original_type', v_original_type,
              'original_value', v_value,
              'converted_type', 'number',
              'converted_value', to_jsonb(v_numeric),
              'reason', 'String value converted to a number to match the target column type.',
              'can_override', TRUE
            )
          );
        END IF;
      EXCEPTION
        WHEN OTHERS THEN
          NULL;
      END;
    END IF;

    IF v_target_type = 'boolean' THEN
      IF lower(v_trimmed) IN ('true', '1', 'yes', 'y') THEN
        v_bool := TRUE;
      ELSIF lower(v_trimmed) IN ('false', '0', 'no', 'n') THEN
        v_bool := FALSE;
      ELSE
        v_bool := NULL;
      END IF;

      IF v_bool IS NOT NULL THEN
        RETURN jsonb_build_object(
          'value', to_jsonb(v_bool),
          'coercion', jsonb_build_object(
            'target_field', v_column->>'key',
            'source_path', v_source_path,
            'original_type', v_original_type,
            'original_value', v_value,
            'converted_type', 'boolean',
            'converted_value', to_jsonb(v_bool),
            'reason', 'String value converted to a boolean to match the target column type.',
            'can_override', TRUE
          )
        );
      END IF;
    END IF;

    IF v_target_type IN ('date', 'datetime') THEN
      BEGIN
        IF v_target_type = 'date' THEN
          v_date := v_trimmed::date;
          RETURN jsonb_build_object(
            'value', to_jsonb(v_date::text),
            'coercion', jsonb_build_object(
              'target_field', v_column->>'key',
              'source_path', v_source_path,
              'original_type', v_original_type,
              'original_value', v_value,
              'converted_type', 'date',
              'converted_value', to_jsonb(v_date::text),
              'reason', 'String value normalized into date format.',
              'can_override', TRUE
            )
          );
        ELSE
          v_timestamp := v_trimmed::timestamptz;
          RETURN jsonb_build_object(
            'value', to_jsonb(to_char(v_timestamp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
            'coercion', jsonb_build_object(
              'target_field', v_column->>'key',
              'source_path', v_source_path,
              'original_type', v_original_type,
              'original_value', v_value,
              'converted_type', 'datetime',
              'converted_value', to_jsonb(to_char(v_timestamp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
              'reason', 'String value normalized into datetime format.',
              'can_override', TRUE
            )
          );
        END IF;
      EXCEPTION
        WHEN OTHERS THEN
          NULL;
      END;
    END IF;

    IF v_target_type = 'json' THEN
      BEGIN
        RETURN jsonb_build_object(
          'value', v_trimmed::jsonb,
          'coercion', jsonb_build_object(
            'target_field', v_column->>'key',
            'source_path', v_source_path,
            'original_type', v_original_type,
            'original_value', v_value,
            'converted_type', 'json',
            'converted_value', v_trimmed::jsonb,
            'reason', 'JSON text parsed into structured JSON for the target column.',
            'can_override', TRUE
          )
        );
      EXCEPTION
        WHEN OTHERS THEN
          v_diagnostics := v_diagnostics || jsonb_build_array(
            jsonb_build_object(
              'level', 'warning',
              'blocking', FALSE,
              'code', 'json_parse_failed',
              'fieldPath', v_column->>'key',
              'message', format('Could not parse %s as JSON.', COALESCE(v_column->>'label', v_column->>'key')),
              'why', 'The cell contains text that is not valid JSON.',
              'recommended_fix', 'Provide valid JSON text or map this column to a text field instead.'
            )
          );
      END;
    END IF;
  END IF;

  IF v_target_type = 'array' AND v_original_type <> 'array' THEN
    RETURN jsonb_build_object(
      'value', jsonb_build_array(v_prepared_value),
      'coercion', jsonb_build_object(
        'target_field', v_column->>'key',
        'source_path', v_source_path,
        'original_type', v_original_type,
        'original_value', v_value,
        'converted_type', 'array',
        'converted_value', jsonb_build_array(v_prepared_value),
        'reason', 'Singleton value wrapped into an array because the target column expects multiple values.',
        'can_override', TRUE
      )
    );
  END IF;

  v_result := jsonb_build_object('value', v_prepared_value);

  IF jsonb_array_length(v_diagnostics) > 0 THEN
    v_result := jsonb_set(v_result, '{diagnostics}', v_diagnostics, TRUE);
  END IF;

  IF v_trim_coercion IS NOT NULL THEN
    v_result := jsonb_set(v_result, '{coercion}', v_trim_coercion, TRUE);
  END IF;

  RETURN v_result;
END;
$function$;

-- normalize_ui_read_registry_import_v1 and tabular_import_prepare_v1 are
-- redefined below to keep recipient import metadata and dry-run requirements
-- aligned with the new coercion behavior.

CREATE OR REPLACE FUNCTION public.normalize_ui_read_registry_import_v1(
  p_value JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_current JSONB := COALESCE(p_value, '{}'::jsonb);
  v_resources JSONB := COALESCE(v_current->'resources', '[]'::jsonb);
  v_updated_resources JSONB := '[]'::jsonb;
  v_resource JSONB;
  v_columns JSONB;
  v_updated_columns JSONB;
  v_column JSONB;
  v_import JSONB;
  v_column_import JSONB;
  v_enabled BOOLEAN;
  v_aliases JSONB;
  v_coercions JSONB;
  v_enum_values JSONB;
  v_resource_key TEXT;
  v_relation TEXT;
  v_scope_columns JSONB;
  v_has_write BOOLEAN;
  v_select JSONB;
  v_filters JSONB;
  v_formats JSONB;
  v_identity_columns JSONB;
  v_existing JSONB;
  v_tabular_runs_def JSONB := jsonb_build_object(
    'key', 'tabular_import_runs',
    'label', 'Import runs',
    'relation', 'public.tabular_import_runs',
    'id_column', 'id',
    'scope_columns', jsonb_build_object(
      'tenant', 'organization_id',
      'client', 'client_id',
      'sender', 'sender_id'
    ),
    'capability_read', 'mappings.read',
    'capability_write', 'mappings.write',
    'import', jsonb_build_object(
      'enabled', FALSE,
      'capability', 'mappings.write',
      'default_write_mode', 'create',
      'allow_upsert', FALSE,
      'identity_columns', '[]'::jsonb,
      'accepted_formats', jsonb_build_array('csv', 'xls', 'xlsx'),
      'disabled_reason', 'Import history is generated by the universal import flow.'
    ),
    'select', jsonb_build_array(
      'id','organization_id','client_id','sender_id','resource_key','relation_name','write_mode','status','profile_name',
      'header_fingerprint','sheet_name','source_format','source_file_name','source_artifact_id','error_artifact_id',
      'report_id','task_id','total_rows','will_create','will_update','will_skip','blocked_count','warning_count',
      'created_count','updated_count','skipped_count','failed_count','started_at','completed_at','created_at','updated_at'
    ),
    'filters', jsonb_build_array(
      jsonb_build_object('key','resource_key','column','resource_key','op','eq'),
      jsonb_build_object('key','status','column','status','op','eq'),
      jsonb_build_object('key','profile_name','column','profile_name','op','ilike'),
      jsonb_build_object('key','source_format','column','source_format','op','eq'),
      jsonb_build_object('key','report_id','column','report_id','op','eq')
    ),
    'default_sort', jsonb_build_object('column','created_at','direction','desc')
  );
BEGIN
  IF jsonb_typeof(v_resources) IS DISTINCT FROM 'array' THEN
    RETURN v_current;
  END IF;

  FOR v_resource IN SELECT value FROM jsonb_array_elements(v_resources) AS value LOOP
    v_resource_key := COALESCE(v_resource->>'key', '');
    v_relation := COALESCE(v_resource->>'relation', '');
    v_scope_columns := COALESCE(v_resource->'scope_columns', '{}'::jsonb);
    v_has_write := NULLIF(btrim(COALESCE(v_resource->>'capability_write', '')), '') IS NOT NULL;

    v_import := COALESCE(v_resource->'import', '{}'::jsonb);
    IF jsonb_typeof(v_import) IS DISTINCT FROM 'object' THEN
      v_import := '{}'::jsonb;
    END IF;

    v_formats := CASE
      WHEN jsonb_typeof(v_import->'accepted_formats') = 'array' THEN v_import->'accepted_formats'
      ELSE jsonb_build_array('csv', 'xls', 'xlsx')
    END;

    v_identity_columns := CASE
      WHEN jsonb_typeof(v_import->'identity_columns') = 'array' THEN v_import->'identity_columns'
      ELSE '[]'::jsonb
    END;

    v_enabled := COALESCE(
      NULLIF(v_import->>'enabled', '')::boolean,
      CASE
        WHEN v_resource_key IN ('mapping_operation_reports', 'tabular_import_runs') THEN FALSE
        WHEN v_relation LIKE 'public.%' AND v_has_write THEN TRUE
        ELSE FALSE
      END
    );

    IF v_resource_key = 'recipients' THEN
      v_import := jsonb_build_object(
        'enabled', TRUE,
        'capability', COALESCE(
          NULLIF(v_import->>'capability', ''),
          v_resource->>'capability_write',
          v_resource->>'capability_read'
        ),
        'default_write_mode', COALESCE(NULLIF(v_import->>'default_write_mode', ''), 'create'),
        'allow_upsert', TRUE,
        'identity_columns', jsonb_build_array('external_id'),
        'accepted_formats', v_formats
      );
    ELSE
      v_import := jsonb_strip_nulls(jsonb_build_object(
        'enabled', v_enabled,
        'capability', COALESCE(
          NULLIF(v_import->>'capability', ''),
          v_resource->>'capability_write',
          v_resource->>'capability_read'
        ),
        'default_write_mode', COALESCE(NULLIF(v_import->>'default_write_mode', ''), 'create'),
        'allow_upsert', COALESCE(NULLIF(v_import->>'allow_upsert', '')::boolean, FALSE),
        'identity_columns', v_identity_columns,
        'accepted_formats', v_formats,
        'disabled_reason', NULLIF(v_import->>'disabled_reason', '')
      ));
    END IF;

    v_columns := COALESCE(v_resource->'columns', '[]'::jsonb);
    IF jsonb_typeof(v_columns) = 'array' THEN
      v_updated_columns := '[]'::jsonb;
      FOR v_column IN SELECT value FROM jsonb_array_elements(v_columns) AS value LOOP
        v_column_import := COALESCE(v_column->'import', '{}'::jsonb);
        IF jsonb_typeof(v_column_import) IS DISTINCT FROM 'object' THEN
          v_column_import := '{}'::jsonb;
        END IF;

        v_enabled := COALESCE(
          NULLIF(v_column_import->>'enabled', '')::boolean,
          CASE
            WHEN v_scope_columns ? 'tenant' AND v_scope_columns->>'tenant' = v_column->>'key' THEN TRUE
            WHEN v_scope_columns ? 'client' AND v_scope_columns->>'client' = v_column->>'key' THEN TRUE
            WHEN v_scope_columns ? 'sender' AND v_scope_columns->>'sender' = v_column->>'key' THEN TRUE
            WHEN lower(COALESCE(v_column->>'edit_mode', '')) IN ('none', 'read') THEN FALSE
            ELSE TRUE
          END
        );

        v_aliases := COALESCE(v_column_import->'aliases', '[]'::jsonb);
        IF jsonb_typeof(v_aliases) IS DISTINCT FROM 'array' THEN
          v_aliases := '[]'::jsonb;
        END IF;

        IF NULLIF(btrim(COALESCE(v_column->>'label', '')), '') IS NOT NULL
           AND lower(COALESCE(v_column->>'label', '')) <> lower(COALESCE(v_column->>'key', '')) THEN
          v_aliases := v_aliases || jsonb_build_array(v_column->>'label');
        END IF;

        IF v_resource_key = 'recipients' AND COALESCE(v_column->>'key', '') = 'client_id' THEN
          v_aliases := v_aliases || jsonb_build_array('Client ID', 'Client');
        ELSIF v_resource_key = 'recipients' AND COALESCE(v_column->>'key', '') = 'preferred_language' THEN
          v_aliases := v_aliases || jsonb_build_array('Language', 'Language Code');
        END IF;

        SELECT COALESCE(
                 jsonb_agg(to_jsonb(dedup.value) ORDER BY dedup.first_ord),
                 '[]'::jsonb
               )
          INTO v_aliases
          FROM (
            SELECT value, MIN(ord) AS first_ord
              FROM (
                SELECT value, ord
                  FROM jsonb_array_elements_text(v_aliases) WITH ORDINALITY AS alias(value, ord)
                 WHERE NULLIF(btrim(value), '') IS NOT NULL
              ) items
             GROUP BY value
          ) dedup;

        CASE
          WHEN lower(COALESCE(v_column->>'edit_type', v_column->>'render_type', '')) LIKE '%bool%' THEN
            v_coercions := jsonb_build_array('trim', 'null', 'boolean');
          WHEN lower(COALESCE(v_column->>'edit_type', v_column->>'render_type', '')) LIKE '%int%'
            OR lower(COALESCE(v_column->>'edit_type', v_column->>'render_type', '')) LIKE '%number%'
            OR lower(COALESCE(v_column->>'edit_type', v_column->>'render_type', '')) LIKE '%numeric%' THEN
            v_coercions := jsonb_build_array('trim', 'null', 'number');
          WHEN lower(COALESCE(v_column->>'edit_type', v_column->>'render_type', '')) LIKE '%date%' THEN
            v_coercions := jsonb_build_array('trim', 'null', 'date');
          WHEN lower(COALESCE(v_column->>'edit_type', v_column->>'render_type', '')) LIKE '%array%'
            OR lower(COALESCE(v_column->>'edit_type', v_column->>'render_type', '')) LIKE '%multi%' THEN
            v_coercions := jsonb_build_array('trim', 'null', 'array');
          WHEN lower(COALESCE(v_column->>'edit_type', v_column->>'render_type', '')) LIKE '%json%' THEN
            v_coercions := jsonb_build_array('trim', 'null', 'json');
          ELSE
            v_coercions := jsonb_build_array('trim', 'null');
        END CASE;

        v_enum_values := CASE
          WHEN jsonb_typeof(v_column_import->'enum_values') = 'array' THEN v_column_import->'enum_values'
          WHEN v_resource_key = 'recipients' AND COALESCE(v_column->>'key', '') = 'preferred_language' THEN jsonb_build_array('ar', 'en')
          ELSE NULL
        END;

        v_column_import := jsonb_strip_nulls(jsonb_build_object(
          'enabled', v_enabled,
          'required', COALESCE(NULLIF(v_column_import->>'required', '')::boolean, FALSE),
          'identity', CASE
            WHEN v_resource_key = 'recipients' AND COALESCE(v_column->>'key', '') = 'external_id' THEN TRUE
            ELSE COALESCE(NULLIF(v_column_import->>'identity', '')::boolean, FALSE)
          END,
          'aliases', v_aliases,
          'coercions', CASE
            WHEN jsonb_typeof(v_column_import->'coercions') = 'array' THEN v_column_import->'coercions'
            ELSE v_coercions
          END,
          'enum_values', v_enum_values,
          'lookup', CASE
            WHEN jsonb_typeof(v_column_import->'lookup') = 'object' THEN v_column_import->'lookup'
            ELSE NULL
          END
        ));

        v_updated_columns := v_updated_columns || jsonb_build_array(
          jsonb_set(v_column, '{import}', v_column_import, TRUE)
        );
      END LOOP;
      v_resource := jsonb_set(v_resource, '{columns}', v_updated_columns, TRUE);
    END IF;

    v_resource := jsonb_set(v_resource, '{import}', v_import, TRUE);

    IF v_resource_key = 'mapping_operation_reports' THEN
      v_select := COALESCE(v_resource->'select', '[]'::jsonb);
      IF NOT EXISTS (
        SELECT 1
          FROM jsonb_array_elements_text(v_select) AS value
         WHERE value = 'operation_kind'
      ) THEN
        v_select := v_select || jsonb_build_array('operation_kind');
      END IF;

      v_filters := COALESCE(v_resource->'filters', '[]'::jsonb);
      IF NOT EXISTS (
        SELECT 1
          FROM jsonb_array_elements(v_filters) AS value
         WHERE value->>'key' = 'operation_kind'
      ) THEN
        v_filters := v_filters || jsonb_build_array(
          jsonb_build_object('key', 'operation_kind', 'column', 'operation_kind', 'op', 'eq')
        );
      END IF;

      v_resource := jsonb_set(v_resource, '{select}', v_select, TRUE);
      v_resource := jsonb_set(v_resource, '{filters}', v_filters, TRUE);
    END IF;

    v_updated_resources := v_updated_resources || jsonb_build_array(v_resource);
  END LOOP;

  SELECT value
    INTO v_existing
    FROM jsonb_array_elements(v_updated_resources) AS value
   WHERE value->>'key' = 'tabular_import_runs'
   LIMIT 1;

  IF v_existing IS NULL THEN
    v_updated_resources := v_updated_resources || jsonb_build_array(v_tabular_runs_def);
  ELSE
    v_updated_resources := (
      SELECT jsonb_agg(
               CASE
                 WHEN value->>'key' = 'tabular_import_runs' THEN v_tabular_runs_def
                 ELSE value
               END
             )
        FROM jsonb_array_elements(v_updated_resources) AS value
    );
  END IF;

  RETURN jsonb_set(v_current, '{resources}', COALESCE(v_updated_resources, '[]'::jsonb), TRUE);
END;
$function$;

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
  v_user_id UUID := auth.uid();
  v_org_id UUID := public.current_user_org_id();
  v_client_id UUID := public.current_user_client_id();
  v_sender_id UUID := public.current_user_sender_id();
  v_resource_key TEXT := NULLIF(btrim(COALESCE(v_payload->>'resource_key', '')), '');
  v_write_mode TEXT := lower(COALESCE(NULLIF(btrim(COALESCE(v_payload->>'write_mode', '')), ''), 'create'));
  v_rule_source TEXT := lower(COALESCE(NULLIF(btrim(COALESCE(v_payload->>'rule_source', '')), ''), 'auto'));
  v_source_format TEXT := lower(COALESCE(NULLIF(btrim(COALESCE(v_payload->>'source_format', '')), ''), 'csv'));
  v_source_file_name TEXT := NULLIF(btrim(COALESCE(v_payload->>'source_file_name', '')), '');
  v_source_artifact_id UUID := public.mapping_studio_try_uuid_v1(v_payload->>'source_artifact_id');
  v_sheet_name TEXT := NULLIF(btrim(COALESCE(v_payload->>'sheet_name', '')), '');
  v_header_fingerprint TEXT := NULLIF(btrim(COALESCE(v_payload->>'header_fingerprint', '')), '');
  v_headers JSONB := COALESCE(v_payload->'headers', '[]'::jsonb);
  v_rows JSONB := COALESCE(v_payload->'rows', '[]'::jsonb);
  v_rules_payload JSONB := COALESCE(v_payload->'rules', '[]'::jsonb);
  v_resource JSONB;
  v_relation TEXT;
  v_relation_schema TEXT := 'public';
  v_relation_table TEXT := NULL;
  v_id_column TEXT;
  v_scope_columns JSONB := '{}'::jsonb;
  v_capability TEXT;
  v_allow_upsert BOOLEAN := FALSE;
  v_default_write_mode TEXT := 'create';
  v_identity_columns TEXT[] := ARRAY[]::TEXT[];
  v_resource_formats TEXT[] := ARRAY[]::TEXT[];
  v_importable_columns JSONB := '[]'::jsonb;
  v_required_targets TEXT[] := ARRAY[]::TEXT[];
  v_relation_required_targets TEXT[] := ARRAY[]::TEXT[];
  v_policy_row RECORD;
  v_policy JSONB := '{}'::jsonb;
  v_policy_formats TEXT[] := ARRAY['csv','xls','xlsx'];
  v_policy_max_rows INT := 5000;
  v_global_blocking JSONB := '[]'::jsonb;
  v_available_profiles JSONB := '[]'::jsonb;
  v_profile_match JSONB := NULL;
  v_profile_rules JSONB := '[]'::jsonb;
  v_candidate_rules JSONB := '[]'::jsonb;
  v_effective_rules JSONB := '[]'::jsonb;
  v_effective_target_keys TEXT[] := ARRAY[]::TEXT[];
  v_effective_source_headers TEXT[] := ARRAY[]::TEXT[];
  v_unmatched_headers TEXT[] := ARRAY[]::TEXT[];
  v_unresolved_targets TEXT[] := ARRAY[]::TEXT[];
  v_run_id UUID;
  v_row_item JSONB;
  v_rule JSONB;
  v_column JSONB;
  v_source_column TEXT;
  v_target_field TEXT;
  v_index INT := 0;
  v_total_rows INT := 0;
  v_will_create INT := 0;
  v_will_update INT := 0;
  v_will_skip INT := 0;
  v_blocked_count INT := 0;
  v_warning_count INT := 0;
  v_rows_preview JSONB := '[]'::jsonb;
  v_automatic_corrections JSONB := '[]'::jsonb;
  v_blocking_diagnostics JSONB := '[]'::jsonb;
  v_warning_diagnostics JSONB := '[]'::jsonb;
  v_mapped_row JSONB;
  v_diagnostics JSONB;
  v_coercions JSONB;
  v_action TEXT;
  v_execution_status TEXT;
  v_reason_codes JSONB;
  v_reason_messages JSONB;
  v_value_result JSONB;
  v_match JSONB;
  v_match_count INT;
  v_target_record_id TEXT;
  v_required_target TEXT;
  v_row_required_targets TEXT[] := ARRAY[]::TEXT[];
  v_identity_signature TEXT;
  v_seen_identity_signatures TEXT[] := ARRAY[]::TEXT[];
  v_rows_count_from_json INT := 0;
BEGIN
  IF jsonb_typeof(v_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'tabular_import_prepare_v1 requires payload object';
  END IF;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'tabular_import_prepare_v1 requires organization context';
  END IF;
  IF v_resource_key IS NULL THEN
    RAISE EXCEPTION 'tabular_import_prepare_v1 requires resource_key';
  END IF;
  IF jsonb_typeof(v_headers) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'tabular_import_prepare_v1 requires headers array';
  END IF;
  IF jsonb_typeof(v_rows) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'tabular_import_prepare_v1 requires rows array';
  END IF;
  IF jsonb_typeof(v_rules_payload) IS DISTINCT FROM 'array' THEN
    v_rules_payload := '[]'::jsonb;
  END IF;

  v_resource := public.tabular_import_resolve_resource_v1(v_resource_key);
  IF v_resource IS NULL THEN
    RAISE EXCEPTION 'tabular_import_prepare_v1 unknown resource %', v_resource_key;
  END IF;

  IF COALESCE((v_resource#>>ARRAY['import','enabled'])::boolean, FALSE) IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'tabular_import_prepare_v1 import disabled for resource %', v_resource_key;
  END IF;

  v_capability := COALESCE(
    NULLIF(btrim(COALESCE(v_resource#>>ARRAY['import','capability'], '')), ''),
    NULLIF(btrim(COALESCE(v_resource->>'capability_write', '')), ''),
    NULLIF(btrim(COALESCE(v_resource->>'capability_read', '')), '')
  );
  IF v_capability IS NOT NULL THEN
    PERFORM public.assert_capability_v1(v_capability, 'tenant', v_org_id);
  END IF;

  v_relation := NULLIF(btrim(COALESCE(v_resource->>'relation', '')), '');
  v_relation_schema := split_part(COALESCE(v_relation, ''), '.', 1);
  v_relation_table := split_part(COALESCE(v_relation, ''), '.', 2);
  IF NULLIF(btrim(COALESCE(v_relation_table, '')), '') IS NULL THEN
    v_relation_table := v_relation_schema;
    v_relation_schema := 'public';
  END IF;
  v_id_column := COALESCE(NULLIF(btrim(COALESCE(v_resource->>'id_column', '')), ''), 'id');
  v_scope_columns := COALESCE(v_resource->'scope_columns', '{}'::jsonb);
  v_default_write_mode := lower(COALESCE(NULLIF(btrim(COALESCE(v_resource#>>ARRAY['import','default_write_mode'], '')), ''), 'create'));
  BEGIN
    v_allow_upsert := COALESCE(NULLIF(v_resource#>>ARRAY['import','allow_upsert'], '')::boolean, FALSE);
  EXCEPTION
    WHEN OTHERS THEN
      v_allow_upsert := FALSE;
  END;

  IF v_relation IS NULL THEN
    RAISE EXCEPTION 'tabular_import_prepare_v1 resource % missing relation', v_resource_key;
  END IF;

  SELECT ARRAY(
    SELECT value
    FROM jsonb_array_elements_text(COALESCE(v_resource#>'{import,identity_columns}', '[]'::jsonb)) AS value
    WHERE NULLIF(btrim(value), '') IS NOT NULL
  ) INTO v_identity_columns;

  SELECT ARRAY(
    SELECT lower(value)
    FROM jsonb_array_elements_text(COALESCE(v_resource#>'{import,accepted_formats}', '[]'::jsonb)) AS value
    WHERE NULLIF(btrim(value), '') IS NOT NULL
  ) INTO v_resource_formats;

  IF v_write_mode NOT IN ('create', 'upsert') THEN
    v_write_mode := v_default_write_mode;
  END IF;
  IF v_write_mode = 'upsert' AND (NOT v_allow_upsert OR array_length(v_identity_columns, 1) IS NULL) THEN
    RAISE EXCEPTION 'tabular_import_prepare_v1 upsert not allowed for resource %', v_resource_key;
  END IF;

  SELECT jsonb_agg(column_entry.value)
    INTO v_importable_columns
    FROM jsonb_array_elements(COALESCE(v_resource->'columns', '[]'::jsonb)) AS column_entry(value)
   WHERE NULLIF(btrim(COALESCE(column_entry.value->>'key', '')), '') IS NOT NULL
     AND COALESCE(
       NULLIF(column_entry.value#>>ARRAY['import','enabled'], '')::boolean,
       CASE
         WHEN lower(COALESCE(column_entry.value->>'edit_mode', '')) IN ('none', 'read') THEN FALSE
         ELSE TRUE
       END
     ) IS TRUE;

  v_importable_columns := COALESCE(v_importable_columns, '[]'::jsonb);

  SELECT ARRAY(
    SELECT value->>'key'
    FROM jsonb_array_elements(v_importable_columns) AS value
    WHERE COALESCE(NULLIF(value#>>ARRAY['import','required'], '')::boolean, FALSE) IS TRUE
      AND NULLIF(btrim(COALESCE(value->>'key', '')), '') IS NOT NULL
  ) INTO v_required_targets;

  SELECT ARRAY(
    SELECT required_key
    FROM (
      SELECT DISTINCT NULLIF(btrim(COALESCE(value->>'key', '')), '') AS required_key
      FROM jsonb_array_elements(v_importable_columns) AS value
      JOIN pg_namespace n
        ON n.nspname = v_relation_schema
      JOIN pg_class c
        ON c.relnamespace = n.oid
       AND c.relname = v_relation_table
      JOIN pg_attribute a
        ON a.attrelid = c.oid
       AND a.attname = value->>'key'
       AND a.attnum > 0
       AND a.attisdropped = FALSE
      LEFT JOIN pg_attrdef ad
        ON ad.adrelid = a.attrelid
       AND ad.adnum = a.attnum
      WHERE NULLIF(btrim(COALESCE(value->>'key', '')), '') IS NOT NULL
        AND a.attnotnull IS TRUE
        AND COALESCE(a.attidentity, '') = ''
        AND COALESCE(a.attgenerated, '') = ''
        AND ad.adbin IS NULL
        AND value->>'key' <> v_id_column
        AND NOT (
          (v_scope_columns ? 'tenant' AND v_scope_columns->>'tenant' = value->>'key' AND v_org_id IS NOT NULL)
          OR (v_scope_columns ? 'client' AND v_scope_columns->>'client' = value->>'key' AND v_client_id IS NOT NULL)
          OR (v_scope_columns ? 'sender' AND v_scope_columns->>'sender' = value->>'key' AND v_sender_id IS NOT NULL)
        )
    ) AS required_columns
    WHERE required_key IS NOT NULL
    ORDER BY required_key
  ) INTO v_relation_required_targets;

  IF v_scope_columns ? 'client' AND v_client_id IS NULL THEN
    v_target_field := NULLIF(btrim(COALESCE(v_scope_columns->>'client', '')), '');
    IF v_target_field IS NOT NULL AND NOT (v_target_field = ANY(v_required_targets)) THEN
      v_required_targets := array_append(v_required_targets, v_target_field);
    END IF;
  END IF;

  IF v_scope_columns ? 'sender' AND v_sender_id IS NULL THEN
    v_target_field := NULLIF(btrim(COALESCE(v_scope_columns->>'sender', '')), '');
    IF v_target_field IS NOT NULL AND NOT (v_target_field = ANY(v_required_targets)) THEN
      v_required_targets := array_append(v_required_targets, v_target_field);
    END IF;
  END IF;

  SELECT *
    INTO v_policy_row
    FROM public.resolve_tabular_import_policy_v1(
      jsonb_strip_nulls(
        jsonb_build_object(
          'organization_id', v_org_id,
          'client_id', v_client_id,
          'sender_id', v_sender_id,
          'resource_key', v_resource_key
        )
      )
    )
   LIMIT 1;

  v_policy := COALESCE(v_policy_row.value, '{}'::jsonb);
  SELECT ARRAY(
    SELECT lower(value)
    FROM jsonb_array_elements_text(COALESCE(v_policy->'accepted_formats', '[]'::jsonb)) AS value
    WHERE NULLIF(btrim(value), '') IS NOT NULL
  ) INTO v_policy_formats;

  BEGIN
    v_policy_max_rows := COALESCE(NULLIF(v_policy->>'max_rows', '')::int, v_policy_max_rows);
  EXCEPTION
    WHEN OTHERS THEN
      v_policy_max_rows := 5000;
  END;

  IF v_source_format IS NULL OR v_source_format NOT IN ('csv', 'xls', 'xlsx') THEN
    v_global_blocking := v_global_blocking || jsonb_build_array(
      jsonb_build_object(
        'level', 'error',
        'blocking', TRUE,
        'code', 'source_format_invalid',
        'message', 'Unsupported import format.',
        'why', 'The uploaded file format is not supported by the tabular import runtime.',
        'recommended_fix', 'Upload a CSV, XLS, or XLSX file.'
      )
    );
  ELSIF NOT (v_source_format = ANY(v_policy_formats)) OR NOT (v_source_format = ANY(v_resource_formats)) THEN
    v_global_blocking := v_global_blocking || jsonb_build_array(
      jsonb_build_object(
        'level', 'error',
        'blocking', TRUE,
        'code', 'source_format_not_allowed',
        'message', 'This resource does not allow the uploaded file format.',
        'why', 'The import policy or resource contract rejected the selected source format.',
        'recommended_fix', 'Use one of the allowed formats for this resource.'
      )
    );
  END IF;

  SELECT count(*) INTO v_rows_count_from_json FROM jsonb_array_elements(v_rows);

  IF v_rows_count_from_json = 0 THEN
    v_global_blocking := v_global_blocking || jsonb_build_array(
      jsonb_build_object(
        'level', 'error',
        'blocking', TRUE,
        'code', 'rows_missing',
        'message', 'No rows were detected in the uploaded file.',
        'why', 'The source workbook did not produce any importable rows.',
        'recommended_fix', 'Upload a file with headers and at least one data row.'
      )
    );
  ELSIF v_rows_count_from_json > v_policy_max_rows THEN
    v_global_blocking := v_global_blocking || jsonb_build_array(
      jsonb_build_object(
        'level', 'error',
        'blocking', TRUE,
        'code', 'rows_limit_exceeded',
        'message', format('This import contains %s rows which exceeds the configured limit.', v_rows_count_from_json),
        'why', 'The resolved tabular import policy limits the maximum rows per import.',
        'recommended_fix', format('Reduce the file to %s rows or fewer, or update the tabular import policy.', v_policy_max_rows)
      )
    );
  END IF;

  IF v_header_fingerprint IS NULL THEN
    SELECT string_agg(normalized_header, '|' ORDER BY normalized_header)
      INTO v_header_fingerprint
      FROM (
        SELECT regexp_replace(lower(btrim(value)), '[^a-z0-9]+', '_', 'g') AS normalized_header
        FROM jsonb_array_elements_text(v_headers) AS value
        WHERE NULLIF(btrim(value), '') IS NOT NULL
      ) normalized;
  END IF;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
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
      )
      ORDER BY profile.updated_at DESC, profile.created_at DESC
    ),
    '[]'::jsonb
  )
    INTO v_available_profiles
    FROM public.ui_tabular_import_profiles_v1(v_resource_key) profile;

  SELECT value
    INTO v_profile_match
    FROM jsonb_array_elements(v_available_profiles) AS value
   WHERE COALESCE(value->>'header_fingerprint', '') = COALESCE(v_header_fingerprint, '')
   ORDER BY COALESCE(value->>'updated_at', value->>'created_at', '') DESC
   LIMIT 1;

  IF v_profile_match IS NOT NULL AND jsonb_typeof(v_profile_match#>'{mapping_config,field_rules}') = 'array' THEN
    v_profile_rules := COALESCE(v_profile_match#>'{mapping_config,field_rules}', '[]'::jsonb);
  END IF;

  v_candidate_rules := COALESCE(v_rules_payload, '[]'::jsonb);
  IF jsonb_typeof(v_candidate_rules) IS DISTINCT FROM 'array' THEN
    v_candidate_rules := '[]'::jsonb;
  END IF;

  IF v_rule_source <> 'manual'
     AND jsonb_typeof(v_profile_rules) = 'array'
     AND jsonb_array_length(v_profile_rules) > 0 THEN
    v_effective_rules := v_profile_rules;
    v_rule_source := 'profile';
  ELSIF jsonb_array_length(v_candidate_rules) > 0 THEN
    v_effective_rules := v_candidate_rules;
    v_rule_source := CASE WHEN v_rule_source = 'manual' THEN 'manual' ELSE 'auto' END;
  ELSE
    v_effective_rules := '[]'::jsonb;
    v_rule_source := 'auto';
  END IF;

  IF jsonb_typeof(v_effective_rules) IS DISTINCT FROM 'array' THEN
    v_effective_rules := '[]'::jsonb;
  END IF;

  SELECT ARRAY(
    SELECT DISTINCT NULLIF(btrim(COALESCE(value->>'target_field', '')), '')
    FROM jsonb_array_elements(v_effective_rules) AS value
    WHERE COALESCE(value->>'enabled', 'true') <> 'false'
      AND NULLIF(btrim(COALESCE(value->>'target_field', '')), '') IS NOT NULL
  ) INTO v_effective_target_keys;

  SELECT ARRAY(
    SELECT DISTINCT NULLIF(btrim(COALESCE(value->>'source_column', '')), '')
    FROM jsonb_array_elements(v_effective_rules) AS value
    WHERE COALESCE(value->>'enabled', 'true') <> 'false'
      AND NULLIF(btrim(COALESCE(value->>'source_column', '')), '') IS NOT NULL
  ) INTO v_effective_source_headers;

  SELECT ARRAY(
    SELECT header_value
    FROM jsonb_array_elements_text(v_headers) AS header_value
    WHERE NOT (header_value = ANY(COALESCE(v_effective_source_headers, ARRAY[]::TEXT[])))
  ) INTO v_unmatched_headers;

  SELECT ARRAY(
    SELECT target_key
    FROM unnest(COALESCE(v_required_targets, ARRAY[]::TEXT[])) AS target_key
    WHERE NOT (target_key = ANY(COALESCE(v_effective_target_keys, ARRAY[]::TEXT[])))
      AND NOT (
        (v_scope_columns ? 'tenant' AND v_scope_columns->>'tenant' = target_key AND v_org_id IS NOT NULL)
        OR (v_scope_columns ? 'client' AND v_scope_columns->>'client' = target_key AND v_client_id IS NOT NULL)
        OR (v_scope_columns ? 'sender' AND v_scope_columns->>'sender' = target_key AND v_sender_id IS NOT NULL)
      )
  ) INTO v_unresolved_targets;

  IF array_length(v_unresolved_targets, 1) IS NOT NULL THEN
    v_global_blocking := v_global_blocking || (
      SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
          'level', 'error',
          'blocking', TRUE,
          'code', 'target_unresolved',
          'fieldPath', target_key,
          'message', format('Required target %s is not mapped.', target_key),
          'why', 'The dry-run could not find a source value for a required target field.',
          'recommended_fix', 'Map a source column to this field or provide the missing scope context before approval.'
        )
      ), '[]'::jsonb)
      FROM unnest(v_unresolved_targets) AS target_key
    );
  END IF;

  INSERT INTO public.tabular_import_runs (
    organization_id,
    client_id,
    sender_id,
    resource_key,
    relation_name,
    write_mode,
    status,
    profile_name,
    header_fingerprint,
    sheet_name,
    source_format,
    source_file_name,
    source_artifact_id,
    summary,
    created_by,
    updated_by
  )
  VALUES (
    v_org_id,
    v_client_id,
    v_sender_id,
    v_resource_key,
    v_relation,
    v_write_mode,
    'prepared',
    NULLIF(btrim(COALESCE(v_profile_match->>'profile_name', '')), ''),
    v_header_fingerprint,
    v_sheet_name,
    v_source_format,
    v_source_file_name,
    v_source_artifact_id,
    jsonb_strip_nulls(jsonb_build_object('rule_source', v_rule_source, 'headers', v_headers)),
    v_user_id,
    v_user_id
  )
  RETURNING id INTO v_run_id;

  IF v_source_artifact_id IS NOT NULL THEN
    INSERT INTO public.artifact_links (
      organization_id,
      artifact_id,
      resource_type,
      resource_id,
      relation_type,
      metadata
    )
    VALUES (
      v_org_id,
      v_source_artifact_id,
      'tabular_import_runs',
      v_run_id,
      'source',
      jsonb_build_object('file_name', v_source_file_name, 'sheet_name', v_sheet_name)
    )
    ON CONFLICT (organization_id, artifact_id, resource_type, resource_id, relation_type) DO NOTHING;
  END IF;

  FOR v_row_item IN
    SELECT value
    FROM jsonb_array_elements(v_rows) AS value
  LOOP
    v_index := v_index + 1;
    IF jsonb_typeof(v_row_item) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    v_total_rows := v_total_rows + 1;
    v_mapped_row := '{}'::jsonb;
    v_diagnostics := COALESCE(v_global_blocking, '[]'::jsonb);
    v_coercions := '[]'::jsonb;

    FOR v_rule IN
      SELECT value
      FROM jsonb_array_elements(v_effective_rules) AS value
    LOOP
      v_source_column := v_rule->>'source_column';
      v_target_field := v_rule->>'target_field';
      v_column := public.tabular_import_resolve_column_v1(v_importable_columns, v_target_field);
      IF v_column IS NULL THEN
        CONTINUE;
      END IF;

      v_value_result := public.tabular_import_coerce_value_v1(v_row_item -> v_source_column, v_column, v_source_column);
      IF v_value_result ? 'diagnostics' THEN
        v_diagnostics := v_diagnostics || COALESCE(v_value_result->'diagnostics', '[]'::jsonb);
      END IF;
      IF v_value_result ? 'coercion' THEN
        v_coercions := v_coercions || jsonb_build_array(v_value_result->'coercion');
      END IF;
      IF v_value_result ? 'value' THEN
        v_mapped_row := jsonb_set(v_mapped_row, ARRAY[v_target_field], COALESCE(v_value_result->'value', 'null'::jsonb), TRUE);
      END IF;
    END LOOP;

    IF v_scope_columns ? 'tenant' AND v_org_id IS NOT NULL THEN
      v_target_field := NULLIF(btrim(COALESCE(v_scope_columns->>'tenant', '')), '');
      IF v_target_field IS NOT NULL AND NOT (v_mapped_row ? v_target_field) THEN
        v_mapped_row := jsonb_set(v_mapped_row, ARRAY[v_target_field], to_jsonb(v_org_id), TRUE);
      END IF;
    END IF;
    IF v_scope_columns ? 'client' AND v_client_id IS NOT NULL THEN
      v_target_field := NULLIF(btrim(COALESCE(v_scope_columns->>'client', '')), '');
      IF v_target_field IS NOT NULL AND NOT (v_mapped_row ? v_target_field) THEN
        v_mapped_row := jsonb_set(v_mapped_row, ARRAY[v_target_field], to_jsonb(v_client_id), TRUE);
      END IF;
    END IF;
    IF v_scope_columns ? 'sender' AND v_sender_id IS NOT NULL THEN
      v_target_field := NULLIF(btrim(COALESCE(v_scope_columns->>'sender', '')), '');
      IF v_target_field IS NOT NULL AND NOT (v_mapped_row ? v_target_field) THEN
        v_mapped_row := jsonb_set(v_mapped_row, ARRAY[v_target_field], to_jsonb(v_sender_id), TRUE);
      END IF;
    END IF;

    v_target_record_id := NULL;
    v_match_count := 0;
    IF array_length(v_identity_columns, 1) IS NOT NULL THEN
      v_identity_signature := NULL;
      IF NOT EXISTS (
        SELECT 1
        FROM unnest(v_identity_columns) AS identity_key
        WHERE NOT (v_mapped_row ? identity_key)
           OR v_mapped_row->identity_key IS NULL
           OR v_mapped_row->identity_key = 'null'::jsonb
      ) THEN
        SELECT string_agg(COALESCE(v_mapped_row->>identity_key, ''), '||' ORDER BY identity_key)
          INTO v_identity_signature
          FROM unnest(v_identity_columns) AS identity_key;
      END IF;

      IF v_identity_signature IS NOT NULL THEN
        IF v_identity_signature = ANY(v_seen_identity_signatures) THEN
          v_diagnostics := v_diagnostics || jsonb_build_array(
            jsonb_build_object(
              'level', 'error',
              'blocking', TRUE,
              'code', 'duplicate_identity_in_file',
              'message', format('Row %s duplicates an earlier identity in the same file.', v_index),
              'why', 'The import file contains multiple rows with the same configured identity columns.',
              'recommended_fix', 'Remove the duplicate row or consolidate the source data before import.'
            )
          );
        ELSE
          v_seen_identity_signatures := array_append(v_seen_identity_signatures, v_identity_signature);
        END IF;
      END IF;

      IF v_diagnostics = '[]'::jsonb OR NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_diagnostics) AS diag
        WHERE COALESCE((diag->>'blocking')::boolean, FALSE) IS TRUE
      ) THEN
        v_match := public.tabular_import_match_target_v1(v_relation, v_id_column, v_mapped_row, v_identity_columns);
        BEGIN
          v_match_count := COALESCE(NULLIF(v_match->>'match_count', '')::int, 0);
        EXCEPTION
          WHEN OTHERS THEN
            v_match_count := 0;
        END;
        v_target_record_id := NULLIF(btrim(COALESCE(v_match->>'target_record_id', '')), '');

        IF v_write_mode = 'upsert' THEN
          IF v_match_count > 1 THEN
            v_diagnostics := v_diagnostics || jsonb_build_array(
              jsonb_build_object(
                'level', 'error',
                'blocking', TRUE,
                'code', 'identity_match_ambiguous',
                'message', format('Row %s matched more than one existing record.', v_index),
                'why', 'Configured upsert identity columns resolved to multiple target rows.',
                'recommended_fix', 'Tighten the identity columns or clean the target data before import.'
              )
            );
          END IF;
        ELSIF v_write_mode = 'create' AND v_match_count > 0 THEN
          v_diagnostics := v_diagnostics || jsonb_build_array(
            jsonb_build_object(
              'level', 'warning',
              'blocking', FALSE,
              'code', 'existing_identity_conflict',
              'message', format('Row %s matches an existing record and will be skipped in create mode.', v_index),
              'why', 'Create mode does not overwrite or update rows that already exist.',
              'recommended_fix', 'Switch to upsert for this resource or remove existing duplicates before import.'
            )
          );
        END IF;
      END IF;
    END IF;

    v_row_required_targets := COALESCE(v_required_targets, ARRAY[]::TEXT[]);
    IF v_match_count = 0 THEN
      SELECT ARRAY(
        SELECT target_key
        FROM (
          SELECT DISTINCT NULLIF(btrim(COALESCE(target_key, '')), '') AS target_key
          FROM unnest(COALESCE(v_row_required_targets, ARRAY[]::TEXT[]) || COALESCE(v_relation_required_targets, ARRAY[]::TEXT[])) AS target_key
        ) AS required_targets
        WHERE target_key IS NOT NULL
        ORDER BY target_key
      ) INTO v_row_required_targets;
    END IF;

    FOREACH v_required_target IN ARRAY COALESCE(v_row_required_targets, ARRAY[]::TEXT[])
    LOOP
      IF NOT (v_mapped_row ? v_required_target)
         OR v_mapped_row->v_required_target IS NULL
         OR v_mapped_row->v_required_target = 'null'::jsonb
         OR (jsonb_typeof(v_mapped_row->v_required_target) = 'string' AND NULLIF(btrim(v_mapped_row->>v_required_target), '') IS NULL) THEN
        v_diagnostics := v_diagnostics || jsonb_build_array(
          jsonb_build_object(
            'level', 'error',
            'blocking', TRUE,
            'code', 'required_field_missing',
            'fieldPath', v_required_target,
            'message', format('Required field %s is missing on row %s.', v_required_target, v_index),
            'why', 'The mapped row does not contain a value for a required target column.',
            'recommended_fix', 'Provide a source value for this field or fix the mapping before approval.'
          )
        );
      END IF;
    END LOOP;

    IF EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_diagnostics) AS diag
      WHERE COALESCE((diag->>'blocking')::boolean, FALSE) IS TRUE
    ) THEN
      v_action := 'block';
      v_execution_status := 'blocked';
      v_blocked_count := v_blocked_count + 1;
    ELSIF v_write_mode = 'create' AND v_match_count > 0 THEN
      v_action := 'skip';
      v_execution_status := 'skipped';
      v_will_skip := v_will_skip + 1;
    ELSIF v_write_mode = 'upsert' AND v_match_count = 1 THEN
      v_action := 'update';
      v_execution_status := 'queued';
      v_will_update := v_will_update + 1;
    ELSE
      v_action := 'create';
      v_execution_status := 'queued';
      v_will_create := v_will_create + 1;
    END IF;

    SELECT COALESCE(jsonb_agg(diag->>'code'), '[]'::jsonb),
           COALESCE(jsonb_agg(diag->>'message'), '[]'::jsonb)
      INTO v_reason_codes, v_reason_messages
      FROM jsonb_array_elements(v_diagnostics) AS diag;

    INSERT INTO public.tabular_import_run_rows (
      run_id,
      organization_id,
      row_number,
      action,
      execution_status,
      original_row,
      mapped_row,
      diagnostics,
      coercions,
      target_record_id,
      reason_codes,
      reason_messages,
      metadata
    )
    VALUES (
      v_run_id,
      v_org_id,
      v_index,
      v_action,
      v_execution_status,
      v_row_item,
      v_mapped_row,
      v_diagnostics,
      v_coercions,
      v_target_record_id,
      COALESCE(v_reason_codes, '[]'::jsonb),
      COALESCE(v_reason_messages, '[]'::jsonb),
      jsonb_build_object('match_count', v_match_count)
    );

    IF v_index <= 25 THEN
      v_rows_preview := v_rows_preview || jsonb_build_array(
        jsonb_build_object(
          'row_number', v_index,
          'execution_status', v_execution_status,
          'action', v_action,
          'diagnostics', v_diagnostics,
          'coercions', v_coercions,
          'mapped_row', v_mapped_row,
          'target_record_id', v_target_record_id,
          'reason_codes', COALESCE(v_reason_codes, '[]'::jsonb),
          'reason_messages', COALESCE(v_reason_messages, '[]'::jsonb)
        )
      );
    END IF;

    IF jsonb_array_length(v_coercions) > 0 THEN
      v_automatic_corrections := v_automatic_corrections || v_coercions;
    END IF;

    IF jsonb_array_length(v_diagnostics) > 0 THEN
      v_warning_count := v_warning_count + COALESCE((
        SELECT count(*)
        FROM jsonb_array_elements(v_diagnostics) AS diag
        WHERE lower(COALESCE(diag->>'level', '')) = 'warning'
      ), 0);
      v_blocking_diagnostics := v_blocking_diagnostics || COALESCE((
        SELECT jsonb_agg(diag)
        FROM jsonb_array_elements(v_diagnostics) AS diag
        WHERE COALESCE((diag->>'blocking')::boolean, FALSE) IS TRUE
      ), '[]'::jsonb);
      v_warning_diagnostics := v_warning_diagnostics || COALESCE((
        SELECT jsonb_agg(diag)
        FROM jsonb_array_elements(v_diagnostics) AS diag
        WHERE lower(COALESCE(diag->>'level', '')) = 'warning'
      ), '[]'::jsonb);
    END IF;
  END LOOP;

  UPDATE public.tabular_import_runs
     SET total_rows = v_total_rows,
         will_create = v_will_create,
         will_update = v_will_update,
         will_skip = v_will_skip,
         blocked_count = v_blocked_count,
         warning_count = v_warning_count,
         summary = jsonb_strip_nulls(
           COALESCE(summary, '{}'::jsonb) || jsonb_build_object(
             'headers', v_headers,
             'resolved_rules', v_effective_rules,
             'profile_match', v_profile_match,
             'available_profiles', v_available_profiles,
             'unmatched_headers', to_jsonb(COALESCE(v_unmatched_headers, ARRAY[]::TEXT[])),
             'unresolved_targets', to_jsonb(COALESCE(v_unresolved_targets, ARRAY[]::TEXT[])),
             'write_mode', v_write_mode,
             'sheet_name', v_sheet_name,
             'source_file_name', v_source_file_name,
             'source_format', v_source_format
           )
         ),
         updated_at = now(),
         updated_by = v_user_id
   WHERE id = v_run_id;

  RETURN jsonb_build_object(
    'run_id', v_run_id,
    'resource', v_resource_key,
    'write_mode', v_write_mode,
    'source_format', v_source_format,
    'source_file_name', v_source_file_name,
    'header_fingerprint', v_header_fingerprint,
    'sheet_name', v_sheet_name,
    'unmatched_headers', to_jsonb(COALESCE(v_unmatched_headers, ARRAY[]::TEXT[])),
    'unresolved_targets', to_jsonb(COALESCE(v_unresolved_targets, ARRAY[]::TEXT[])),
    'total_rows', v_total_rows,
    'will_create', v_will_create,
    'will_update', v_will_update,
    'will_skip', v_will_skip,
    'blocked_count', v_blocked_count,
    'warning_count', v_warning_count,
    'automatic_corrections', COALESCE(v_automatic_corrections, '[]'::jsonb),
    'blocking_diagnostics', COALESCE(v_blocking_diagnostics, '[]'::jsonb),
    'warning_diagnostics', COALESCE(v_warning_diagnostics, '[]'::jsonb),
    'rows', COALESCE(v_rows_preview, '[]'::jsonb),
    'profile', v_profile_match,
    'available_profiles', COALESCE(v_available_profiles, '[]'::jsonb),
    'resolved_rules', COALESCE(v_effective_rules, '[]'::jsonb)
  );
END;
$function$;

DO $do$
DECLARE
  v_schema_version INT;
  v_row RECORD;
  v_normalized JSONB;
BEGIN
  SELECT version
    INTO v_schema_version
    FROM public.schema_registry
   WHERE category = 'ui_read_registry'
     AND is_active = TRUE
   ORDER BY version DESC
   LIMIT 1;

  IF v_schema_version IS NULL THEN
    RAISE EXCEPTION 'schema_registry missing active schema for ui_read_registry';
  END IF;

  FOR v_row IN
    SELECT s.scope_type, s.scope_id, s.cached_value
      FROM public.settings s
     WHERE s.category = 'ui_read_registry'
  LOOP
    v_normalized := public.normalize_settings_value_v1('ui_read_registry', v_row.cached_value);
    IF v_normalized IS DISTINCT FROM v_row.cached_value THEN
      PERFORM 1
        FROM public.upsert_settings_value_v1(
          'ui_read_registry',
          v_row.scope_type,
          v_row.scope_id,
          v_normalized,
          v_schema_version,
          'Refresh ui_read_registry import enum and alias normalization'
        );
    END IF;
  END LOOP;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202603091300_tabular_import_trim_scope_and_enum_guard_v1'));

COMMIT;
