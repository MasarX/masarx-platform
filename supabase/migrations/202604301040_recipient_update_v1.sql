-- Spec-Issue: Phase B6 - Customer RPC contract: recipient_update_v1
-- Step: B6-RPC-22
-- Capability: recipients.write
-- Purpose: operator-side recipient correction (NDR triage). Updates editable
--          fields on public.recipients + decision_log + domain_event.
--          Editable fields: name, phone_number, email, preferred_language,
--          preferred_comm_channel, quiet_hours_start, quiet_hours_end,
--          communication_preferences, external_id.
--          Distinct from any future portal self-edit RPC (which is SPLIT to
--          portal per __audit__/CROSSWALK/CUSTOMERS.md §4.3).
-- Note: phone canonicalization is handled by the existing trigger from
--       202512141200_recipients_phone_canonicalization.sql; this RPC just
--       writes the raw value and lets the trigger resolve.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604301040_recipient_update_v1'));
SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.recipient_update_v1(p_args jsonb)
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
  v_resource_id UUID := NULLIF(p_args->>'recipient_id', '')::uuid;
  v_before public.recipients%ROWTYPE;
  v_changed JSONB := '{}'::jsonb;
  v_no_op BOOLEAN := TRUE;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'recipient_update_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('recipients.write');

  IF v_resource_id IS NULL THEN
    RAISE EXCEPTION 'recipient_update_v1 requires recipient_id'
      USING ERRCODE = '23502';
  END IF;

  SELECT * INTO v_before FROM public.recipients WHERE id = v_resource_id FOR UPDATE;
  IF v_before.id IS NULL THEN
    RAISE EXCEPTION 'recipient_update_v1 recipient % not found', v_resource_id
      USING ERRCODE = '23503';
  END IF;
  IF v_org_id IS NOT NULL
     AND v_before.organization_id <> v_org_id
     AND NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'recipient_update_v1 recipient % outside tenant scope', v_resource_id
      USING ERRCODE = '42501';
  END IF;

  IF p_args ? 'name' THEN
    UPDATE public.recipients SET name = btrim(p_args->>'name'), updated_at = now()
      WHERE id = v_resource_id;
    v_changed := v_changed || jsonb_build_object('name', p_args->>'name');
    v_no_op := FALSE;
  END IF;
  IF p_args ? 'phone_number' THEN
    UPDATE public.recipients SET
      phone_number = btrim(p_args->>'phone_number'),
      phone_validation_status = 'pending',
      phone_validated_at = NULL,
      updated_at = now()
      WHERE id = v_resource_id;
    v_changed := v_changed || jsonb_build_object('phone_number', p_args->>'phone_number');
    v_no_op := FALSE;
  END IF;
  IF p_args ? 'email' THEN
    UPDATE public.recipients SET email = NULLIF(btrim(p_args->>'email'), ''), updated_at = now()
      WHERE id = v_resource_id;
    v_changed := v_changed || jsonb_build_object('email', p_args->>'email');
    v_no_op := FALSE;
  END IF;
  IF p_args ? 'external_id' THEN
    UPDATE public.recipients SET
      external_id = NULLIF(btrim(p_args->>'external_id'), ''),
      updated_at = now()
      WHERE id = v_resource_id;
    v_changed := v_changed || jsonb_build_object('external_id', p_args->>'external_id');
    v_no_op := FALSE;
  END IF;
  IF p_args ? 'preferred_language' THEN
    UPDATE public.recipients SET preferred_language = p_args->>'preferred_language', updated_at = now()
      WHERE id = v_resource_id;
    v_changed := v_changed || jsonb_build_object('preferred_language', p_args->>'preferred_language');
    v_no_op := FALSE;
  END IF;
  IF p_args ? 'preferred_comm_channel' THEN
    UPDATE public.recipients SET preferred_comm_channel = p_args->>'preferred_comm_channel', updated_at = now()
      WHERE id = v_resource_id;
    v_changed := v_changed || jsonb_build_object('preferred_comm_channel', p_args->>'preferred_comm_channel');
    v_no_op := FALSE;
  END IF;
  IF p_args ? 'quiet_hours_start' THEN
    UPDATE public.recipients SET
      quiet_hours_start = NULLIF(p_args->>'quiet_hours_start', '')::time,
      updated_at = now()
      WHERE id = v_resource_id;
    v_changed := v_changed || jsonb_build_object('quiet_hours_start', p_args->>'quiet_hours_start');
    v_no_op := FALSE;
  END IF;
  IF p_args ? 'quiet_hours_end' THEN
    UPDATE public.recipients SET
      quiet_hours_end = NULLIF(p_args->>'quiet_hours_end', '')::time,
      updated_at = now()
      WHERE id = v_resource_id;
    v_changed := v_changed || jsonb_build_object('quiet_hours_end', p_args->>'quiet_hours_end');
    v_no_op := FALSE;
  END IF;
  IF p_args ? 'communication_preferences' THEN
    UPDATE public.recipients SET
      communication_preferences = p_args->'communication_preferences',
      updated_at = now()
      WHERE id = v_resource_id;
    v_changed := v_changed || jsonb_build_object('communication_preferences', p_args->'communication_preferences');
    v_no_op := FALSE;
  END IF;

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, v_before.organization_id, 'recipients.update', 'recipient', v_resource_id,
    'recipient_update_v1', CASE WHEN v_no_op THEN 'no_op' ELSE 'updated' END,
    v_changed, 'recipient_update_v1', v_correlation_id::uuid
  );

  IF NOT v_no_op THEN
    INSERT INTO public.domain_events (
      organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
    ) VALUES (
      v_before.organization_id, 'recipient.updated', 'recipient', v_resource_id,
      v_changed, v_correlation_id::uuid, 'pending'
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'recipient_id', v_resource_id,
    'idempotent_no_op', v_no_op,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.recipient_update_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.recipient_update_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.recipient_update_v1(jsonb) TO service_role;

COMMENT ON FUNCTION public.recipient_update_v1(jsonb)
  IS 'Canonical write RPC: update editable public.recipients fields (operator NDR triage) + decision_log + domain_event. Capability: recipients.write. Distinct from future portal self-edit.';

SELECT pg_advisory_unlock(hashtext('202604301040_recipient_update_v1'));
COMMIT;
