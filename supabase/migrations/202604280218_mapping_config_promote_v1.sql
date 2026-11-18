-- Spec-Issue: Phase B6 - Integrations RPC contract: mapping_config_promote_v1
-- Step: B6-RPC-18
-- Capability: mappings.write (the canonical surface uses 'mappings.write'; the audit
--   plan referenced 'integrations.write' which is not a registered capability —
--   align to the registered SSOT).
--
-- Behavior: bumps mapping_configs.mapping_version + appends mapping_config_revisions
-- ledger entry (foundation migration). Optional p_args.mapping_config supplies a
-- replacement payload; otherwise the version bump simply records a no-content
-- promote (e.g. promotion of staging draft).

BEGIN;
SELECT pg_advisory_lock(hashtext('202604280218_mapping_config_promote_v1'));
SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.mapping_config_promote_v1(p_args jsonb)
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
  v_resource_id UUID := NULLIF(p_args->>'mapping_config_id', '')::uuid;
  v_new_payload JSONB := p_args->'mapping_config';
  v_promote_notes TEXT := NULLIF(btrim(COALESCE(p_args->>'notes', '')), '');
  v_before public.mapping_configs%ROWTYPE;
  v_before_jsonb JSONB;
  v_after_jsonb JSONB;
  v_next_revision INT;
  v_promoted_to_version INT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'mapping_config_promote_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('mappings.write');

  IF v_resource_id IS NULL THEN
    RAISE EXCEPTION 'mapping_config_promote_v1 requires mapping_config_id'
      USING ERRCODE = '23502';
  END IF;

  SELECT * INTO v_before FROM public.mapping_configs WHERE id = v_resource_id FOR UPDATE;
  IF v_before.id IS NULL THEN
    RAISE EXCEPTION 'mapping_config_promote_v1 mapping_config % not found', v_resource_id
      USING ERRCODE = '23503';
  END IF;

  v_before_jsonb := to_jsonb(v_before);
  v_promoted_to_version := v_before.mapping_version + 1;

  UPDATE public.mapping_configs
     SET mapping_config = COALESCE(v_new_payload, mapping_config),
         mapping_version = v_promoted_to_version,
         notes = COALESCE(v_promote_notes, notes),
         updated_at = now()
   WHERE id = v_resource_id
   RETURNING to_jsonb(mapping_configs.*) INTO v_after_jsonb;

  SELECT COALESCE(MAX(revision), 0) + 1
    INTO v_next_revision
    FROM public.mapping_config_revisions WHERE mapping_config_id = v_resource_id;

  INSERT INTO public.mapping_config_revisions (
    mapping_config_id, revision, promoted_from_version, promoted_to_version,
    before_value, after_value, changed_by, correlation_id, decision_log_id
  ) VALUES (
    v_resource_id, v_next_revision, v_before.mapping_version, v_promoted_to_version,
    v_before_jsonb, v_after_jsonb, v_user_id, v_correlation_id, v_decision_id
  );

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, COALESCE(v_org_id, '00000000-0000-0000-0000-000000000000'::uuid),
    'mappings.promote', 'mapping_config', v_resource_id,
    'mapping_config_promote_v1', 'promoted',
    jsonb_strip_nulls(jsonb_build_object(
      'previous_version', v_before.mapping_version,
      'promoted_to_version', v_promoted_to_version,
      'replaced_payload', v_new_payload IS NOT NULL,
      'notes', v_promote_notes
    )),
    'mapping_config_promote_v1', v_correlation_id::uuid
  );

  IF v_org_id IS NOT NULL THEN
    INSERT INTO public.domain_events (
      organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
    ) VALUES (
      v_org_id, 'mapping_config.promoted', 'mapping_config', v_resource_id,
      jsonb_build_object(
        'mapping_type', v_before.mapping_type,
        'mapping_key', v_before.mapping_key,
        'promoted_to_version', v_promoted_to_version
      ),
      v_correlation_id::uuid, 'pending'
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'mapping_config_id', v_resource_id,
    'promoted_to_version', v_promoted_to_version,
    'revision', v_next_revision,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.mapping_config_promote_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mapping_config_promote_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mapping_config_promote_v1(jsonb) TO service_role;

COMMENT ON FUNCTION public.mapping_config_promote_v1(jsonb)
  IS 'Canonical write RPC: bump mapping_configs.mapping_version + append revision. Capability: mappings.write.';

SELECT pg_advisory_unlock(hashtext('202604280218_mapping_config_promote_v1'));
COMMIT;
