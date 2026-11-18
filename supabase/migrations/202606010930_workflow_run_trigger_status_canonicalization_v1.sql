-- Console V2 workflow run triggers: canonicalize terminal success status.
-- Workflow run status lookup now uses `succeeded`; older trigger rows/RPC
-- defaults used the legacy `completed` alias and could bypass duplicate checks.

BEGIN;
SELECT pg_advisory_lock(hashtext('202606010930_workflow_run_trigger_status_canonicalization_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

WITH normalized AS (
  SELECT
    w.id,
    w.scope_type,
    w.scope_id,
    w.source_workflow_template_id,
    w.target_workflow_template_id,
    COALESCE(ns.source_statuses, ARRAY['succeeded']::TEXT[]) AS source_statuses,
    w.enabled,
    w.created_at,
    w.updated_at
  FROM public.workflow_run_triggers w
  CROSS JOIN LATERAL (
    SELECT array_agg(status ORDER BY status) AS source_statuses
    FROM (
      SELECT DISTINCT
        CASE lower(btrim(raw.status))
          WHEN 'completed' THEN 'succeeded'
          ELSE lower(btrim(raw.status))
        END AS status
      FROM unnest(COALESCE(w.source_statuses, ARRAY[]::TEXT[])) AS raw(status)
      WHERE btrim(COALESCE(raw.status, '')) <> ''
    ) deduped
  ) ns
),
ranked AS (
  SELECT
    normalized.*,
    row_number() OVER (
      PARTITION BY scope_type, scope_id, source_workflow_template_id, target_workflow_template_id, source_statuses
      ORDER BY enabled DESC, updated_at DESC, created_at DESC, id
    ) AS rn
  FROM normalized
)
DELETE FROM public.workflow_run_triggers w
USING ranked r
WHERE w.id = r.id
  AND r.rn > 1;

WITH normalized AS (
  SELECT
    w.id,
    COALESCE(ns.source_statuses, ARRAY['succeeded']::TEXT[]) AS source_statuses
  FROM public.workflow_run_triggers w
  CROSS JOIN LATERAL (
    SELECT array_agg(status ORDER BY status) AS source_statuses
    FROM (
      SELECT DISTINCT
        CASE lower(btrim(raw.status))
          WHEN 'completed' THEN 'succeeded'
          ELSE lower(btrim(raw.status))
        END AS status
      FROM unnest(COALESCE(w.source_statuses, ARRAY[]::TEXT[])) AS raw(status)
      WHERE btrim(COALESCE(raw.status, '')) <> ''
    ) deduped
  ) ns
)
UPDATE public.workflow_run_triggers w
SET source_statuses = normalized.source_statuses,
    updated_at = now()
FROM normalized
WHERE w.id = normalized.id
  AND w.source_statuses IS DISTINCT FROM normalized.source_statuses;

ALTER TABLE public.workflow_run_triggers
  ALTER COLUMN source_statuses SET DEFAULT ARRAY['succeeded']::TEXT[];

DROP FUNCTION IF EXISTS api.ui_create_workflow_run_trigger_v1(UUID, UUID, TEXT[], JSONB, BOOLEAN, TEXT, UUID);
DROP FUNCTION IF EXISTS api.ui_create_workflow_run_trigger_v1(UUID, UUID, TEXT[], JSONB, BOOLEAN, TEXT);
DROP FUNCTION IF EXISTS public.ui_create_workflow_run_trigger_v1(UUID, UUID, TEXT[], JSONB, BOOLEAN, TEXT);
DROP FUNCTION IF EXISTS public.ui_create_workflow_run_trigger_v1(UUID, UUID, TEXT[], JSONB, BOOLEAN, TEXT, UUID);

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
    NEW.source_statuses := ARRAY['succeeded']::TEXT[];
  END IF;

  FOREACH v_status IN ARRAY NEW.source_statuses LOOP
    v_status := lower(btrim(COALESCE(v_status, '')));
    IF v_status = 'completed' THEN
      v_status := 'succeeded';
    END IF;
    IF v_status <> '' THEN
      v_statuses := v_statuses || v_status;
    END IF;
  END LOOP;

  SELECT COALESCE(array_agg(s ORDER BY s), ARRAY['succeeded']::TEXT[])
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

CREATE OR REPLACE FUNCTION public.ui_create_workflow_run_trigger_v1(
  p_source_workflow_template_id UUID,
  p_target_workflow_template_id UUID,
  p_source_statuses TEXT[],
  p_context_patch JSONB,
  p_enabled BOOLEAN,
  p_notes TEXT,
  p_scope_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $$
DECLARE
  v_actor_scope_type TEXT := public.current_user_scope_type();
  v_actor_scope_id UUID := public.current_user_scope_id();
  v_current_org_id UUID := public.current_user_org_id();
  v_scope_type TEXT := v_actor_scope_type;
  v_scope_id UUID := v_actor_scope_id;
  v_trigger_id UUID;
BEGIN
  IF p_source_workflow_template_id IS NULL THEN
    RAISE EXCEPTION 'ui_create_workflow_run_trigger_v1 requires source_workflow_template_id';
  END IF;
  IF p_target_workflow_template_id IS NULL THEN
    RAISE EXCEPTION 'ui_create_workflow_run_trigger_v1 requires target_workflow_template_id';
  END IF;

  PERFORM public.assert_capability_v1('workflows.write', v_actor_scope_type, v_actor_scope_id);

  IF p_scope_id IS NOT NULL
     AND v_actor_scope_type NOT IN ('platform', 'tenant', 'organization') THEN
    RAISE EXCEPTION 'ui_create_workflow_run_trigger_v1 active tenant scope_id is not allowed for this actor'
      USING ERRCODE = '42501';
  END IF;

  IF v_scope_type = 'platform' THEN
    v_scope_type := 'tenant';
    v_scope_id := COALESCE(p_scope_id, v_current_org_id);
  ELSIF v_scope_type = 'organization' THEN
    v_scope_type := 'tenant';
  END IF;

  IF v_scope_type = 'tenant' THEN
    v_scope_id := COALESCE(v_scope_id, v_current_org_id);
    IF p_scope_id IS NOT NULL AND p_scope_id <> v_scope_id THEN
      RAISE EXCEPTION 'ui_create_workflow_run_trigger_v1 active tenant scope_id is not allowed for this actor'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF v_actor_scope_type = 'platform'
     AND p_scope_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = p_scope_id) THEN
    RAISE EXCEPTION 'ui_create_workflow_run_trigger_v1 active tenant scope_id does not exist'
      USING ERRCODE = '22023';
  END IF;

  IF v_scope_type NOT IN ('tenant', 'client', 'sender') THEN
    RAISE EXCEPTION 'ui_create_workflow_run_trigger_v1 invalid trigger scope_type %',
      COALESCE(v_scope_type, 'null')
      USING ERRCODE = '22023';
  END IF;

  IF v_scope_id IS NULL THEN
    RAISE EXCEPTION 'ui_create_workflow_run_trigger_v1 trigger scope_id is required'
      USING ERRCODE = '23502';
  END IF;

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
    COALESCE(p_source_statuses, ARRAY['succeeded']::TEXT[]),
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

COMMENT ON FUNCTION public.ui_create_workflow_run_trigger_v1(UUID, UUID, TEXT[], JSONB, BOOLEAN, TEXT, UUID)
  IS 'Creates workflow run triggers through Console V2. Capability: workflows.write. Platform actors are normalized to tenant trigger scope for the selected active tenant when p_scope_id is provided. Trigger source statuses are canonicalized to workflow_run_status values.';

REVOKE ALL ON FUNCTION public.ui_create_workflow_run_trigger_v1(UUID, UUID, TEXT[], JSONB, BOOLEAN, TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_create_workflow_run_trigger_v1(UUID, UUID, TEXT[], JSONB, BOOLEAN, TEXT, UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.ui_create_workflow_run_trigger_v1(
  p_source_workflow_template_id UUID,
  p_target_workflow_template_id UUID,
  p_source_statuses TEXT[],
  p_context_patch JSONB,
  p_enabled BOOLEAN,
  p_notes TEXT,
  p_scope_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $wrapper$
  SELECT public.ui_create_workflow_run_trigger_v1(
    p_source_workflow_template_id,
    p_target_workflow_template_id,
    p_source_statuses,
    COALESCE(p_context_patch, '{}'::jsonb),
    COALESCE(p_enabled, TRUE),
    p_notes,
    p_scope_id
  );
$wrapper$;

REVOKE ALL ON FUNCTION api.ui_create_workflow_run_trigger_v1(UUID, UUID, TEXT[], JSONB, BOOLEAN, TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.ui_create_workflow_run_trigger_v1(UUID, UUID, TEXT[], JSONB, BOOLEAN, TEXT, UUID) TO authenticated, service_role;

COMMENT ON FUNCTION api.ui_create_workflow_run_trigger_v1(UUID, UUID, TEXT[], JSONB, BOOLEAN, TEXT, UUID)
  IS 'API-schema wrapper for Console V2 workflow run trigger creation. Capability: workflows.write. p_scope_id carries the selected active tenant for platform operators.';

SELECT pg_advisory_unlock(hashtext('202606010930_workflow_run_trigger_status_canonicalization_v1'));
COMMIT;
