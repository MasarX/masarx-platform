-- Plan: B09 Exception, reattempt & returns loop
-- Migration: UC114 tasks NDR projection contract v1
-- Date: 2026-04-03
--
-- Purpose:
--   - Keep `public.tasks` as the SSOT for dispatch exception owner/SLA flows.
--   - Add durable projection fields needed for row-driven NDR queue resources and SLA reporting.
--   - Expose assign_task_v1 through the api schema for browser/server clients pinned to db.schema=api.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604032215_uc114_tasks_ndr_projection_v1'));
SET search_path TO public, api, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS task_type_key TEXT,
  ADD COLUMN IF NOT EXISTS sla_breached_at TIMESTAMPTZ;

UPDATE public.tasks t
   SET task_type_key = lower(NULLIF(btrim(COALESCE(tt.key, '')), ''))
  FROM public.task_types tt
 WHERE tt.id = t.task_type_id
   AND (
     t.task_type_key IS NULL
     OR t.task_type_key IS DISTINCT FROM lower(NULLIF(btrim(COALESCE(tt.key, '')), ''))
   );

CREATE OR REPLACE FUNCTION public.tasks_sync_task_type_key_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_task_type_key TEXT;
BEGIN
  IF NEW.task_type_id IS NULL THEN
    NEW.task_type_key := NULL;
    RETURN NEW;
  END IF;

  SELECT lower(NULLIF(btrim(COALESCE(tt.key, '')), ''))
    INTO v_task_type_key
    FROM public.task_types tt
   WHERE tt.id = NEW.task_type_id
   LIMIT 1;

  IF v_task_type_key IS NULL THEN
    RAISE EXCEPTION 'tasks_sync_task_type_key_v1 task_type not found: %', NEW.task_type_id
      USING ERRCODE = '23503';
  END IF;

  NEW.task_type_key := v_task_type_key;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.tasks_sync_task_type_key_v1()
  IS 'Projection trigger for public.tasks.task_type_key so task-backed UI resources can filter without relation joins.';

DROP TRIGGER IF EXISTS trg_tasks_sync_task_type_key_v1 ON public.tasks;
CREATE TRIGGER trg_tasks_sync_task_type_key_v1
  BEFORE INSERT OR UPDATE OF task_type_id
  ON public.tasks
  FOR EACH ROW
  EXECUTE FUNCTION public.tasks_sync_task_type_key_v1();

CREATE OR REPLACE FUNCTION public.task_types_sync_tasks_task_type_key_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RETURN NEW;
  END IF;

  IF COALESCE(NEW.key, '') IS DISTINCT FROM COALESCE(OLD.key, '') THEN
    UPDATE public.tasks
       SET task_type_key = lower(NULLIF(btrim(COALESCE(NEW.key, '')), ''))
     WHERE task_type_id = NEW.id;
  END IF;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.task_types_sync_tasks_task_type_key_v1()
  IS 'Keeps public.tasks.task_type_key aligned if a task_types.key row is renamed.';

DROP TRIGGER IF EXISTS trg_task_types_sync_tasks_task_type_key_v1 ON public.task_types;
CREATE TRIGGER trg_task_types_sync_tasks_task_type_key_v1
  AFTER UPDATE OF key
  ON public.task_types
  FOR EACH ROW
  EXECUTE FUNCTION public.task_types_sync_tasks_task_type_key_v1();

ALTER TABLE public.tasks
  ALTER COLUMN task_type_key SET NOT NULL;

COMMENT ON COLUMN public.tasks.task_type_key
  IS 'Denormalized task type key used by task-backed UI/resource aliases and reporting without relation joins.';
COMMENT ON COLUMN public.tasks.sla_breached_at
  IS 'First timestamp when the canonical SLA breach sweeper observed the task overdue. NULL until the breach is logged.';

CREATE INDEX IF NOT EXISTS idx_tasks_org_task_type_status
  ON public.tasks (organization_id, task_type_key, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_org_task_type_assigned
  ON public.tasks (organization_id, task_type_key, assigned_to, assigned_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_org_task_type_sla_due
  ON public.tasks (organization_id, task_type_key, sla_due_at)
  WHERE sla_due_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_org_task_type_sla_breached
  ON public.tasks (organization_id, task_type_key, sla_breached_at DESC)
  WHERE sla_breached_at IS NOT NULL;

CREATE OR REPLACE FUNCTION api.assign_task_v1(
  p_task_id UUID,
  p_assigned_to UUID,
  p_idempotency_key TEXT DEFAULT NULL,
  p_notes TEXT DEFAULT NULL
)
RETURNS TABLE (
  task_id UUID,
  task_event_id UUID
)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT *
  FROM public.assign_task_v1(
    p_task_id,
    p_assigned_to,
    p_idempotency_key,
    p_notes
  );
$function$;

COMMENT ON FUNCTION api.assign_task_v1(UUID, UUID, TEXT, TEXT)
  IS 'API-schema wrapper for public.assign_task_v1 used by browser/server clients pinned to db.schema=api.';

REVOKE ALL ON FUNCTION api.assign_task_v1(UUID, UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.assign_task_v1(UUID, UUID, TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION api.assign_task_v1(UUID, UUID, TEXT, TEXT) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202604032215_uc114_tasks_ndr_projection_v1'));
COMMIT;
