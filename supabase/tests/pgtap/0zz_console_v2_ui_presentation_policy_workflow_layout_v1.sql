-- Console V2 workflow UI policy must be present in the canonical settings row.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(11);

SELECT is(
  (
    SELECT sv.schema_version
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_presentation_policy'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
  ),
  3,
  'ui_presentation_policy cached row points at schema version 3'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_presentation_policy'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
       AND sv.category = s.category
       AND sv.scope_type = s.scope_type
       AND sv.scope_id IS NULL
       AND sv.approved_at IS NOT NULL
  ),
  'ui_presentation_policy current settings version is approved'
);

SELECT is(
  (
    SELECT cached_value #>> '{workflow_canvas_layout,node_w}'
      FROM public.settings
     WHERE category = 'ui_presentation_policy'
       AND scope_type = 'global'
       AND scope_id IS NULL
  ),
  '220',
  'workflow canvas node width is seeded'
);

SELECT is(
  (
    SELECT cached_value #>> '{workflow_canvas_layout,workflow_canvas_node_right_gutter_px}'
      FROM public.settings
     WHERE category = 'ui_presentation_policy'
       AND scope_type = 'global'
       AND scope_id IS NULL
  ),
  '60',
  'workflow canvas right gutter is seeded'
);

SELECT is(
  (
    SELECT cached_value #>> '{workflow_canvas_layout,workflow_canvas_empty_width_px}'
      FROM public.settings
     WHERE category = 'ui_presentation_policy'
       AND scope_type = 'global'
       AND scope_id IS NULL
  ),
  '400',
  'workflow canvas empty width is seeded'
);

SELECT is(
  (
    SELECT cached_value #>> '{workflow_replay_animation,cursor_release_ms}'
      FROM public.settings
     WHERE category = 'ui_presentation_policy'
       AND scope_type = 'global'
       AND scope_id IS NULL
  ),
  '800',
  'workflow replay animation policy is seeded'
);

SELECT is(
  (
    SELECT cached_value #>> '{workflow_drawer_open_delay_ms}'
      FROM public.settings
     WHERE category = 'ui_presentation_policy'
       AND scope_type = 'global'
       AND scope_id IS NULL
  ),
  '200',
  'workflow drawer delay is seeded'
);

SELECT is(
  (
    SELECT cached_value #>> '{sla_tick_interval_ms}'
      FROM public.settings
     WHERE category = 'ui_presentation_policy'
       AND scope_type = 'global'
       AND scope_id IS NULL
  ),
  '1000',
  'workflow SLA tick interval is seeded'
);

SELECT is(
  (
    SELECT cached_value #>> '{decision_trail_stale_ms}'
      FROM public.settings
     WHERE category = 'ui_presentation_policy'
       AND scope_type = 'global'
       AND scope_id IS NULL
  ),
  '15000',
  'decision trail stale budget is seeded'
);

SELECT is(
  (
    SELECT cached_value #>> '{task_snooze,options,0,duration_seconds}'
      FROM public.settings
     WHERE category = 'ui_presentation_policy'
       AND scope_type = 'global'
       AND scope_id IS NULL
  ),
  '3600',
  'task snooze options carry canonical duration seconds'
);

SELECT ok(
  (
    SELECT jsonb_array_length(cached_value->'duration_buckets')
      FROM public.settings
     WHERE category = 'ui_presentation_policy'
       AND scope_type = 'global'
       AND scope_id IS NULL
  ) >= 3,
  'duration bucket ladder is seeded'
);

SELECT * FROM finish();

ROLLBACK;
