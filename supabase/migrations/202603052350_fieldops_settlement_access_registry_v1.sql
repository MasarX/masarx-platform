-- Plan: PLAN-202603-fieldops-driver-production-readiness-v1 / Step: S04
-- Migration: FieldOps settlement access + ui registry alignment v1
-- Purpose:
-- - Add the missing `settlements` ui_read_registry resource so the mobile settlements surface has a canonical backend contract.
-- - Tighten settlement read access to finance users, settlement subjects, or users assigned settlement work; avoid tenant-wide read leakage.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603052350_fieldops_settlement_access_registry_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.can_read_settlement_batch_v1(
  p_organization_id UUID,
  p_settlement_batch_id UUID,
  p_subject_type TEXT DEFAULT NULL,
  p_subject_id UUID DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_subject_type TEXT := lower(COALESCE(NULLIF(btrim(p_subject_type), ''), ''));
  v_subject_id UUID := p_subject_id;
BEGIN
  IF p_organization_id IS NULL OR p_settlement_batch_id IS NULL THEN
    RETURN FALSE;
  END IF;

  IF public.is_platform_user() THEN
    RETURN TRUE;
  END IF;

  IF public.current_user_org_id() IS DISTINCT FROM p_organization_id THEN
    RETURN FALSE;
  END IF;

  IF public.user_has_permission_v1('finance.read', p_organization_id) THEN
    RETURN TRUE;
  END IF;

  IF NOT public.user_has_permission_v1('tasks.read', p_organization_id) THEN
    RETURN FALSE;
  END IF;

  IF v_subject_type = '' OR v_subject_id IS NULL THEN
    SELECT
      lower(COALESCE(NULLIF(btrim(b.subject_type), ''), '')),
      b.subject_id
    INTO v_subject_type, v_subject_id
    FROM public.settlement_batches b
    WHERE b.id = p_settlement_batch_id
      AND b.organization_id = p_organization_id
    LIMIT 1;
  END IF;

  IF v_subject_type = 'driver' AND v_subject_id = auth.uid() THEN
    RETURN TRUE;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM public.tasks t
    WHERE t.organization_id = p_organization_id
      AND lower(COALESCE(t.resource_type, '')) = 'settlement_batch'
      AND t.resource_id = p_settlement_batch_id
      AND t.assigned_to = auth.uid()
  );
END;
$$;

COMMENT ON FUNCTION public.can_read_settlement_batch_v1(UUID, UUID, TEXT, UUID)
  IS 'Authorize settlement projection reads for finance users, the driver subject of the batch, or users assigned settlement_batch tasks.';

REVOKE ALL ON FUNCTION public.can_read_settlement_batch_v1(UUID, UUID, TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.can_read_settlement_batch_v1(UUID, UUID, TEXT, UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.can_read_settlement_batch_v1(UUID, UUID, TEXT, UUID) TO authenticated, service_role;

DROP POLICY IF EXISTS settlement_batches_select ON public.settlement_batches;
CREATE POLICY settlement_batches_select ON public.settlement_batches
  FOR SELECT
  TO authenticated
  USING (
    public.can_read_settlement_batch_v1(
      organization_id,
      id,
      subject_type,
      subject_id
    )
  );

DROP POLICY IF EXISTS settlement_events_select ON public.settlement_events;
CREATE POLICY settlement_events_select ON public.settlement_events
  FOR SELECT
  TO authenticated
  USING (
    public.can_read_settlement_batch_v1(
      organization_id,
      settlement_batch_id
    )
  );

DROP POLICY IF EXISTS settlement_batch_finance_events_select ON public.settlement_batch_finance_events;
CREATE POLICY settlement_batch_finance_events_select ON public.settlement_batch_finance_events
  FOR SELECT
  TO authenticated
  USING (
    public.can_read_settlement_batch_v1(
      organization_id,
      settlement_batch_id
    )
  );

DO $$
DECLARE
  v_current JSONB;
  v_resources JSONB := '[]'::jsonb;
  v_updated JSONB := '[]'::jsonb;
  v_item JSONB;
  v_settlements JSONB := jsonb_build_object(
    'key', 'settlements',
    'label', 'Settlements',
    'relation', 'public.settlement_batches',
    'id_column', 'id',
    'scope_columns', jsonb_build_object(
      'tenant', 'organization_id',
      'client', 'client_id',
      'sender', 'sender_id'
    ),
    'capability_read', 'tasks.read',
    'select', jsonb_build_array(
      'id',
      'kind',
      'scope_type',
      'branch_id',
      'client_id',
      'sender_id',
      'subject_type',
      'subject_id',
      'status',
      'status_reason',
      'window_start_at',
      'window_end_at',
      'metadata',
      'created_at',
      'updated_at'
    ),
    'filters', jsonb_build_array(
      jsonb_build_object('key', 'status', 'column', 'status', 'op', 'eq'),
      jsonb_build_object('key', 'kind', 'column', 'kind', 'op', 'eq'),
      jsonb_build_object('key', 'branch_id', 'column', 'branch_id', 'op', 'eq'),
      jsonb_build_object('key', 'subject_id', 'column', 'subject_id', 'op', 'eq'),
      jsonb_build_object('key', 'subject_type', 'column', 'subject_type', 'op', 'eq')
    ),
    'default_sort', jsonb_build_object('column', 'created_at', 'direction', 'desc')
  );
  v_found BOOLEAN := FALSE;
BEGIN
  SELECT sv.value
    INTO v_current
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'ui_read_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'ui_read_registry global settings missing';
  END IF;

  v_resources := COALESCE(v_current->'resources', '[]'::jsonb);

  FOR v_item IN SELECT value FROM jsonb_array_elements(v_resources) AS value LOOP
    IF v_item->>'key' = 'settlements' THEN
      v_updated := v_updated || jsonb_build_array(v_settlements);
      v_found := TRUE;
    ELSE
      v_updated := v_updated || jsonb_build_array(v_item);
    END IF;
  END LOOP;

  IF NOT v_found THEN
    v_updated := v_updated || jsonb_build_array(v_settlements);
  END IF;

  v_current := jsonb_set(v_current, '{resources}', v_updated, true);

  WITH current AS (
    SELECT s.settings_version_id,
           sv.version,
           sv.value
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_read_registry'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
    LIMIT 1
  ),
  applied AS (
    UPDATE public.settings_versions sv
       SET value = v_current,
           version = current.version + 1,
           change_reason = 'Add settlements resource to ui_read_registry and align mobile settlement access',
           approved_at = now(),
           effective_from = now()
      FROM current
     WHERE sv.id = current.settings_version_id
       AND v_current IS DISTINCT FROM current.value
    RETURNING sv.id, sv.value
  )
  UPDATE public.settings s
     SET cached_value = applied.value,
         last_updated = now()
    FROM applied
   WHERE s.category = 'ui_read_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
     AND s.settings_version_id = applied.id;
END $$;

SELECT pg_advisory_unlock(hashtext('202603052350_fieldops_settlement_access_registry_v1'));
COMMIT;
