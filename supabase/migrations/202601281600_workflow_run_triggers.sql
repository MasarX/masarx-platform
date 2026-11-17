-- Migration: Workflow run triggers (workflow -> workflow chaining)
-- Purpose: Enable Zapier/Make-style "when workflow X completes, run workflow Y" via SSOT rows + a throttled worker.
-- Plan: PLAN-202601-workflow-trigger-plugins-v1 / Step: S04

BEGIN;
SELECT pg_advisory_lock(hashtext('202601281600_workflow_run_triggers'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-- ---------------------------------------------------------------------------
-- 1) SSOT: workflow_run_triggers
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.workflow_run_triggers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL DEFAULT 'tenant',
  scope_id UUID NOT NULL,
  source_workflow_template_id UUID NOT NULL REFERENCES public.workflow_templates(id) ON DELETE CASCADE,
  target_workflow_template_id UUID NOT NULL REFERENCES public.workflow_templates(id) ON DELETE CASCADE,
  source_statuses TEXT[] NOT NULL DEFAULT ARRAY['completed']::TEXT[],
  context_patch JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  last_scanned_completed_at TIMESTAMPTZ,
  created_by UUID REFERENCES public.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes TEXT,
  CONSTRAINT workflow_run_triggers_scope_type_ck CHECK (scope_type IN ('tenant', 'client', 'sender')),
  CONSTRAINT workflow_run_triggers_context_object_ck CHECK (jsonb_typeof(context_patch) = 'object'),
  CONSTRAINT workflow_run_triggers_statuses_not_empty_ck CHECK (array_length(source_statuses, 1) IS NOT NULL),
  CONSTRAINT workflow_run_triggers_no_self_trigger_ck CHECK (source_workflow_template_id <> target_workflow_template_id)
);

CREATE INDEX IF NOT EXISTS idx_workflow_run_triggers_org
  ON public.workflow_run_triggers(organization_id);

CREATE INDEX IF NOT EXISTS idx_workflow_run_triggers_scope
  ON public.workflow_run_triggers(scope_type, scope_id);

CREATE INDEX IF NOT EXISTS idx_workflow_run_triggers_source_template
  ON public.workflow_run_triggers(source_workflow_template_id);

CREATE INDEX IF NOT EXISTS idx_workflow_run_triggers_target_template
  ON public.workflow_run_triggers(target_workflow_template_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_run_triggers_unique_binding
  ON public.workflow_run_triggers(scope_type, scope_id, source_workflow_template_id, target_workflow_template_id, source_statuses);

COMMENT ON TABLE public.workflow_run_triggers
  IS 'Row-driven workflow-run triggers (Zapier/Make-style workflow chaining).';

CREATE OR REPLACE FUNCTION public.workflow_run_triggers_before_write_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_scope_type TEXT := lower(COALESCE(NULLIF(NEW.scope_type, ''), 'tenant'));
  v_org UUID;
  v_status TEXT;
  v_statuses TEXT[] := ARRAY[]::TEXT[];
BEGIN
  IF v_scope_type = 'organization' THEN
    v_scope_type := 'tenant';
  ELSIF v_scope_type = 'platform' THEN
    RAISE EXCEPTION 'workflow_run_triggers: platform scope is not supported';
  ELSIF v_scope_type = 'global' THEN
    RAISE EXCEPTION 'workflow_run_triggers: global scope is not supported';
  END IF;

  NEW.scope_type := v_scope_type;

  IF NEW.scope_id IS NULL THEN
    RAISE EXCEPTION 'workflow_run_triggers: scope_id is required';
  END IF;

  IF NEW.source_workflow_template_id IS NULL THEN
    RAISE EXCEPTION 'workflow_run_triggers: source_workflow_template_id is required';
  END IF;
  IF NEW.target_workflow_template_id IS NULL THEN
    RAISE EXCEPTION 'workflow_run_triggers: target_workflow_template_id is required';
  END IF;
  IF NEW.source_workflow_template_id = NEW.target_workflow_template_id THEN
    RAISE EXCEPTION 'workflow_run_triggers: source and target templates must differ';
  END IF;

  IF NEW.context_patch IS NULL OR jsonb_typeof(NEW.context_patch) <> 'object' THEN
    NEW.context_patch := '{}'::jsonb;
  END IF;

  IF NEW.source_statuses IS NULL OR array_length(NEW.source_statuses, 1) IS NULL THEN
    NEW.source_statuses := ARRAY['completed']::TEXT[];
  END IF;

  FOREACH v_status IN ARRAY NEW.source_statuses LOOP
    v_status := lower(btrim(COALESCE(v_status, '')));
    IF v_status <> '' THEN
      v_statuses := v_statuses || v_status;
    END IF;
  END LOOP;

  SELECT COALESCE(array_agg(s ORDER BY s), ARRAY['completed']::TEXT[])
    INTO NEW.source_statuses
    FROM (
      SELECT DISTINCT s
      FROM unnest(v_statuses) AS s
    ) t;

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
    RAISE EXCEPTION 'workflow_run_triggers: unable to resolve organization_id for scope=%/%',
      v_scope_type, NEW.scope_id;
  END IF;

  NEW.organization_id := v_org;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS workflow_run_triggers_before_write ON public.workflow_run_triggers;
CREATE TRIGGER workflow_run_triggers_before_write
  BEFORE INSERT OR UPDATE ON public.workflow_run_triggers
  FOR EACH ROW
  EXECUTE FUNCTION public.workflow_run_triggers_before_write_v1();

DROP TRIGGER IF EXISTS set_updated_at_workflow_run_triggers ON public.workflow_run_triggers;
CREATE TRIGGER set_updated_at_workflow_run_triggers
  BEFORE UPDATE ON public.workflow_run_triggers
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 2) SSOT ledger: workflow_trigger_fires
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.workflow_trigger_fires (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  workflow_run_trigger_id UUID NOT NULL REFERENCES public.workflow_run_triggers(id) ON DELETE CASCADE,
  source_workflow_run_id UUID NOT NULL REFERENCES public.workflow_runs(id) ON DELETE CASCADE,
  target_workflow_run_id UUID REFERENCES public.workflow_runs(id) ON DELETE SET NULL,
  fire_status TEXT NOT NULL DEFAULT 'pending',
  claimed_at TIMESTAMPTZ,
  claimed_by TEXT,
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT workflow_trigger_fires_status_ck CHECK (fire_status IN ('pending', 'claimed', 'started', 'skipped', 'error')),
  CONSTRAINT workflow_trigger_fires_unique_trigger_source_run UNIQUE (workflow_run_trigger_id, source_workflow_run_id)
);

CREATE INDEX IF NOT EXISTS idx_workflow_trigger_fires_org_status
  ON public.workflow_trigger_fires(organization_id, fire_status, created_at)
  WHERE fire_status IN ('pending', 'claimed');

CREATE INDEX IF NOT EXISTS idx_workflow_trigger_fires_trigger
  ON public.workflow_trigger_fires(workflow_run_trigger_id, created_at);

CREATE INDEX IF NOT EXISTS idx_workflow_trigger_fires_source_run
  ON public.workflow_trigger_fires(source_workflow_run_id);

COMMENT ON TABLE public.workflow_trigger_fires
  IS 'Idempotency ledger for workflow_run_triggers: each (trigger, source_run) fires at most once.';

DROP TRIGGER IF EXISTS set_updated_at_workflow_trigger_fires ON public.workflow_trigger_fires;
CREATE TRIGGER set_updated_at_workflow_trigger_fires
  BEFORE UPDATE ON public.workflow_trigger_fires
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 3) RLS
-- ---------------------------------------------------------------------------

ALTER TABLE public.workflow_run_triggers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_trigger_fires ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workflow_run_triggers_service_role ON public.workflow_run_triggers;
CREATE POLICY workflow_run_triggers_service_role
  ON public.workflow_run_triggers
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS workflow_run_triggers_authenticated_select ON public.workflow_run_triggers;
CREATE POLICY workflow_run_triggers_authenticated_select
  ON public.workflow_run_triggers
  FOR SELECT
  TO authenticated
  USING (
    public.user_has_capability_v1('workflow_runs.read')
    AND public.workflow_template_scope_allowed(scope_type, scope_id)
  );

DROP POLICY IF EXISTS workflow_run_triggers_authenticated_insert ON public.workflow_run_triggers;
CREATE POLICY workflow_run_triggers_authenticated_insert
  ON public.workflow_run_triggers
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.user_has_capability_v1('workflow_runs.write')
    AND public.workflow_template_scope_allowed(scope_type, scope_id)
    AND EXISTS (
      SELECT 1
      FROM public.workflow_templates wt
      WHERE wt.id = workflow_run_triggers.source_workflow_template_id
        AND public.workflow_template_scope_allowed(wt.scope_type, wt.scope_id)
    )
    AND EXISTS (
      SELECT 1
      FROM public.workflow_templates wt
      WHERE wt.id = workflow_run_triggers.target_workflow_template_id
        AND public.workflow_template_scope_allowed(wt.scope_type, wt.scope_id)
    )
  );

DROP POLICY IF EXISTS workflow_run_triggers_authenticated_update ON public.workflow_run_triggers;
CREATE POLICY workflow_run_triggers_authenticated_update
  ON public.workflow_run_triggers
  FOR UPDATE
  TO authenticated
  USING (
    public.user_has_capability_v1('workflow_runs.write')
    AND public.workflow_template_scope_allowed(scope_type, scope_id)
  )
  WITH CHECK (
    public.user_has_capability_v1('workflow_runs.write')
    AND public.workflow_template_scope_allowed(scope_type, scope_id)
    AND EXISTS (
      SELECT 1
      FROM public.workflow_templates wt
      WHERE wt.id = workflow_run_triggers.source_workflow_template_id
        AND public.workflow_template_scope_allowed(wt.scope_type, wt.scope_id)
    )
    AND EXISTS (
      SELECT 1
      FROM public.workflow_templates wt
      WHERE wt.id = workflow_run_triggers.target_workflow_template_id
        AND public.workflow_template_scope_allowed(wt.scope_type, wt.scope_id)
    )
  );

DROP POLICY IF EXISTS workflow_run_triggers_authenticated_delete ON public.workflow_run_triggers;
CREATE POLICY workflow_run_triggers_authenticated_delete
  ON public.workflow_run_triggers
  FOR DELETE
  TO authenticated
  USING (
    public.user_has_capability_v1('workflow_runs.write')
    AND public.workflow_template_scope_allowed(scope_type, scope_id)
  );

DROP POLICY IF EXISTS workflow_trigger_fires_service_role ON public.workflow_trigger_fires;
CREATE POLICY workflow_trigger_fires_service_role
  ON public.workflow_trigger_fires
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS workflow_trigger_fires_authenticated_select ON public.workflow_trigger_fires;
CREATE POLICY workflow_trigger_fires_authenticated_select
  ON public.workflow_trigger_fires
  FOR SELECT
  TO authenticated
  USING (
    public.user_has_capability_v1('workflow_runs.read')
    AND EXISTS (
      SELECT 1
      FROM public.workflow_run_triggers wrt
      WHERE wrt.id = workflow_trigger_fires.workflow_run_trigger_id
        AND public.workflow_template_scope_allowed(wrt.scope_type, wrt.scope_id)
    )
  );

-- ---------------------------------------------------------------------------
-- 4) Worker: create fires + start downstream runs
-- ---------------------------------------------------------------------------

INSERT INTO public.worker_registry (worker_name, worker_type, description, schedule, config, is_active)
VALUES (
  'workflow_run_triggers_worker',
  'workflow',
  'Starts downstream workflow runs from workflow_run_triggers when upstream runs reach terminal status.',
  '*/1 * * * *',
  jsonb_build_object(
    'notes', 'Inserts workflow_trigger_fires for eligible terminal runs, claims pending fires (SKIP LOCKED), and starts downstream runs with trigger provenance in context.'
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
  'workflow_run_triggers_worker',
  60,
  50,
  TRUE,
  'Workflow run triggers worker (Zapier/Make-style workflow chaining).'
)
ON CONFLICT (worker_name) DO UPDATE
SET
  interval_seconds = EXCLUDED.interval_seconds,
  batch_size = EXCLUDED.batch_size,
  enabled = EXCLUDED.enabled,
  notes = EXCLUDED.notes,
  last_run_at = cron_config.last_run_at;

CREATE OR REPLACE FUNCTION public.run_workflow_run_triggers_worker()
RETURNS JSON
LANGUAGE plpgsql
AS $$
DECLARE
  v_throttle RECORD;
  v_context UUID;
  v_items_processed INT := 0;
  v_error BOOLEAN := FALSE;
  v_now TIMESTAMPTZ := public.workflow_now();
  v_trigger RECORD;
  v_fire RECORD;
  v_source_run RECORD;
  v_scan_from TIMESTAMPTZ;
  v_max_completed_at TIMESTAMPTZ;
  v_context_payload JSONB;
  v_target_run_id UUID;
BEGIN
  SELECT * INTO v_throttle FROM public.check_throttle('workflow_run_triggers_worker');
  IF NOT v_throttle.should_run THEN
    RETURN json_build_object('status', 'throttled', 'reason', v_throttle.reason);
  END IF;

  v_context := public.create_request_context('workflow_run_triggers_worker');

  -- 1) Insert missing fires for eligible terminal runs (no backfill; scan from created_at/watermark).
  FOR v_trigger IN
    SELECT *
    FROM public.workflow_run_triggers
    WHERE enabled = TRUE
    ORDER BY updated_at ASC, id ASC
    LIMIT 50
    FOR UPDATE SKIP LOCKED
  LOOP
    v_scan_from := COALESCE(v_trigger.last_scanned_completed_at, v_trigger.created_at);
    v_max_completed_at := NULL;

    WITH eligible AS (
      SELECT
        wr.id,
        wr.completed_at
      FROM public.workflow_runs wr
      WHERE wr.workflow_template_id = v_trigger.source_workflow_template_id
        AND wr.completed_at IS NOT NULL
        AND wr.completed_at > v_scan_from
        AND wr.workflow_status = ANY(v_trigger.source_statuses)
      ORDER BY wr.completed_at ASC, wr.id ASC
      LIMIT 250
    ),
    ins AS (
      INSERT INTO public.workflow_trigger_fires (
        organization_id,
        workflow_run_trigger_id,
        source_workflow_run_id,
        fire_status,
        created_at,
        updated_at
      )
      SELECT
        v_trigger.organization_id,
        v_trigger.id,
        e.id,
        'pending',
        now(),
        now()
      FROM eligible e
      ON CONFLICT (workflow_run_trigger_id, source_workflow_run_id) DO NOTHING
      RETURNING source_workflow_run_id
    )
    SELECT max(completed_at) INTO v_max_completed_at FROM eligible;

    IF v_max_completed_at IS NOT NULL THEN
      UPDATE public.workflow_run_triggers
      SET
        last_scanned_completed_at = v_max_completed_at,
        updated_at = now()
      WHERE id = v_trigger.id;
    END IF;
  END LOOP;

  -- 2) Claim and process pending fires.
  FOR v_fire IN
    SELECT f.*
    FROM public.workflow_trigger_fires f
    JOIN public.workflow_run_triggers t ON t.id = f.workflow_run_trigger_id
    WHERE f.fire_status = 'pending'
      AND t.enabled = TRUE
    ORDER BY f.created_at ASC, f.id ASC
    LIMIT LEAST(v_throttle.batch_size, 200)
    FOR UPDATE OF f SKIP LOCKED
  LOOP
    v_items_processed := v_items_processed + 1;
    BEGIN
      UPDATE public.workflow_trigger_fires
      SET
        fire_status = 'claimed',
        claimed_at = v_now,
        claimed_by = 'workflow_run_triggers_worker',
        attempts = attempts + 1,
        last_error = NULL,
        updated_at = now()
      WHERE id = v_fire.id;

      SELECT * INTO v_trigger
      FROM public.workflow_run_triggers
      WHERE id = v_fire.workflow_run_trigger_id
      LIMIT 1;

      SELECT workflow_status, completed_at, context INTO v_source_run
      FROM public.workflow_runs
      WHERE id = v_fire.source_workflow_run_id
      LIMIT 1;

      v_context_payload := COALESCE(v_trigger.context_patch, '{}'::jsonb) || jsonb_build_object(
        'trigger_source', 'workflow_run_trigger',
        'idempotency_key', format('wrt:%s:src_run:%s', v_trigger.id, v_fire.source_workflow_run_id),
        'organization_id', v_trigger.organization_id,
        'workflow_run_trigger_id', v_trigger.id,
        'workflow_trigger_fire_id', v_fire.id,
        'scope_type', v_trigger.scope_type,
        'scope_id', v_trigger.scope_id,
        'performed_by_system', 'workflow_run_triggers_worker',
        'request_context_id', v_context,
        'source', jsonb_build_object(
          'workflow_run_id', v_fire.source_workflow_run_id,
          'workflow_template_id', v_trigger.source_workflow_template_id,
          'workflow_status', v_source_run.workflow_status,
          'completed_at', v_source_run.completed_at
        ),
        'source_context', COALESCE(v_source_run.context, '{}'::jsonb)
      );

      v_target_run_id := public.start_workflow_run(v_trigger.target_workflow_template_id, v_context_payload);

      UPDATE public.workflow_trigger_fires
      SET
        fire_status = 'started',
        target_workflow_run_id = v_target_run_id,
        updated_at = now()
      WHERE id = v_fire.id;

      PERFORM public.log_decision(
        v_trigger.organization_id,
        'workflow_trigger',
        'workflow_trigger_fire',
        v_fire.id,
        'fire',
        'started',
        'workflow_run_triggers_worker',
        v_context,
        jsonb_build_object(
          'workflow_run_trigger_id', v_trigger.id,
          'source_workflow_run_id', v_fire.source_workflow_run_id,
          'target_workflow_run_id', v_target_run_id
        ),
        NULL
      );
    EXCEPTION
      WHEN others THEN
        v_error := TRUE;
        UPDATE public.workflow_trigger_fires
        SET
          fire_status = 'error',
          last_error = SQLERRM,
          updated_at = now()
        WHERE id = v_fire.id;

        PERFORM public.log_decision(
          v_fire.organization_id,
          'workflow_trigger',
          'workflow_trigger_fire',
          v_fire.id,
          'fire',
          'error',
          'workflow_run_triggers_worker',
          v_context,
          jsonb_build_object(
            'workflow_run_trigger_id', v_fire.workflow_run_trigger_id,
            'source_workflow_run_id', v_fire.source_workflow_run_id
          ),
          SQLERRM
        );
    END;
  END LOOP;

  PERFORM public.complete_request_context(v_context, v_error, v_items_processed);
  PERFORM public.update_cron_config('workflow_run_triggers_worker');

  RETURN json_build_object(
    'status', 'completed',
    'items_processed', v_items_processed,
    'error', v_error
  );
END;
$$;

COMMENT ON FUNCTION public.run_workflow_run_triggers_worker()
  IS 'Start downstream workflow runs from workflow_run_triggers when upstream runs complete (self-throttled via cron_config).';

-- Schedule the worker tick (self-throttles via cron_config).
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'workflow_run_triggers_worker_tick') THEN
    PERFORM cron.unschedule('workflow_run_triggers_worker_tick');
  END IF;
  PERFORM cron.schedule(
    'workflow_run_triggers_worker_tick',
    '*/1 * * * *',
    'SELECT public.run_workflow_run_triggers_worker();'
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- 5) UI RPCs
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ui_create_workflow_run_trigger_v1(
  p_source_workflow_template_id UUID,
  p_target_workflow_template_id UUID,
  p_source_statuses TEXT[] DEFAULT NULL,
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
  IF p_source_workflow_template_id IS NULL THEN
    RAISE EXCEPTION 'ui_create_workflow_run_trigger_v1 requires source_workflow_template_id';
  END IF;
  IF p_target_workflow_template_id IS NULL THEN
    RAISE EXCEPTION 'ui_create_workflow_run_trigger_v1 requires target_workflow_template_id';
  END IF;

  PERFORM public.assert_capability_v1('workflow_runs.write', v_scope_type, v_scope_id);

  INSERT INTO public.workflow_run_triggers (
    scope_type,
    scope_id,
    source_workflow_template_id,
    target_workflow_template_id,
    source_statuses,
    context_patch,
    enabled,
    created_by,
    notes
  )
  VALUES (
    v_scope_type,
    v_scope_id,
    p_source_workflow_template_id,
    p_target_workflow_template_id,
    COALESCE(p_source_statuses, ARRAY['completed']::TEXT[]),
    COALESCE(p_context_patch, '{}'::jsonb),
    COALESCE(p_enabled, TRUE),
    auth.uid(),
    NULLIF(btrim(COALESCE(p_notes, '')), '')
  )
  RETURNING id INTO v_trigger_id;

  RETURN jsonb_build_object(
    'status', 'ok',
    'workflow_run_trigger_id', v_trigger_id::text
  );
END;
$$;

REVOKE ALL ON FUNCTION public.ui_create_workflow_run_trigger_v1(UUID, UUID, TEXT[], JSONB, BOOLEAN, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_create_workflow_run_trigger_v1(UUID, UUID, TEXT[], JSONB, BOOLEAN, TEXT) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202601281600_workflow_run_triggers'));
COMMIT;
