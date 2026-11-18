BEGIN;
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
  v_subject_type TEXT;
  v_subject_id UUID;
  v_kind TEXT;
  v_scope_type TEXT;
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

  -- Optional arguments remain signature-compatible, but cannot grant access.
  SELECT lower(COALESCE(NULLIF(btrim(b.subject_type), ''), '')), b.subject_id, b.kind, b.scope_type
    INTO v_subject_type, v_subject_id, v_kind, v_scope_type
    FROM public.settlement_batches b
    WHERE b.id=p_settlement_batch_id AND b.organization_id=p_organization_id;
  IF NOT FOUND THEN RETURN FALSE; END IF;

  -- The additional user alias is authorized only by the canonical batch row.
  -- Never use caller-provided optional subject arguments for this new branch.
  IF v_kind='cod' AND v_scope_type='driver_shift'
     AND v_subject_type='user' AND v_subject_id=auth.uid() THEN
    RETURN TRUE;
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
COMMENT ON FUNCTION public.can_read_settlement_batch_v1(UUID,UUID,TEXT,UUID) IS 'Settlement authorization uses persisted subject identity; COD driver-shift user aliases preserve same-org tasks.read and finance/assignment alternatives.';
COMMIT;
