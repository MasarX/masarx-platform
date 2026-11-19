-- Console V2 webhook HMAC governance readback.
--
-- HMAC pass/fail decisions were logged to decision_log, but the canonical
-- webhook_inbox ack fields were left without the final validation payload.
-- Console V2 readiness requires operator-facing inbox readback to carry the
-- same backend validation proof without app-side re-derivation.

SELECT pg_advisory_lock(hashtext('202605140045_webhook_hmac_ack_validation_persistence_v1'));

DO $patch$
DECLARE
  v_def TEXT;
  v_old TEXT;
  v_new TEXT;
BEGIN
  SELECT pg_get_functiondef('public.workflow_intake_webhook_core_v1(text,jsonb,text,jsonb)'::regprocedure)
    INTO v_def;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'public.workflow_intake_webhook_core_v1(text,jsonb,text,jsonb) not found';
  END IF;

  v_old := $old$
  UPDATE webhook_inbox
     SET processing_status = CASE WHEN v_ack_outcome = 'ack_failed' THEN 'failed' ELSE 'in_progress' END,
         organization_id = COALESCE(organization_id, v_organization_id),
         policy_scope_type = v_policy_scope_type,
         policy_scope_id = v_policy_scope_id,
         policy_settings_id = v_policy_settings_id,
         policy_version = v_policy_version,
         updated_at = now()
   WHERE id = v_webhook_id;
$old$;

  v_new := $new$
  UPDATE webhook_inbox
     SET processing_status = CASE WHEN v_ack_outcome = 'ack_failed' THEN 'failed' ELSE 'in_progress' END,
         organization_id = COALESCE(organization_id, v_organization_id),
         policy_scope_type = v_policy_scope_type,
         policy_scope_id = v_policy_scope_id,
         policy_settings_id = v_policy_settings_id,
         policy_version = v_policy_version,
         ack_status_code = v_ack_status,
         ack_body = v_ack_body,
         ack_outcome = v_ack_outcome,
         ack_reason = v_ack_reason,
         ack_validation = COALESCE(v_validation, '{}'::jsonb),
         updated_at = now()
   WHERE id = v_webhook_id;
$new$;

  IF position(v_new IN v_def) > 0 THEN
    -- Already patched.
    RETURN;
  END IF;

  IF position(v_old IN v_def) = 0 THEN
    RAISE EXCEPTION 'workflow_intake_webhook_core_v1 ack persistence block not found';
  END IF;

  EXECUTE replace(v_def, v_old, v_new);
END;
$patch$;

COMMENT ON FUNCTION public.workflow_intake_webhook_core_v1(TEXT, JSONB, TEXT, JSONB)
  IS 'Canonical webhook intake engine. Persists ack status/body/outcome/reason/validation to webhook_inbox so Console V2 can prove HMAC/idempotency governance from backend readback.';

CREATE OR REPLACE FUNCTION public.webhook_inbox_ack_failed_status_guard_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
  IF NEW.ack_outcome = 'ack_failed' THEN
    NEW.processing_status := 'failed';
    NEW.lease_expires_at := NULL;
    NEW.error_message := COALESCE(NULLIF(NEW.error_message, ''), NULLIF(NEW.ack_reason, ''));
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS webhook_inbox_ack_failed_status_guard
  ON public.webhook_inbox;

CREATE TRIGGER webhook_inbox_ack_failed_status_guard
BEFORE INSERT OR UPDATE OF ack_outcome, ack_status_code, ack_reason, ack_validation, processing_status
ON public.webhook_inbox
FOR EACH ROW
EXECUTE FUNCTION public.webhook_inbox_ack_failed_status_guard_v1();

UPDATE public.webhook_inbox
   SET processing_status = 'failed',
       lease_expires_at = NULL,
       error_message = COALESCE(NULLIF(error_message, ''), NULLIF(ack_reason, ''))
 WHERE ack_outcome = 'ack_failed'
   AND processing_status IS DISTINCT FROM 'failed';

COMMENT ON FUNCTION public.webhook_inbox_ack_failed_status_guard_v1()
  IS 'Fail-closed guard: any webhook inbox row with ack_failed is terminal failed for Console V2 operator readback.';

SELECT pg_advisory_unlock(hashtext('202605140045_webhook_hmac_ack_validation_persistence_v1'));
