-- Spec-Issue: Phase B6 - Catalog RPC contract: lookup_value_archive_v1
-- Step: B6-RPC-10
-- Capability: lookups.write
-- Soft-delete (status='archived' + archived_at/by, retains row).

BEGIN;
SELECT pg_advisory_lock(hashtext('202604280210_lookup_value_archive_v1'));
SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.lookup_value_archive_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org_id UUID := public.current_user_org_id();
  v_correlation_id TEXT := encode(gen_random_bytes(8), 'hex');
  v_decision_id UUID := gen_random_uuid();
  v_resource_id UUID := NULLIF(p_args->>'lookup_value_id', '')::uuid;
  v_reason TEXT := NULLIF(btrim(COALESCE(p_args->>'reason', '')), '');
  v_before public.lookup_values%ROWTYPE;
  v_next_revision INT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'lookup_value_archive_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('lookups.write');

  IF v_resource_id IS NULL THEN
    RAISE EXCEPTION 'lookup_value_archive_v1 requires lookup_value_id'
      USING ERRCODE = '23502';
  END IF;

  SELECT * INTO v_before FROM public.lookup_values WHERE id = v_resource_id FOR UPDATE;
  IF v_before.id IS NULL THEN
    RAISE EXCEPTION 'lookup_value_archive_v1 lookup_value % not found', v_resource_id
      USING ERRCODE = '23503';
  END IF;

  IF v_org_id IS NOT NULL
     AND v_before.organization_id IS NOT NULL
     AND v_before.organization_id <> v_org_id
     AND NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'lookup_value_archive_v1 lookup_value % outside tenant scope', v_resource_id
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.lookup_values
     SET status = 'archived',
         archived_at = now(),
         archived_by = v_user_id,
         retired_at = COALESCE(retired_at, now()),
         metadata = COALESCE(metadata, '{}'::jsonb)
                  || jsonb_build_object('archived_reason', v_reason),
         updated_at = now()
   WHERE id = v_resource_id;

  SELECT COALESCE(MAX(revision), 0) + 1
    INTO v_next_revision
    FROM public.lookup_value_revisions WHERE lookup_value_id = v_resource_id;

  INSERT INTO public.lookup_value_revisions (
    lookup_value_id, organization_id, revision, action,
    before_value, after_value, changed_by, correlation_id, decision_log_id
  ) VALUES (
    v_resource_id, v_before.organization_id, v_next_revision, 'archive',
    to_jsonb(v_before),
    jsonb_build_object('status', 'archived', 'reason', v_reason),
    v_user_id, v_correlation_id, v_decision_id
  );

  -- decision_log.organization_id is NOT NULL; skip the audit write only when
  -- the lookup is global/system-scoped (no tenant).
  IF COALESCE(v_before.organization_id, v_org_id) IS NOT NULL THEN
    INSERT INTO public.decision_log (
      id, organization_id, decision_category, resource_type, resource_id,
      decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
    ) VALUES (
      v_decision_id, COALESCE(v_before.organization_id, v_org_id),
      'lookup_values.archive', 'lookup_value', v_resource_id,
      'lookup_value_archive_v1', 'archived',
      jsonb_strip_nulls(jsonb_build_object('reason', v_reason)),
      'lookup_value_archive_v1', v_correlation_id::uuid
    );
  END IF;

  IF v_before.organization_id IS NOT NULL THEN
    INSERT INTO public.domain_events (
      organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
    ) VALUES (
      v_before.organization_id, 'lookup_value.archived', 'lookup_value', v_resource_id,
      jsonb_build_object('revision', v_next_revision),
      v_correlation_id::uuid, 'pending'
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'lookup_value_id', v_resource_id,
    'revision', v_next_revision,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.lookup_value_archive_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lookup_value_archive_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.lookup_value_archive_v1(jsonb) TO service_role;

COMMENT ON FUNCTION public.lookup_value_archive_v1(jsonb)
  IS 'Canonical write RPC: soft-archive lookup_values row (status=archived). Capability: lookups.write.';

SELECT pg_advisory_unlock(hashtext('202604280210_lookup_value_archive_v1'));
COMMIT;
