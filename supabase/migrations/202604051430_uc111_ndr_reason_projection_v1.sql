-- Plan: B09 Exception, reattempt & returns loop
-- Migration: UC111 dispatch exception reason projection v1
-- Date: 2026-04-05
--
-- Purpose:
--   - Persist the route-stop dispatch exception reason on follow-up dispatch_exception_review tasks.
--   - Project that reason through the UC114 NDR breach/read model.
--   - Surface the reason label through the task-backed UI registry contract.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604051430_uc111_ndr_reason_projection_v1'));
SET search_path TO public, api, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.create_task_system_v1(
  p_payload JSONB
)
RETURNS TABLE (
  task_id UUID,
  task_event_id UUID,
  workflow_run_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_input JSONB := COALESCE(p_payload, '{}'::jsonb);
  v_claims JSONB := NULL;
  v_role TEXT := NULL;

  v_task_type_key TEXT := NULL;
  v_context JSONB := '{}'::jsonb;
  v_resource_type TEXT := NULL;
  v_resource_id UUID := NULL;
  v_queue_key TEXT := NULL;
  v_priority INT := NULL;
  v_sla_minutes INT := NULL;
  v_idempotency_key TEXT := NULL;
  v_metadata JSONB := '{}'::jsonb;
  v_actor_system TEXT := NULL;
  v_dispatch_exception_reason TEXT := NULL;

  v_prev_actor_system TEXT := COALESCE(current_setting('app.actor_system', true), '');
  v_prev_claims TEXT := COALESCE(current_setting('request.jwt.claims', true), '');
  v_prev_role TEXT := COALESCE(current_setting('request.jwt.claim.role', true), '');
  v_prev_sub TEXT := COALESCE(current_setting('request.jwt.claim.sub', true), '');
  v_service_claims JSONB := '{}'::jsonb;
  v_org_id UUID := NULL;
  v_task_type RECORD;
  v_assignment_defaults JSONB := '{}'::jsonb;
BEGIN
  IF jsonb_typeof(v_input) <> 'object' THEN
    RAISE EXCEPTION 'create_task_system_v1 expects JSON object input' USING ERRCODE = '23514';
  END IF;

  BEGIN
    v_claims := current_setting('request.jwt.claims', true)::jsonb;
  EXCEPTION
    WHEN others THEN
      v_claims := NULL;
  END;
  v_role := NULLIF(btrim(COALESCE(v_claims->>'role', '')), '');

  IF session_user IS DISTINCT FROM 'postgres'
     AND session_user IS DISTINCT FROM 'supabase_admin'
     AND v_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'create_task_system_v1 requires service_role context';
  END IF;

  v_task_type_key := lower(NULLIF(btrim(COALESCE(v_input->>'task_type_key', '')), ''));
  IF v_task_type_key IS NULL THEN
    RAISE EXCEPTION 'create_task_system_v1 requires task_type_key' USING ERRCODE = '23514';
  END IF;

  v_context := COALESCE(v_input->'context', '{}'::jsonb);
  v_resource_type := NULLIF(btrim(COALESCE(v_input->>'resource_type', '')), '');
  BEGIN v_resource_id := NULLIF(v_input->>'resource_id', '')::uuid; EXCEPTION WHEN others THEN v_resource_id := NULL; END;
  v_queue_key := NULLIF(btrim(COALESCE(v_input->>'queue_key', '')), '');
  BEGIN v_priority := NULLIF(v_input->>'priority', '')::int; EXCEPTION WHEN others THEN v_priority := NULL; END;
  BEGIN v_sla_minutes := NULLIF(v_input->>'sla_minutes', '')::int; EXCEPTION WHEN others THEN v_sla_minutes := NULL; END;
  v_idempotency_key := NULLIF(btrim(COALESCE(v_input->>'idempotency_key', '')), '');
  v_metadata := COALESCE(v_input->'metadata', '{}'::jsonb);
  v_actor_system := NULLIF(btrim(COALESCE(v_input->>'actor_system', '')), '');

  BEGIN
    v_org_id := NULLIF(v_context->>'organization_id', '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_org_id := NULL;
  END;

  IF v_org_id IS NOT NULL THEN
    PERFORM public.ensure_task_type_from_catalog_v1(v_org_id, v_task_type_key, v_context);

    SELECT
      tt.id,
      tt.default_queue_key,
      tt.metadata
      INTO v_task_type
      FROM public.task_types tt
     WHERE tt.organization_id = v_org_id
       AND tt.key = v_task_type_key
     LIMIT 1;

    IF jsonb_typeof(COALESCE(v_task_type.metadata, '{}'::jsonb)) = 'object'
       AND jsonb_typeof(COALESCE(v_task_type.metadata, '{}'::jsonb)->'assignment_defaults') = 'object' THEN
      v_assignment_defaults := COALESCE(v_task_type.metadata, '{}'::jsonb)->'assignment_defaults';
    END IF;

    IF v_queue_key IS NULL THEN
      v_queue_key := NULLIF(btrim(COALESCE(v_assignment_defaults->>'queue_key', '')), '');
    END IF;

    IF v_sla_minutes IS NULL THEN
      BEGIN
        v_sla_minutes := NULLIF(v_assignment_defaults->>'sla_minutes', '')::int;
      EXCEPTION
        WHEN others THEN
          v_sla_minutes := NULL;
      END;
    END IF;

    IF jsonb_typeof(v_metadata) IS DISTINCT FROM 'object' THEN
      v_metadata := '{}'::jsonb;
    END IF;

    IF jsonb_typeof(COALESCE(v_metadata->'assignment_defaults', 'null'::jsonb)) IS DISTINCT FROM 'object'
       AND jsonb_typeof(v_assignment_defaults) = 'object'
       AND v_assignment_defaults <> '{}'::jsonb THEN
      v_metadata := jsonb_set(v_metadata, '{assignment_defaults}', v_assignment_defaults, TRUE);
    END IF;
  END IF;

  IF jsonb_typeof(v_metadata) IS DISTINCT FROM 'object' THEN
    v_metadata := '{}'::jsonb;
  END IF;

  IF v_task_type_key = 'dispatch_exception_review' THEN
    v_dispatch_exception_reason := NULLIF(
      btrim(
        COALESCE(
          v_metadata->>'dispatch_exception_reason',
          v_context->>'dispatch_exception_reason',
          v_context->>'outcome_reason',
          v_input->>'status_reason',
          ''
        )
      ),
      ''
    );

    IF v_dispatch_exception_reason IS NOT NULL THEN
      v_metadata := jsonb_strip_nulls(
        COALESCE(v_metadata, '{}'::jsonb)
        || jsonb_build_object('dispatch_exception_reason', v_dispatch_exception_reason)
      );
    END IF;
  END IF;

  v_service_claims := COALESCE(v_claims, '{}'::jsonb);
  IF jsonb_typeof(v_service_claims) IS DISTINCT FROM 'object' THEN
    v_service_claims := '{}'::jsonb;
  END IF;
  v_service_claims := (v_service_claims - 'sub') || jsonb_build_object('role', 'service_role');

  PERFORM set_config('app.actor_system', COALESCE(v_actor_system, ''), true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', v_service_claims::text, true);
  BEGIN
    RETURN QUERY
    SELECT *
    FROM public.create_task_v1(
      v_task_type_key,
      v_context,
      v_resource_type,
      v_resource_id,
      v_queue_key,
      v_priority,
      v_sla_minutes,
      v_idempotency_key,
      v_metadata
    );
  EXCEPTION
    WHEN others THEN
      PERFORM set_config('request.jwt.claims', v_prev_claims, true);
      PERFORM set_config('request.jwt.claim.role', v_prev_role, true);
      PERFORM set_config('request.jwt.claim.sub', v_prev_sub, true);
      PERFORM set_config('app.actor_system', v_prev_actor_system, true);
      RAISE;
  END;

  PERFORM set_config('request.jwt.claims', v_prev_claims, true);
  PERFORM set_config('request.jwt.claim.role', v_prev_role, true);
  PERFORM set_config('request.jwt.claim.sub', v_prev_sub, true);
  PERFORM set_config('app.actor_system', v_prev_actor_system, true);
END;
$$;

COMMENT ON FUNCTION public.create_task_system_v1(JSONB)
  IS 'Service-only wrapper to create a task via create_task_v1, preserving task-type assignment defaults and projecting dispatch_exception_reason from workflow context for dispatch_exception_review tasks.';

CREATE OR REPLACE FUNCTION public.tasks_project_dispatch_exception_reason_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_task_type_key TEXT := lower(NULLIF(btrim(COALESCE(NEW.task_type_key, '')), ''));
  v_dispatch_exception_reason TEXT := NULL;
BEGIN
  IF v_task_type_key IS NULL AND NEW.task_type_id IS NOT NULL THEN
    SELECT lower(NULLIF(btrim(COALESCE(tt.key, '')), ''))
      INTO v_task_type_key
      FROM public.task_types tt
     WHERE tt.id = NEW.task_type_id
     LIMIT 1;
  END IF;

  IF v_task_type_key <> 'dispatch_exception_review' THEN
    RETURN NEW;
  END IF;

  IF jsonb_typeof(NEW.metadata) IS DISTINCT FROM 'object' THEN
    NEW.metadata := '{}'::jsonb;
  END IF;

  v_dispatch_exception_reason := NULLIF(
    btrim(
      COALESCE(
        NEW.metadata->>'dispatch_exception_reason',
        NEW.metadata->>'status_reason',
        NEW.status_reason,
        ''
      )
    ),
    ''
  );

  IF v_dispatch_exception_reason IS NULL THEN
    RETURN NEW;
  END IF;

  IF NULLIF(btrim(COALESCE(NEW.status_reason, '')), '') IS NULL THEN
    NEW.status_reason := v_dispatch_exception_reason;
  END IF;

  IF NULLIF(btrim(COALESCE(NEW.metadata->>'dispatch_exception_reason', '')), '') IS NULL THEN
    NEW.metadata := jsonb_strip_nulls(
      NEW.metadata || jsonb_build_object('dispatch_exception_reason', v_dispatch_exception_reason)
    );
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.tasks_project_dispatch_exception_reason_v1()
  IS 'Projects dispatch_exception_reason from task metadata onto dispatch_exception_review task rows so NDR queues/read models can filter and display it durably.';

DROP TRIGGER IF EXISTS trg_tasks_project_dispatch_exception_reason_v1 ON public.tasks;
CREATE TRIGGER trg_tasks_project_dispatch_exception_reason_v1
  BEFORE INSERT OR UPDATE OF task_type_id, task_type_key, status_reason, metadata
  ON public.tasks
  FOR EACH ROW
  EXECUTE FUNCTION public.tasks_project_dispatch_exception_reason_v1();

UPDATE public.tasks t
   SET status_reason = v.dispatch_exception_reason,
       metadata = CASE
         WHEN NULLIF(btrim(COALESCE(t.metadata->>'dispatch_exception_reason', '')), '') IS NULL
           THEN jsonb_strip_nulls(
             COALESCE(t.metadata, '{}'::jsonb)
             || jsonb_build_object('dispatch_exception_reason', v.dispatch_exception_reason)
           )
         ELSE COALESCE(t.metadata, '{}'::jsonb)
       END,
       updated_at = now()
  FROM (
    SELECT
      id,
      NULLIF(
        btrim(
          COALESCE(
            metadata->>'dispatch_exception_reason',
            metadata->>'status_reason',
            status_reason,
            ''
          )
        ),
        ''
      ) AS dispatch_exception_reason
    FROM public.tasks
    WHERE lower(COALESCE(task_type_key, '')) = 'dispatch_exception_review'
  ) AS v
 WHERE t.id = v.id
   AND v.dispatch_exception_reason IS NOT NULL
   AND (
     NULLIF(btrim(COALESCE(t.status_reason, '')), '') IS NULL
     OR NULLIF(btrim(COALESCE(t.metadata->>'dispatch_exception_reason', '')), '') IS NULL
   );

CREATE OR REPLACE VIEW public.dispatch_exception_review_sla_breaches_v
WITH (security_invoker = true) AS
SELECT
  t.id,
  t.organization_id,
  t.client_id,
  t.sender_id,
  t.resource_type,
  t.resource_id,
  t.status,
  t.queue_key,
  t.assigned_to,
  t.assigned_at,
  t.sla_minutes,
  t.sla_due_at,
  t.sla_breached_at,
  GREATEST(CEIL(EXTRACT(EPOCH FROM (COALESCE(t.sla_breached_at, now()) - t.sla_due_at)) / 60.0)::INT, 0) AS overdue_minutes,
  t.created_at,
  t.updated_at,
  COALESCE(
    NULLIF(btrim(COALESCE(t.metadata->>'dispatch_exception_reason', '')), ''),
    NULLIF(btrim(COALESCE(t.status_reason, '')), '')
  ) AS dispatch_exception_reason
FROM public.tasks t
WHERE t.task_type_key = 'dispatch_exception_review'
  AND t.sla_due_at IS NOT NULL
  AND t.sla_breached_at IS NOT NULL;

CREATE OR REPLACE VIEW api.dispatch_exception_review_sla_breaches_v
WITH (security_invoker = true) AS
SELECT *
FROM public.dispatch_exception_review_sla_breaches_v;

DO $do$
DECLARE
  v_row RECORD;
  v_current JSONB := NULL;
  v_resources JSONB := '[]'::jsonb;
  v_next_resources JSONB := '[]'::jsonb;
  v_resource JSONB := NULL;
  v_key TEXT := NULL;
  v_labels JSONB := '{}'::jsonb;
BEGIN
  FOR v_row IN
    SELECT
      s.id AS settings_id,
      s.settings_version_id,
      sv.version,
      sv.value
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_read_registry'
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    v_resources := COALESCE(v_current->'resources', '[]'::jsonb);
    IF jsonb_typeof(v_resources) IS DISTINCT FROM 'array' THEN
      v_resources := '[]'::jsonb;
    END IF;

    v_next_resources := '[]'::jsonb;
    FOR v_resource IN
      SELECT value
      FROM jsonb_array_elements(v_resources) AS value
    LOOP
      v_key := lower(NULLIF(btrim(COALESCE(v_resource->>'key', '')), ''));
      IF v_key IN (
        'tasks',
        'dispatch_exception_review',
        'dispatch_exception_review_mine',
        'unassigned_exceptions',
        'sla_deadline_alerts'
      ) THEN
        v_labels := COALESCE(v_resource->'column_labels', '{}'::jsonb);
        IF jsonb_typeof(v_labels) IS DISTINCT FROM 'object' THEN
          v_labels := '{}'::jsonb;
        END IF;

        v_labels := jsonb_set(
          v_labels,
          '{status_reason}',
          to_jsonb('Dispatch exception reason'::text),
          TRUE
        );

        v_resource := jsonb_set(v_resource, '{column_labels}', v_labels, TRUE);
      END IF;

      v_next_resources := v_next_resources || jsonb_build_array(v_resource);
    END LOOP;

    IF v_next_resources IS DISTINCT FROM v_resources THEN
      UPDATE public.settings_versions
         SET value = jsonb_set(v_current, '{resources}', v_next_resources, TRUE),
             version = v_row.version + 1,
             change_reason = 'Project dispatch exception reason label onto task-backed NDR resources.',
             approved_at = workflow_now(),
             effective_from = workflow_now()
       WHERE id = v_row.settings_version_id;

      UPDATE public.settings
         SET cached_value = jsonb_set(v_current, '{resources}', v_next_resources, TRUE),
             last_updated = workflow_now()
       WHERE id = v_row.settings_id;
    END IF;
  END LOOP;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202604051430_uc111_ndr_reason_projection_v1'));
COMMIT;
