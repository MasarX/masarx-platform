-- Expose the narrow route-stop discriminator required by FieldOps task actions.
BEGIN;
SET LOCAL lock_timeout = '30s';
SET LOCAL search_path TO public, extensions, pg_temp;
SELECT pg_advisory_xact_lock(hashtext('20260919003000_tasks_controls_stop_kind_v1'));

DROP VIEW IF EXISTS api.tasks_controls_v1;
CREATE VIEW api.tasks_controls_v1 WITH (security_invoker = true) AS
WITH task_projection AS (
 SELECT
   t.*,
   CASE
     WHEN t.resource_type = 'route_stop' AND stop_rr.id IS NOT NULL
       THEN rs.planned_window_start_at
     WHEN t.resource_type = 'route_run' AND direct_rr.id IS NOT NULL
       THEN direct_rr.planned_start_at
     ELSE NULL
   END AS planned_at,
   COALESCE(
     NULLIF(t.metadata->>'area', ''),
     NULLIF(t.metadata#>>'{address,district}', ''),
     NULLIF(t.metadata#>>'{address,city}', ''),
     NULLIF(t.metadata->>'city', ''),
     ''
   ) AS area,
   COALESCE(
     NULLIF(t.metadata->>'reference', ''),
     NULLIF(t.metadata#>>'{customer,reference}', ''),
     t.id::text
   ) AS sort_code
 FROM public.tasks t
 LEFT JOIN public.route_stops rs
   ON t.resource_type = 'route_stop'
  AND t.resource_id = rs.id
  AND t.organization_id = rs.organization_id
  AND (t.client_id IS NULL OR t.client_id = rs.client_id)
 LEFT JOIN public.route_runs stop_rr
   ON t.resource_type = 'route_stop'
  AND stop_rr.id = rs.route_run_id
  AND stop_rr.organization_id = rs.organization_id
  AND public.route_run_actor_can_read_v1(stop_rr.organization_id, stop_rr.id, stop_rr.driver_user_id)
 LEFT JOIN public.route_runs direct_rr
   ON t.resource_type = 'route_run'
  AND t.resource_id = direct_rr.id
  AND t.organization_id = direct_rr.organization_id
  AND public.route_run_actor_can_read_v1(direct_rr.organization_id, direct_rr.id, direct_rr.driver_user_id)
 WHERE auth.role() = 'service_role'
    OR (
      public.user_has_capability_v1(
        'tasks.read',
        public.current_user_scope_type(),
        public.current_user_scope_id()
      )
      AND (
        public.is_platform_user()
        OR (
          public.current_user_scope_type() = 'tenant'
          AND t.organization_id = public.current_user_org_id()
        )
        OR (
          public.current_user_scope_type() = 'client'
          AND t.client_id = public.current_user_client_id()
        )
        OR (
          public.current_user_scope_type() = 'sender'
          AND t.sender_id = public.current_user_sender_id()
        )
      )
    )
), classified AS (
 SELECT task_projection.*,
   CASE
     WHEN planned_at IS NULL THEN 'later'
     WHEN planned_at <= statement_timestamp() + INTERVAL '60 minutes' THEN 'now'
     WHEN planned_at::date = CURRENT_DATE THEN 'today'
     ELSE 'later'
   END AS urgency
 FROM task_projection
)
SELECT classified.*,
 CASE classified.urgency WHEN 'now' THEN 0 WHEN 'today' THEN 1 ELSE 2 END AS urgency_order,
 jsonb_build_array(CASE classified.urgency WHEN 'now' THEN 0 WHEN 'today' THEN 1 ELSE 2 END,
   -classified.priority::numeric, CASE WHEN classified.planned_at IS NULL THEN 1 ELSE 0 END,
   COALESCE(extract(epoch FROM classified.planned_at),0), classified.sort_code, classified.id::text) AS smart_order,
 jsonb_build_array(-classified.priority::numeric, classified.sort_code, classified.id::text) AS sort_priority,
 jsonb_build_array(CASE WHEN classified.planned_at IS NULL THEN 1 ELSE 0 END,
   COALESCE(extract(epoch FROM classified.planned_at),0), classified.sort_code, classified.id::text) AS sort_eta,
 jsonb_build_array(classified.area, classified.sort_code, classified.id::text) AS sort_area,
 CASE WHEN classified.urgency = 'now' THEN 1 ELSE 0 END AS urgency_now,
 CASE WHEN classified.urgency = 'today' THEN 1 ELSE 0 END AS urgency_today,
 CASE WHEN classified.urgency = 'later' THEN 1 ELSE 0 END AS urgency_later,
 NULLIF(btrim(COALESCE(classified.metadata->>'reference', classified.metadata#>>'{customer,reference}', '')), '') AS reference,
 CASE
   WHEN classified.resource_type = 'route_stop' AND exposed_rr.id IS NOT NULL
     THEN exposed_rs.stop_kind
   ELSE NULL
 END AS stop_kind
FROM classified
LEFT JOIN public.route_stops exposed_rs
  ON classified.resource_type = 'route_stop'
 AND classified.resource_id = exposed_rs.id
 AND classified.organization_id = exposed_rs.organization_id
 AND (classified.client_id IS NULL OR classified.client_id = exposed_rs.client_id)
LEFT JOIN public.route_runs exposed_rr
  ON classified.resource_type = 'route_stop'
 AND exposed_rr.id = exposed_rs.route_run_id
 AND exposed_rr.organization_id = exposed_rs.organization_id
 AND public.route_run_actor_can_read_v1(exposed_rr.organization_id, exposed_rr.id, exposed_rr.driver_user_id);

REVOKE ALL ON api.tasks_controls_v1 FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON api.tasks_controls_v1 TO authenticated, service_role;
COMMENT ON VIEW api.tasks_controls_v1 IS
  'Actor-scoped task read model with canonical route timing, control sorting, urgency metrics, narrow display reference, and actor-visible route-stop kind.';

DO $registry$
DECLARE
 v_row RECORD;
 v_task JSONB;
 v_next JSONB;
 v_resources JSONB;
 v_select JSONB;
 v_promoted INTEGER := 0;
BEGIN
 FOR v_row IN
   SELECT s.id AS settings_id, s.settings_version_id, s.category, s.scope_type,
     s.scope_id, s.scope_hash, s.cached_value, sv.value, sv.schema_version
   FROM public.settings s
   JOIN public.settings_versions sv
     ON sv.id = s.settings_version_id AND sv.scope_hash = s.scope_hash
   WHERE s.category = 'ui_read_registry'
   ORDER BY s.id
   FOR UPDATE OF s, sv
 LOOP
   IF v_row.cached_value IS DISTINCT FROM v_row.value
      OR jsonb_typeof(v_row.value->'resources') IS DISTINCT FROM 'array' THEN
     RAISE EXCEPTION 'UI read registry settings pair is inconsistent: %', v_row.settings_id;
   END IF;

   SELECT item INTO v_task
   FROM jsonb_array_elements(v_row.value->'resources') item
   WHERE item->>'key' = 'tasks';
   IF NOT FOUND THEN CONTINUE; END IF;

   IF (SELECT count(*) FROM jsonb_array_elements(v_row.value->'resources') item WHERE item->>'key' = 'tasks') <> 1
      OR v_task->>'relation' IS DISTINCT FROM 'public.tasks'
      OR v_task->>'read_relation' IS DISTINCT FROM 'api.tasks_controls_v1'
      OR v_task->>'id_column' IS DISTINCT FROM 'id'
      OR v_task->>'capability_read' IS DISTINCT FROM 'tasks.read'
      OR v_task->'scope_columns' IS DISTINCT FROM '{"tenant":"organization_id","client":"client_id","sender":"sender_id"}'::jsonb THEN
     RAISE EXCEPTION 'task registry authority differs from the canonical contract: %', v_row.settings_id;
   END IF;

   SELECT COALESCE(jsonb_agg(value ORDER BY ord), '[]'::jsonb)
     INTO v_select
     FROM (
       SELECT value, min(ord) AS ord
       FROM jsonb_array_elements(COALESCE(v_task->'select', '[]'::jsonb) || '["stop_kind"]'::jsonb)
         WITH ORDINALITY selected(value, ord)
       GROUP BY value
     ) selected;

   v_task := jsonb_set(v_task, '{select}', v_select, TRUE);
   SELECT jsonb_agg(CASE WHEN item->>'key' = 'tasks' THEN v_task ELSE item END ORDER BY ord)
     INTO v_resources
     FROM jsonb_array_elements(v_row.value->'resources') WITH ORDINALITY r(item, ord);
   v_next := jsonb_set(v_row.value, '{resources}', v_resources);

   WITH closed AS (
     UPDATE public.settings_versions
        SET effective_until = GREATEST(clock_timestamp(), effective_from + INTERVAL '1 microsecond'),
            updated_at = clock_timestamp()
      WHERE id = v_row.settings_version_id
        AND scope_hash = v_row.scope_hash
        AND effective_until IS NULL
     RETURNING id
   ), inserted AS (
     INSERT INTO public.settings_versions(
       id, category, scope_type, scope_id, scope_hash, version, value,
       schema_version, change_reason, approved_at, effective_from
     )
     SELECT gen_random_uuid(), v_row.category, v_row.scope_type, v_row.scope_id, v_row.scope_hash,
       (SELECT COALESCE(MAX(candidate.version), 0) + 1
          FROM public.settings_versions candidate
         WHERE candidate.category = v_row.category
           AND candidate.scope_type = v_row.scope_type
           AND candidate.scope_hash = v_row.scope_hash),
       v_next, v_row.schema_version, 'Expose actor-visible task stop kind',
       clock_timestamp(), clock_timestamp()
     FROM closed
     RETURNING id, value
   )
   UPDATE public.settings s
      SET settings_version_id = inserted.id,
          cached_value = inserted.value,
          last_updated = clock_timestamp()
     FROM inserted
    WHERE s.id = v_row.settings_id
      AND s.settings_version_id = v_row.settings_version_id;
   IF NOT FOUND THEN
     RAISE EXCEPTION 'task registry stop-kind promotion lost pointer CAS';
   END IF;
   v_promoted := v_promoted + 1;
 END LOOP;

 IF v_promoted = 0 THEN
   RAISE EXCEPTION 'canonical task registry settings missing';
 END IF;
 DELETE FROM public.settings_cache WHERE cache_key LIKE 'ui_read_registry:%';
END;
$registry$;

COMMIT;
