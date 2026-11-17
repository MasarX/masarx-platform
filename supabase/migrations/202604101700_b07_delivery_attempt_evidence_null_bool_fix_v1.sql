-- Plan: Batch 7 field execution platform hardening / Step: E07
-- Migration: Fix access-restricted evidence guard null boolean handling
-- Purpose:
-- - Keep the delivery-attempt evidence trigger fail-closed when optional JSON
--   branches are absent.
-- - Avoid SQL three-valued boolean leakage letting evidence-free
--   access_restricted completions bypass the guard.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604101700_b07_delivery_attempt_evidence_null_bool_fix_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.validate_delivery_attempt_evidence_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_payload JSONB := COALESCE(NEW.payload, '{}'::jsonb);
  v_resource_type TEXT := NULL;
  v_resource_id UUID := NULL;
  v_task_org UUID := NULL;
  v_stop_kind TEXT := NULL;
  v_exception_reason TEXT := NULL;
  v_has_notes BOOLEAN := FALSE;
  v_has_artifacts BOOLEAN := FALSE;
  v_has_geostamp BOOLEAN := FALSE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RETURN NEW;
  END IF;

  IF lower(COALESCE(NEW.to_status, '')) <> 'completed' THEN
    RETURN NEW;
  END IF;

  IF jsonb_typeof(v_payload) IS DISTINCT FROM 'object' THEN
    v_payload := '{}'::jsonb;
  END IF;

  SELECT
    t.resource_type,
    t.resource_id,
    t.organization_id
    INTO v_resource_type, v_resource_id, v_task_org
  FROM public.tasks t
  WHERE t.id = NEW.task_id
  LIMIT 1;

  IF v_resource_type IS DISTINCT FROM 'route_stop' OR v_resource_id IS NULL OR v_task_org IS NULL THEN
    NEW.payload := v_payload;
    RETURN NEW;
  END IF;

  SELECT lower(rs.stop_kind)
    INTO v_stop_kind
  FROM public.route_stops rs
  WHERE rs.id = v_resource_id
    AND rs.organization_id = v_task_org
  LIMIT 1;

  IF v_stop_kind IS DISTINCT FROM 'delivery' THEN
    NEW.payload := v_payload;
    RETURN NEW;
  END IF;

  v_exception_reason := lower(NULLIF(
    btrim(COALESCE(v_payload->>'exception_reason', v_payload->>'status_reason', '')),
    ''
  ));

  IF v_exception_reason IS DISTINCT FROM 'access_restricted' THEN
    NEW.payload := v_payload;
    RETURN NEW;
  END IF;

  v_has_notes := NULLIF(
    btrim(
      COALESCE(
        v_payload->>'exception_notes',
        v_payload->>'completion_notes',
        ''
      )
    ),
    ''
  ) IS NOT NULL;

  v_has_artifacts := (
    COALESCE(
      CASE
        WHEN jsonb_typeof(v_payload->'artifact_ids') = 'array' THEN jsonb_array_length(v_payload->'artifact_ids')
        ELSE 0
      END,
      0
    ) > 0
    OR NULLIF(btrim(COALESCE(v_payload->>'signature_artifact_id', '')), '') IS NOT NULL
    OR COALESCE(NULLIF(v_payload #>> '{exception_evidence,proof_artifact_count}', '')::int, 0) > 0
  );

  v_has_geostamp := COALESCE(jsonb_typeof(v_payload #> '{exception_evidence,geostamp}') = 'object', FALSE)
    OR COALESCE(jsonb_typeof(v_payload->'geostamp') = 'object', FALSE)
    OR COALESCE(jsonb_typeof(v_payload #> '{pod,geostamp}') = 'object', FALSE);

  IF NOT v_has_notes AND NOT v_has_artifacts AND NOT v_has_geostamp THEN
    RAISE EXCEPTION 'access_restricted delivery attempts require notes, proof artifacts, or a geostamp'
      USING ERRCODE = '23514';
  END IF;

  NEW.payload := v_payload;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.validate_delivery_attempt_evidence_v1()
  IS 'Before-insert task_events guard for access_restricted delivery attempts: require notes, proof artifacts, or geostamp evidence.';

SELECT pg_advisory_unlock(hashtext('202604101700_b07_delivery_attempt_evidence_null_bool_fix_v1'));
COMMIT;
