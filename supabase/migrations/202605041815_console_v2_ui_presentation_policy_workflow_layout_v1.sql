-- Console V2 workflow authoring requires the complete workflow UI policy
-- slice at runtime. The frontend intentionally fails loud when these values
-- are absent, so shared/local databases must seed the canonical settings row
-- instead of falling back to literals in React.

BEGIN;
SET search_path TO public, extensions, pg_temp;

DO $$
DECLARE
  v_patch jsonb := '{
    "task_snooze":{
      "default_key":"1h",
      "options":[
        {"value":"1h","label":"1 hour","duration_seconds":3600},
        {"value":"4h","label":"4 hours","duration_seconds":14400},
        {"value":"1d","label":"1 day","duration_seconds":86400},
        {"value":"3d","label":"3 days","duration_seconds":259200}
      ]
    },
    "workflow_replay_animation":{
      "cursor_min_ms":120,
      "cursor_default_ms":200,
      "cursor_divisor":4,
      "cursor_release_ms":800,
      "autoplay_delay_ms":400,
      "fallback_step_ms":100
    },
    "workflow_canvas_layout":{
      "node_w":220,
      "node_h":78,
      "col_gap":60,
      "row_gap":26,
      "test_trace_max_width":160,
      "test_trace_divisor":2,
      "test_trace_default_height_px":6,
      "workflow_canvas_node_right_gutter_px":60,
      "workflow_canvas_empty_width_px":400
    },
    "workflow_drawer_open_delay_ms":200,
    "sla_tick_interval_ms":1000,
    "decision_trail_stale_ms":15000,
    "duration_buckets":[
      {"unit":"d","threshold_ms":86400000,"label":"d"},
      {"unit":"h","threshold_ms":3600000,"label":"h"},
      {"unit":"m","threshold_ms":60000,"label":"m"}
    ],
    "overdue_label":"overdue"
  }'::jsonb;
  v_schema jsonb := '{
    "type":"object",
    "properties":{
      "toast":{"type":"object","properties":{
        "duration_ms":{"type":"integer","minimum":500},
        "icon_for_tone":{"type":"object"}
      },"required":["duration_ms","icon_for_tone"]},
      "expiry_thresholds":{"type":"object","properties":{
        "warn_days":{"type":"integer","minimum":0},
        "danger_days":{"type":"integer","minimum":0}
      },"required":["warn_days","danger_days"]},
      "task_snooze":{"type":"object","properties":{
        "default_key":{"type":"string"},
        "options":{"type":"array","items":{"type":"object","properties":{
          "value":{"type":"string"},
          "label":{"type":"string"},
          "duration_seconds":{"type":"integer","minimum":1}
        },"required":["value","label","duration_seconds"]}}
      },"required":["default_key","options"]},
      "timeline_buckets":{"type":"object","properties":{
        "labels":{"type":"object"},
        "order":{"type":"array"}
      },"required":["labels","order"]},
      "workflow_replay_animation":{"type":"object","properties":{
        "cursor_min_ms":{"type":"integer","minimum":1},
        "cursor_default_ms":{"type":"integer","minimum":1},
        "cursor_divisor":{"type":"integer","minimum":1},
        "cursor_release_ms":{"type":"integer","minimum":1},
        "autoplay_delay_ms":{"type":"integer","minimum":1},
        "fallback_step_ms":{"type":"integer","minimum":1}
      },"required":["cursor_min_ms","cursor_default_ms","cursor_divisor","cursor_release_ms","autoplay_delay_ms","fallback_step_ms"]},
      "workflow_canvas_layout":{"type":"object","properties":{
        "node_w":{"type":"integer","minimum":1},
        "node_h":{"type":"integer","minimum":1},
        "col_gap":{"type":"integer","minimum":1},
        "row_gap":{"type":"integer","minimum":1},
        "test_trace_max_width":{"type":"integer","minimum":1},
        "test_trace_divisor":{"type":"integer","minimum":1},
        "test_trace_default_height_px":{"type":"integer","minimum":1},
        "workflow_canvas_node_right_gutter_px":{"type":"integer","minimum":1},
        "workflow_canvas_empty_width_px":{"type":"integer","minimum":1}
      },"required":["node_w","node_h","col_gap","row_gap","test_trace_max_width","test_trace_divisor","test_trace_default_height_px","workflow_canvas_node_right_gutter_px","workflow_canvas_empty_width_px"]},
      "workflow_drawer_open_delay_ms":{"type":"integer","minimum":0},
      "sla_tick_interval_ms":{"type":"integer","minimum":1},
      "decision_trail_stale_ms":{"type":"integer","minimum":0},
      "duration_buckets":{"type":"array","items":{"type":"object","properties":{
        "unit":{"type":"string"},
        "threshold_ms":{"type":"integer","minimum":1},
        "label":{"type":"string"}
      },"required":["unit","threshold_ms","label"]}},
      "overdue_label":{"type":"string"}
    },
    "required":["toast","expiry_thresholds","task_snooze","timeline_buckets","workflow_replay_animation","workflow_canvas_layout","workflow_drawer_open_delay_ms","sla_tick_interval_ms","decision_trail_stale_ms","duration_buckets","overdue_label"]
  }'::jsonb;
  v_base_value jsonb;
  v_next_value jsonb;
  v_next_version integer;
  v_settings_version_id uuid;
BEGIN
  INSERT INTO public.settings_category_registry (
    category,
    description,
    requires_schema,
    requires_global_default,
    side_effecting,
    safe_missing_behavior,
    allowed_scopes
  )
  VALUES (
    'ui_presentation_policy',
    'Canonical UX-presentation defaults consumed by strict Console V2 surfaces, including workflow canvas, replay, SLA, toast, expiry, snooze, and timeline presentation policy.',
    TRUE,
    TRUE,
    FALSE,
    'skip',
    '["global","tenant"]'::jsonb
  )
  ON CONFLICT (category) DO UPDATE
  SET description = EXCLUDED.description,
      requires_schema = TRUE,
      requires_global_default = TRUE,
      side_effecting = FALSE,
      safe_missing_behavior = 'skip',
      allowed_scopes = EXCLUDED.allowed_scopes;

  INSERT INTO public.schema_registry (
    category,
    version,
    schema,
    description,
    examples,
    is_active
  )
  VALUES (
    'ui_presentation_policy',
    3,
    v_schema,
    'Canonical Console V2 UI presentation policy schema with workflow authoring layout/runtime slices.',
    jsonb_build_array('{
      "toast":{"duration_ms":3200,"icon_for_tone":{"good":"check","warn":"bell","danger":"warn","info":"bell"}},
      "expiry_thresholds":{"warn_days":30,"danger_days":7},
      "timeline_buckets":{"labels":{"today":"Today","yesterday":"Yesterday","this_week":"This week","earlier":"Earlier"},"order":["today","yesterday","this_week","earlier"]}
    }'::jsonb || v_patch),
    TRUE
  )
  ON CONFLICT (category, version) DO UPDATE
  SET schema = EXCLUDED.schema,
      description = EXCLUDED.description,
      examples = EXCLUDED.examples,
      is_active = TRUE;

  UPDATE public.schema_registry
     SET is_active = FALSE,
         deprecated_at = COALESCE(deprecated_at, now())
   WHERE category = 'ui_presentation_policy'
     AND version <> 3
     AND is_active IS TRUE;

  SELECT COALESCE(s.cached_value, sv.value, '{
      "toast":{"duration_ms":3200,"icon_for_tone":{"good":"check","warn":"bell","danger":"warn","info":"bell"}},
      "expiry_thresholds":{"warn_days":30,"danger_days":7},
      "timeline_buckets":{"labels":{"today":"Today","yesterday":"Yesterday","this_week":"This week","earlier":"Earlier"},"order":["today","yesterday","this_week","earlier"]}
    }'::jsonb)
    INTO v_base_value
    FROM (SELECT 1) anchor
    LEFT JOIN LATERAL (
      SELECT cached_value
        FROM public.settings
       WHERE category = 'ui_presentation_policy'
         AND scope_type = 'global'
         AND scope_id IS NULL
       ORDER BY last_updated DESC NULLS LAST
       LIMIT 1
    ) s ON TRUE
    LEFT JOIN LATERAL (
      SELECT value
        FROM public.settings_versions
       WHERE category = 'ui_presentation_policy'
         AND scope_type = 'global'
         AND scope_id IS NULL
       ORDER BY version DESC
       LIMIT 1
    ) sv ON TRUE;

  v_next_value := COALESCE(v_base_value, '{}'::jsonb) || v_patch;

  IF EXISTS (
    SELECT 1
      FROM public.settings s
     WHERE s.category = 'ui_presentation_policy'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
       AND s.cached_value @> v_patch
  ) THEN
    UPDATE public.settings s
       SET cached_value = v_next_value,
           last_updated = now()
     WHERE s.category = 'ui_presentation_policy'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
    RETURNING settings_version_id INTO v_settings_version_id;

    UPDATE public.settings_versions sv
       SET value = v_next_value,
           schema_version = 3,
           change_reason = 'Refresh ui_presentation_policy workflow authoring policy slice',
           approved_at = COALESCE(approved_at, now()),
           effective_from = COALESCE(effective_from, now())
     WHERE sv.id = v_settings_version_id;

    RETURN;
  END IF;

  SELECT COALESCE(MAX(version), 0) + 1
    INTO v_next_version
    FROM public.settings_versions
   WHERE category = 'ui_presentation_policy'
     AND scope_type = 'global'
     AND scope_id IS NULL;

  UPDATE public.settings_versions
     SET effective_until = now()
   WHERE category = 'ui_presentation_policy'
     AND scope_type = 'global'
     AND scope_id IS NULL
     AND effective_until IS NULL
     AND approved_at IS NOT NULL;

  INSERT INTO public.settings_versions (
    category,
    scope_type,
    scope_id,
    scope_hash,
    version,
    value,
    schema_version,
    change_reason,
    approved_at,
    effective_from
  )
  VALUES (
    'ui_presentation_policy',
    'global',
    NULL,
    '00000000-0000-0000-0000-000000000000'::uuid,
    v_next_version,
    v_next_value,
    3,
    'Seed Console V2 workflow authoring UI presentation policy slice',
    now(),
    now()
  )
  RETURNING id INTO v_settings_version_id;

  INSERT INTO public.settings (
    category,
    scope_type,
    scope_id,
    scope_hash,
    settings_version_id,
    cached_value,
    last_updated
  )
  VALUES (
    'ui_presentation_policy',
    'global',
    NULL,
    '00000000-0000-0000-0000-000000000000'::uuid,
    v_settings_version_id,
    v_next_value,
    now()
  )
  ON CONFLICT (category, scope_type, scope_hash) DO UPDATE
  SET settings_version_id = EXCLUDED.settings_version_id,
      cached_value = EXCLUDED.cached_value,
      last_updated = now();
END $$;

COMMIT;
