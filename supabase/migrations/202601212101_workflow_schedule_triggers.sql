-- Migration: Workflow schedule triggers (time-based workflow triggers)
-- Purpose: Enable Zapier/Make-style scheduled workflows via SSOT rows + a throttled worker.
-- Plan: PLAN-202601-workflow-studio-dnd / Step: S04

BEGIN;
SELECT pg_advisory_lock(hashtext('202601212101_workflow_schedule_triggers'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-- ---------------------------------------------------------------------------
-- 1) Schedule triggers SSOT
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.workflow_schedule_triggers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL DEFAULT 'tenant',
  scope_id UUID NOT NULL,
  workflow_template_id UUID NOT NULL REFERENCES public.workflow_templates(id) ON DELETE CASCADE,
  schedule JSONB NOT NULL DEFAULT '{}'::jsonb,
  context_patch JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  next_run_at TIMESTAMPTZ NOT NULL,
  last_run_at TIMESTAMPTZ,
  last_run_id UUID REFERENCES public.workflow_runs(id),
  last_error TEXT,
  last_error_at TIMESTAMPTZ,
  created_by UUID REFERENCES public.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes TEXT,
  CONSTRAINT workflow_schedule_triggers_scope_type_ck CHECK (scope_type IN ('tenant', 'client', 'sender')),
  CONSTRAINT workflow_schedule_triggers_schedule_object_ck CHECK (jsonb_typeof(schedule) = 'object'),
  CONSTRAINT workflow_schedule_triggers_context_object_ck CHECK (jsonb_typeof(context_patch) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_workflow_schedule_triggers_org_next_run
  ON public.workflow_schedule_triggers(organization_id, next_run_at)
  WHERE enabled = TRUE;

CREATE INDEX IF NOT EXISTS idx_workflow_schedule_triggers_template
  ON public.workflow_schedule_triggers(workflow_template_id);

CREATE INDEX IF NOT EXISTS idx_workflow_schedule_triggers_scope
  ON public.workflow_schedule_triggers(scope_type, scope_id);

COMMENT ON TABLE public.workflow_schedule_triggers
  IS 'Row-driven schedule triggers for workflows (Zapier/Make-style time-based triggers).';

-- Compute the next run timestamp from a schedule definition.
CREATE OR REPLACE FUNCTION public.workflow_schedule_trigger_next_run_at(
  p_schedule JSONB,
  p_reference TIMESTAMPTZ DEFAULT now()
)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_schedule JSONB := COALESCE(p_schedule, '{}'::jsonb);
  v_type TEXT := lower(COALESCE(NULLIF(v_schedule->>'type', ''), ''));
  v_timezone TEXT := public.workflow_schedule_timezone(v_schedule);
  v_interval_seconds INT;
  v_at_time TIME;
  v_days JSONB;
  v_day_value TEXT;
  v_day_int INT;
  v_allowed_days INT[] := ARRAY[]::INT[];
  v_local TIMESTAMP;
  v_local_date DATE;
  v_local_dow INT;
  v_candidate_local TIMESTAMP;
  v_candidate TIMESTAMPTZ;
  v_offset INT;
BEGIN
  IF v_type = 'interval' THEN
    v_interval_seconds := NULLIF(v_schedule->>'interval_seconds', '')::INT;
    IF v_interval_seconds IS NULL OR v_interval_seconds <= 0 THEN
      RAISE EXCEPTION 'workflow_schedule_trigger_next_run_at: interval_seconds must be > 0';
    END IF;
    RETURN p_reference + make_interval(secs => v_interval_seconds);
  END IF;

  IF v_type = 'daily' OR v_type = 'weekly' THEN
    BEGIN
      v_at_time := NULLIF(v_schedule->>'at_time', '')::time;
    EXCEPTION
      WHEN others THEN
        RAISE EXCEPTION 'workflow_schedule_trigger_next_run_at: at_time must be HH:MM';
    END;

    IF v_at_time IS NULL THEN
      RAISE EXCEPTION 'workflow_schedule_trigger_next_run_at: at_time is required for % schedule', v_type;
    END IF;

    v_local := p_reference AT TIME ZONE v_timezone;
    v_local_date := v_local::date;

    IF v_type = 'daily' THEN
      v_candidate_local := v_local_date::timestamp + v_at_time;
      v_candidate := timezone(v_timezone, v_candidate_local);
      IF v_candidate < p_reference THEN
        v_candidate_local := (v_local_date + 1)::timestamp + v_at_time;
        v_candidate := timezone(v_timezone, v_candidate_local);
      END IF;
      RETURN v_candidate;
    END IF;

    v_days := v_schedule->'days_of_week';
    IF v_days IS NULL OR jsonb_typeof(v_days) <> 'array' OR jsonb_array_length(v_days) = 0 THEN
      RAISE EXCEPTION 'workflow_schedule_trigger_next_run_at: days_of_week is required for weekly schedules';
    END IF;

    FOR v_day_value IN
      SELECT value::text
      FROM jsonb_array_elements_text(v_days)
    LOOP
      BEGIN
        v_day_int := v_day_value::INT;
      EXCEPTION
        WHEN others THEN
          v_day_int := NULL;
      END;
      IF v_day_int IS NULL OR v_day_int < 0 OR v_day_int > 6 THEN
        CONTINUE;
      END IF;
      IF NOT (v_day_int = ANY(v_allowed_days)) THEN
        v_allowed_days := array_append(v_allowed_days, v_day_int);
      END IF;
    END LOOP;

    IF array_length(v_allowed_days, 1) IS NULL THEN
      RAISE EXCEPTION 'workflow_schedule_trigger_next_run_at: days_of_week must contain values 0..6';
    END IF;

    v_local_dow := EXTRACT(DOW FROM v_local)::INT;
    FOR v_offset IN 0..13 LOOP
      IF ((v_local_dow + v_offset) % 7) = ANY(v_allowed_days) THEN
        v_candidate_local := (v_local_date + v_offset)::timestamp + v_at_time;
        v_candidate := timezone(v_timezone, v_candidate_local);
        IF v_candidate >= p_reference THEN
          RETURN v_candidate;
        END IF;
      END IF;
    END LOOP;

    -- Fallback: push a week ahead on the earliest allowed day.
    v_candidate_local := (v_local_date + 7)::timestamp + v_at_time;
    RETURN timezone(v_timezone, v_candidate_local);
  END IF;

  RAISE EXCEPTION 'workflow_schedule_trigger_next_run_at: unsupported schedule type=%', v_type;
END;
$$;

COMMENT ON FUNCTION public.workflow_schedule_trigger_next_run_at(JSONB, TIMESTAMPTZ)
  IS 'Compute next run timestamp for schedule trigger types: interval, daily, weekly.';

CREATE OR REPLACE FUNCTION public.workflow_schedule_triggers_before_write_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_scope_type TEXT := lower(COALESCE(NULLIF(NEW.scope_type, ''), 'tenant'));
  v_org UUID;
  v_reference TIMESTAMPTZ := public.workflow_now();
BEGIN
  IF v_scope_type = 'organization' THEN
    v_scope_type := 'tenant';
  ELSIF v_scope_type = 'platform' THEN
    RAISE EXCEPTION 'workflow_schedule_triggers: platform scope is not supported';
  ELSIF v_scope_type = 'global' THEN
    RAISE EXCEPTION 'workflow_schedule_triggers: global scope is not supported';
  END IF;

  NEW.scope_type := v_scope_type;

  IF NEW.scope_id IS NULL THEN
    RAISE EXCEPTION 'workflow_schedule_triggers: scope_id is required';
  END IF;

  IF NEW.schedule IS NULL OR jsonb_typeof(NEW.schedule) <> 'object' THEN
    NEW.schedule := '{}'::jsonb;
  END IF;

  IF NEW.context_patch IS NULL OR jsonb_typeof(NEW.context_patch) <> 'object' THEN
    NEW.context_patch := '{}'::jsonb;
  END IF;

  IF v_scope_type = 'tenant' THEN
    v_org := NEW.scope_id;
  ELSIF v_scope_type = 'client' THEN
    SELECT organization_id INTO v_org FROM public.clients WHERE id = NEW.scope_id;
  ELSIF v_scope_type = 'sender' THEN
    SELECT c.organization_id
      INTO v_org
      FROM public.senders s
      JOIN public.clients c ON c.id = s.client_id
     WHERE s.id = NEW.scope_id;
  ELSE
    v_org := NULL;
  END IF;

  IF v_org IS NULL THEN
    RAISE EXCEPTION 'workflow_schedule_triggers: unable to resolve organization_id for scope=%/%',
      v_scope_type, NEW.scope_id;
  END IF;

  NEW.organization_id := v_org;

  IF TG_OP = 'INSERT' THEN
    IF NEW.next_run_at IS NULL THEN
      NEW.next_run_at := public.workflow_schedule_trigger_next_run_at(NEW.schedule, v_reference);
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF (NEW.schedule IS DISTINCT FROM OLD.schedule)
       OR (OLD.enabled IS DISTINCT FROM TRUE AND NEW.enabled IS TRUE)
    THEN
      NEW.next_run_at := public.workflow_schedule_trigger_next_run_at(NEW.schedule, v_reference);
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS workflow_schedule_triggers_before_write ON public.workflow_schedule_triggers;
CREATE TRIGGER workflow_schedule_triggers_before_write
  BEFORE INSERT OR UPDATE ON public.workflow_schedule_triggers
  FOR EACH ROW
  EXECUTE FUNCTION public.workflow_schedule_triggers_before_write_v1();

DROP TRIGGER IF EXISTS set_updated_at_workflow_schedule_triggers ON public.workflow_schedule_triggers;
CREATE TRIGGER set_updated_at_workflow_schedule_triggers
  BEFORE UPDATE ON public.workflow_schedule_triggers
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 2) RLS
-- ---------------------------------------------------------------------------

ALTER TABLE public.workflow_schedule_triggers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workflow_schedule_triggers_service_role ON public.workflow_schedule_triggers;
CREATE POLICY workflow_schedule_triggers_service_role
  ON public.workflow_schedule_triggers
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS workflow_schedule_triggers_authenticated_select ON public.workflow_schedule_triggers;
CREATE POLICY workflow_schedule_triggers_authenticated_select
  ON public.workflow_schedule_triggers
  FOR SELECT
  TO authenticated
  USING (
    public.user_has_capability_v1('workflow_runs.read')
    AND public.workflow_template_scope_allowed(scope_type, scope_id)
  );

DROP POLICY IF EXISTS workflow_schedule_triggers_authenticated_insert ON public.workflow_schedule_triggers;
CREATE POLICY workflow_schedule_triggers_authenticated_insert
  ON public.workflow_schedule_triggers
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.user_has_capability_v1('workflow_runs.write')
    AND public.workflow_template_scope_allowed(scope_type, scope_id)
    AND EXISTS (
      SELECT 1
      FROM public.workflow_templates wt
      WHERE wt.id = workflow_schedule_triggers.workflow_template_id
        AND public.workflow_template_scope_allowed(wt.scope_type, wt.scope_id)
    )
  );

DROP POLICY IF EXISTS workflow_schedule_triggers_authenticated_update ON public.workflow_schedule_triggers;
CREATE POLICY workflow_schedule_triggers_authenticated_update
  ON public.workflow_schedule_triggers
  FOR UPDATE
  TO authenticated
  USING (
    public.user_has_capability_v1('workflow_runs.write')
    AND public.workflow_template_scope_allowed(scope_type, scope_id)
  )
  WITH CHECK (
    public.user_has_capability_v1('workflow_runs.write')
    AND public.workflow_template_scope_allowed(scope_type, scope_id)
  );

DROP POLICY IF EXISTS workflow_schedule_triggers_authenticated_delete ON public.workflow_schedule_triggers;
CREATE POLICY workflow_schedule_triggers_authenticated_delete
  ON public.workflow_schedule_triggers
  FOR DELETE
  TO authenticated
  USING (
    public.user_has_capability_v1('workflow_runs.write')
    AND public.workflow_template_scope_allowed(scope_type, scope_id)
  );

-- ---------------------------------------------------------------------------
-- 3) Worker: trigger due schedules and start workflow runs
-- ---------------------------------------------------------------------------

INSERT INTO public.worker_registry (worker_name, worker_type, description, schedule, config, is_active)
VALUES (
  'workflow_schedule_triggers_worker',
  'workflow',
  'Starts workflow runs from workflow_schedule_triggers when next_run_at is due.',
  '*/1 * * * *',
  jsonb_build_object(
    'notes', 'Claims due triggers (FOR UPDATE SKIP LOCKED) and starts workflow runs with trigger_source=schedule.'
  ),
  TRUE
)
ON CONFLICT (worker_name) DO UPDATE
SET
  worker_type = EXCLUDED.worker_type,
  description = EXCLUDED.description,
  schedule = EXCLUDED.schedule,
  config = EXCLUDED.config,
  is_active = EXCLUDED.is_active,
  updated_at = now();

INSERT INTO public.cron_config (worker_name, interval_seconds, batch_size, enabled, notes)
VALUES (
  'workflow_schedule_triggers_worker',
  60,
  25,
  TRUE,
  'Time-based workflow triggers (Zapier/Make cadence).'
)
ON CONFLICT (worker_name) DO UPDATE
SET
  interval_seconds = EXCLUDED.interval_seconds,
  batch_size = EXCLUDED.batch_size,
  enabled = EXCLUDED.enabled,
  notes = EXCLUDED.notes,
  last_run_at = cron_config.last_run_at;

CREATE OR REPLACE FUNCTION public.run_workflow_schedule_triggers_worker()
RETURNS JSON
LANGUAGE plpgsql
AS $$
DECLARE
  v_throttle RECORD;
  v_context UUID;
  v_items_processed INT := 0;
  v_error BOOLEAN := FALSE;
  v_row RECORD;
  v_now TIMESTAMPTZ := public.workflow_now();
  v_run_id UUID;
  v_context_payload JSONB;
BEGIN
  SELECT * INTO v_throttle FROM public.check_throttle('workflow_schedule_triggers_worker');
  IF NOT v_throttle.should_run THEN
    RETURN json_build_object('status', 'throttled', 'reason', v_throttle.reason);
  END IF;

  v_context := public.create_request_context('workflow_schedule_triggers_worker');

  FOR v_row IN
    SELECT *
    FROM public.workflow_schedule_triggers
    WHERE enabled = TRUE
      AND next_run_at <= v_now
    ORDER BY next_run_at ASC, id ASC
    LIMIT LEAST(v_throttle.batch_size, 100)
    FOR UPDATE SKIP LOCKED
  LOOP
    v_items_processed := v_items_processed + 1;
    BEGIN
      v_context_payload := COALESCE(v_row.context_patch, '{}'::jsonb) || jsonb_build_object(
        'trigger_source', 'schedule',
        'organization_id', v_row.organization_id,
        'workflow_schedule_trigger_id', v_row.id,
        'scope_type', v_row.scope_type,
        'scope_id', v_row.scope_id,
        'performed_by_system', 'workflow_schedule_triggers_worker',
        'request_context_id', v_context
      );

      v_run_id := public.start_workflow_run(v_row.workflow_template_id, v_context_payload);

      UPDATE public.workflow_schedule_triggers
      SET
        last_run_at = v_now,
        last_run_id = v_run_id,
        last_error = NULL,
        last_error_at = NULL,
        next_run_at = public.workflow_schedule_trigger_next_run_at(v_row.schedule, v_now),
        updated_at = now()
      WHERE id = v_row.id;
    EXCEPTION
      WHEN others THEN
        v_error := TRUE;
        UPDATE public.workflow_schedule_triggers
        SET
          last_run_at = v_now,
          last_run_id = NULL,
          last_error = SQLERRM,
          last_error_at = v_now,
          next_run_at = public.workflow_schedule_trigger_next_run_at(v_row.schedule, v_now),
          updated_at = now()
        WHERE id = v_row.id;
    END;
  END LOOP;

  PERFORM public.complete_request_context(v_context, v_error, v_items_processed);
  PERFORM public.update_cron_config('workflow_schedule_triggers_worker');

  RETURN json_build_object(
    'status', 'completed',
    'items_processed', v_items_processed,
    'error', v_error
  );
END;
$$;

COMMENT ON FUNCTION public.run_workflow_schedule_triggers_worker()
  IS 'Start workflow runs from workflow_schedule_triggers when due (self-throttled via cron_config).';

-- Schedule the worker tick (the worker self-throttles via cron_config).
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'workflow_schedule_triggers_worker_tick') THEN
    PERFORM cron.unschedule('workflow_schedule_triggers_worker_tick');
  END IF;
  PERFORM cron.schedule(
    'workflow_schedule_triggers_worker_tick',
    '*/1 * * * *',
    'SELECT public.run_workflow_schedule_triggers_worker();'
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- 4) UI RPCs
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ui_create_workflow_schedule_trigger_v1(
  p_workflow_template_id UUID,
  p_schedule JSONB,
  p_context_patch JSONB DEFAULT '{}'::jsonb,
  p_enabled BOOLEAN DEFAULT TRUE,
  p_notes TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $$
DECLARE
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_trigger_id UUID;
BEGIN
  IF p_workflow_template_id IS NULL THEN
    RAISE EXCEPTION 'ui_create_workflow_schedule_trigger_v1 requires workflow_template_id';
  END IF;

  PERFORM public.assert_capability_v1('workflow_runs.write', v_scope_type, v_scope_id);

  INSERT INTO public.workflow_schedule_triggers (
    scope_type,
    scope_id,
    workflow_template_id,
    schedule,
    context_patch,
    enabled,
    created_by,
    notes
  )
  VALUES (
    v_scope_type,
    v_scope_id,
    p_workflow_template_id,
    COALESCE(p_schedule, '{}'::jsonb),
    COALESCE(p_context_patch, '{}'::jsonb),
    COALESCE(p_enabled, TRUE),
    auth.uid(),
    NULLIF(btrim(COALESCE(p_notes, '')), '')
  )
  RETURNING id INTO v_trigger_id;

  RETURN jsonb_build_object(
    'status', 'ok',
    'workflow_schedule_trigger_id', v_trigger_id::text
  );
END;
$$;

REVOKE ALL ON FUNCTION public.ui_create_workflow_schedule_trigger_v1(UUID, JSONB, JSONB, BOOLEAN, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_create_workflow_schedule_trigger_v1(UUID, JSONB, JSONB, BOOLEAN, TEXT) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.ui_run_workflow_schedule_trigger_v1(
  p_workflow_schedule_trigger_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $$
DECLARE
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_row RECORD;
  v_context JSONB;
  v_run_id UUID;
BEGIN
  IF p_workflow_schedule_trigger_id IS NULL THEN
    RAISE EXCEPTION 'ui_run_workflow_schedule_trigger_v1 requires workflow_schedule_trigger_id';
  END IF;

  PERFORM public.assert_capability_v1('workflow_runs.write', v_scope_type, v_scope_id);

  SELECT
    id,
    organization_id,
    scope_type,
    scope_id,
    workflow_template_id,
    context_patch
  INTO v_row
  FROM public.workflow_schedule_triggers
  WHERE id = p_workflow_schedule_trigger_id
  LIMIT 1;

  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'ui_run_workflow_schedule_trigger_v1 schedule trigger not found';
  END IF;

  v_context := COALESCE(v_row.context_patch, '{}'::jsonb) || jsonb_build_object(
    'trigger_source', 'schedule_manual',
    'organization_id', v_row.organization_id,
    'workflow_schedule_trigger_id', v_row.id,
    'scope_type', v_row.scope_type,
    'scope_id', v_row.scope_id,
    'requested_by', auth.uid()
  );

  v_run_id := public.start_workflow_run(v_row.workflow_template_id, v_context);

  RETURN jsonb_build_object(
    'status', 'workflow_started',
    'workflow_schedule_trigger_id', v_row.id,
    'workflow_template_id', v_row.workflow_template_id,
    'workflow_run_id', v_run_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.ui_run_workflow_schedule_trigger_v1(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_run_workflow_schedule_trigger_v1(UUID) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202601212101_workflow_schedule_triggers'));
COMMIT;

