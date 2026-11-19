-- Align required global setting defaults with their schema_registry contracts.
-- This keeps Console/FieldOps/Webhook policy defaults row-driven and verifier-safe.

BEGIN;

SET search_path TO public, extensions, pg_temp;

SELECT pg_advisory_lock(hashtext('202606042132_settings_global_default_schema_alignment_v1'));

WITH schemas(category, description, schema) AS (
  VALUES
    (
      'tenant_currency',
      'Tenant currency global default.',
      jsonb_build_object(
        'type', 'object',
        'required', jsonb_build_array('iso_code'),
        'properties', jsonb_build_object(
          'iso_code', jsonb_build_object('type', 'string', 'minLength', 3, 'maxLength', 3)
        ),
        'additionalProperties', true
      )
    ),
    (
      'tenant_default_timezone',
      'Tenant timezone global default.',
      jsonb_build_object(
        'type', 'object',
        'required', jsonb_build_array('iana'),
        'properties', jsonb_build_object(
          'iana', jsonb_build_object('type', 'string', 'minLength', 1)
        ),
        'additionalProperties', true
      )
    ),
    (
      'task_sla_thresholds',
      'Task SLA threshold defaults.',
      jsonb_build_object(
        'type', 'object',
        'properties', jsonb_build_object(
          'sla_ring_warn_pct', jsonb_build_object('type', 'number'),
          'sla_ring_danger_pct', jsonb_build_object('type', 'number'),
          'no_sla_default_percent', jsonb_build_object('type', 'number'),
          'sla_warn_minutes_before_breach', jsonb_build_object('type', 'integer')
        ),
        'additionalProperties', true
      )
    ),
    (
      'driver_kpi_thresholds',
      'Driver KPI threshold defaults.',
      jsonb_build_object(
        'type', 'object',
        'properties', jsonb_build_object(
          'rating_good', jsonb_build_object('type', 'number'),
          'rating_warn', jsonb_build_object('type', 'number'),
          'on_time_pct_good', jsonb_build_object('type', 'number'),
          'on_time_pct_warn', jsonb_build_object('type', 'number'),
          'docs_expiring_days', jsonb_build_object('type', 'integer'),
          'score_oos_threshold', jsonb_build_object('type', 'integer')
        ),
        'additionalProperties', true
      )
    ),
    (
      'route_plan_thresholds',
      'Route plan threshold defaults.',
      jsonb_build_object(
        'type', 'object',
        'properties', jsonb_build_object(
          'fail_count_warn', jsonb_build_object('type', 'integer'),
          'wave_promise_window_seconds', jsonb_build_object('type', 'integer', 'minimum', 0)
        ),
        'additionalProperties', true
      )
    ),
    (
      'feature_flags_thresholds',
      'Feature flag readiness threshold defaults.',
      jsonb_build_object(
        'type', 'object',
        'properties', jsonb_build_object(
          'complete_pct', jsonb_build_object('type', 'number', 'minimum', 0)
        ),
        'additionalProperties', true
      )
    ),
    (
      'marketplace_participant_application_filter',
      'Marketplace participant application filter defaults.',
      jsonb_build_object(
        'type', 'object',
        'properties', jsonb_build_object(
          'excluded_type_keys', jsonb_build_object(
            'type', 'array',
            'items', jsonb_build_object('type', 'string')
          )
        ),
        'additionalProperties', true
      )
    ),
    (
      'mobile_auth_policy',
      'FieldOps Mobile V2 authentication policy defaults.',
      jsonb_build_object(
        'type', 'object',
        'properties', jsonb_build_object(
          'provider', jsonb_build_object('type', 'string'),
          'test_otp', jsonb_build_object('type', jsonb_build_array('string', 'null')),
          'edge_fn_name', jsonb_build_object('type', jsonb_build_array('string', 'null'))
        ),
        'additionalProperties', true
      )
    )
)
INSERT INTO public.schema_registry (
  category,
  version,
  schema,
  description,
  examples,
  is_active
)
SELECT
  category,
  1,
  schema,
  description,
  '[]'::jsonb,
  true
FROM schemas
ON CONFLICT (category, version) DO UPDATE
SET schema = EXCLUDED.schema,
    description = EXCLUDED.description,
    examples = EXCLUDED.examples,
    is_active = EXCLUDED.is_active,
    updated_at = now();

UPDATE public.schema_registry
   SET schema = jsonb_set(schema, '{properties,provider_priority,minItems}', '0'::jsonb, true),
       updated_at = now()
 WHERE category = 'geocoding_policy'
   AND schema #>> '{properties,provider_priority,type}' = 'array'
   AND COALESCE((schema #>> '{properties,provider_priority,minItems}')::int, 0) > 0;

UPDATE public.schema_registry
   SET schema = jsonb_set(
     schema,
     '{properties,workflow,oneOf,1,properties,templates_by_intent}',
     jsonb_build_object(
       'type', 'object',
       'additionalProperties', jsonb_build_object(
         'type', 'object',
         'properties', jsonb_build_object(
           'template_id', jsonb_build_object('type', 'string', 'format', 'uuid'),
           'template_name', jsonb_build_object('type', 'string')
         ),
         'additionalProperties', true
       )
     ),
     true
   ),
       updated_at = now()
 WHERE category = 'webhook_ingest_policy'
   AND schema #> '{properties,workflow,oneOf,1,properties}' IS NOT NULL;

UPDATE public.settings_versions
   SET schema_version = 1,
       updated_at = now()
 WHERE category IN (
   'mobile_auth_policy',
   'ui_read_registry',
   'tenant_currency',
   'tenant_default_timezone',
   'task_sla_thresholds',
   'driver_kpi_thresholds',
   'route_plan_thresholds',
   'feature_flags_thresholds',
   'marketplace_participant_application_filter'
 )
   AND scope_type = 'global'
   AND scope_id IS NULL
   AND schema_version IS DISTINCT FROM 1;

WITH normalized AS (
  SELECT
    s.id,
    jsonb_set(
      s.cached_value,
      '{commands}',
      COALESCE(
        (
          SELECT jsonb_agg(
                   CASE
                     WHEN command.value ? 'execution'
                          AND jsonb_typeof(command.value -> 'execution') <> 'object'
                       THEN jsonb_set(
                              command.value,
                              '{execution}',
                              jsonb_build_object('type', command.value ->> 'execution'),
                              true
                            )
                     ELSE command.value
                   END
                   ORDER BY command.ordinality
                 )
            FROM jsonb_array_elements(COALESCE(s.cached_value -> 'commands', '[]'::jsonb))
              WITH ORDINALITY AS command(value, ordinality)
        ),
        '[]'::jsonb
      ),
      true
    ) AS next_value
  FROM public.settings s
  WHERE s.category = 'ui_command_registry'
    AND s.scope_type = 'global'
    AND s.scope_id IS NULL
)
UPDATE public.settings s
   SET cached_value = normalized.next_value,
       last_updated = now()
  FROM normalized
 WHERE s.id = normalized.id
   AND s.cached_value IS DISTINCT FROM normalized.next_value;

UPDATE public.settings_versions sv
   SET value = s.cached_value,
       schema_version = COALESCE(sv.schema_version, 1),
       updated_at = now()
  FROM public.settings s
 WHERE sv.id = s.settings_version_id
   AND s.category = 'ui_command_registry'
   AND s.scope_type = 'global'
   AND s.scope_id IS NULL
   AND (sv.value IS DISTINCT FROM s.cached_value OR sv.schema_version IS DISTINCT FROM 1);

DO $do$
DECLARE
  v_row record;
  v_apps jsonb;
  v_sections jsonb;
  v_items jsonb;
  v_app record;
  v_section record;
  v_item record;
  v_next jsonb;
BEGIN
  FOR v_row IN
    SELECT id, cached_value
      FROM public.settings
     WHERE category = 'ui_navigation'
       AND scope_type = 'global'
       AND scope_id IS NULL
  LOOP
    v_apps := '{}'::jsonb;

    FOR v_app IN
      SELECT key, value
        FROM jsonb_each(COALESCE(v_row.cached_value -> 'apps', '{}'::jsonb))
    LOOP
      v_sections := '[]'::jsonb;

      FOR v_section IN
        SELECT value, ordinality
          FROM jsonb_array_elements(COALESCE(v_app.value -> 'sections', '[]'::jsonb))
            WITH ORDINALITY AS section(value, ordinality)
      LOOP
        v_items := '[]'::jsonb;

        FOR v_item IN
          SELECT value, ordinality
            FROM jsonb_array_elements(COALESCE(v_section.value -> 'items', '[]'::jsonb))
              WITH ORDINALITY AS item(value, ordinality)
        LOOP
          v_items := v_items || jsonb_build_array(
            CASE
              WHEN v_item.value ? 'capability' AND v_item.value -> 'capability' = 'null'::jsonb
                THEN v_item.value - 'capability'
              ELSE v_item.value
            END
          );
        END LOOP;

        v_sections := v_sections || jsonb_build_array(
          jsonb_set(v_section.value, '{items}', v_items, true)
        );
      END LOOP;

      v_apps := v_apps || jsonb_build_object(
        v_app.key,
        jsonb_set(v_app.value, '{sections}', v_sections, true)
      );
    END LOOP;

    v_next := jsonb_set(v_row.cached_value, '{apps}', v_apps, true);

    UPDATE public.settings
       SET cached_value = v_next,
           last_updated = now()
     WHERE id = v_row.id
       AND cached_value IS DISTINCT FROM v_next;
  END LOOP;
END;
$do$;

UPDATE public.settings_versions sv
   SET value = s.cached_value,
       schema_version = COALESCE(sv.schema_version, 1),
       updated_at = now()
  FROM public.settings s
 WHERE sv.id = s.settings_version_id
   AND s.category = 'ui_navigation'
   AND s.scope_type = 'global'
   AND s.scope_id IS NULL
   AND (sv.value IS DISTINCT FROM s.cached_value OR sv.schema_version IS DISTINCT FROM 1);

SELECT pg_advisory_unlock(hashtext('202606042132_settings_global_default_schema_alignment_v1'));

COMMIT;
