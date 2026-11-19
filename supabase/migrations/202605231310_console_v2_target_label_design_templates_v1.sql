-- Console V2 Label Designer: target-neutral label design defaults.
-- Adds route/container/transfer templates to existing label_design settings
-- so target-label generation does not fail after selecting the correct
-- row-driven target label type.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605231310_console_v2_target_label_design_templates_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $target_label_design$
DECLARE
  v_row RECORD;
  v_next JSONB;
  v_templates JSONB;
  v_target RECORD;
  v_template JSONB;
  v_next_version INTEGER;
  v_new_settings_version_id UUID;
BEGIN
  FOR v_row IN
    SELECT
      s.id AS settings_id,
      s.settings_version_id,
      s.scope_type,
      s.scope_id,
      sv.schema_version,
      COALESCE(sv.value, s.cached_value, '{}'::jsonb) AS value
    FROM public.settings s
    JOIN public.settings_versions sv
      ON sv.id = s.settings_version_id
    WHERE s.category = 'label_design'
      AND COALESCE(sv.value, s.cached_value, '{}'::jsonb) ? 'templates'
  LOOP
    v_next := v_row.value;
    v_templates := COALESCE(v_next->'templates', '{}'::jsonb);

    FOR v_target IN
      SELECT *
      FROM (VALUES
        ('route'::text, 'Route label'::text, 'route_run'::text),
        ('container'::text, 'Container label'::text, 'handling_unit'::text),
        ('transfer'::text, 'Transfer label'::text, 'warehouse_transfer'::text)
      ) AS target(label_type, display_label, target_type)
    LOOP
      IF NOT (v_templates ? v_target.label_type) THEN
        v_template := jsonb_build_object(
          'page', jsonb_build_object(
            'dpi', 203,
            'width_inch', 4,
            'height_inch', 6,
            'margin_inch', 0.12,
            'orientation', 'portrait'
          ),
          'blocks', jsonb_build_array(
            jsonb_build_object(
              'type', 'text',
              'section_key', 'header',
              'x', 14,
              'y', 384,
              'width', 250,
              'height', 22,
              'font', 'Helvetica-Bold',
              'font_size', 16,
              'fallback', v_target.display_label,
              'value_path', 'target.target_type',
              'text_overflow', 'shrink'
            ),
            jsonb_build_object(
              'type', 'barcode',
              'section_key', 'barcode',
              'x', 14,
              'y', 308,
              'width', 250,
              'height', 64,
              'barcode_type', 'CODE128',
              'value_path', 'barcode',
              'fallback', 'TARGET',
              'human_readable', false
            ),
            jsonb_build_object(
              'type', 'text',
              'section_key', 'identifier',
              'x', 14,
              'y', 284,
              'width', 250,
              'height', 16,
              'font', 'Helvetica',
              'font_size', 10,
              'fallback', '',
              'value_path', 'target.target_id',
              'text_overflow', 'shrink'
            )
          ),
          'barcode', jsonb_build_object(
            'type', 'CODE128',
            'value_path', 'barcode',
            'human_readable', false
          ),
          'version', '2026-05-23',
          'label_type', v_target.label_type,
          'template_key', v_target.label_type,
          'max_attempts', 5,
          'retry_backoff_seconds', jsonb_build_array(45, 180, 600),
          'metadata', jsonb_build_object(
            'target_type', v_target.target_type,
            'description', format('Default %s target-neutral label design', v_target.display_label)
          )
        );

        v_templates := jsonb_set(v_templates, ARRAY[v_target.label_type], v_template, true);
      END IF;
    END LOOP;

    v_next := jsonb_set(v_next, '{templates}', v_templates, true);

    IF v_next IS DISTINCT FROM v_row.value THEN
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
       WHERE category = 'label_design'
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
        'label_design',
        v_row.scope_type,
        v_row.scope_id,
        v_next_version,
        v_next,
        COALESCE(v_row.schema_version, 2),
        'Add target-neutral label design templates for Console V2 Label Designer',
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
   WHERE cache_key LIKE 'label_design:%';
END;
$target_label_design$;

SELECT pg_advisory_unlock(hashtext('202605231310_console_v2_target_label_design_templates_v1'));

COMMIT;
