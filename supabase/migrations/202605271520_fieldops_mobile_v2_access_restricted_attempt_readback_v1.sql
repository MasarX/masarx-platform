-- FieldOps Mobile V2 access-restricted attempt readback.
--
-- Keeps the failed-delivery reason taxonomy row-driven through
-- mobile_pod_policy and lets the existing delivery-attempt evidence guard
-- recognize the nested Mobile V2 POD failure payload shape.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605271520_fieldops_mobile_v2_access_restricted_attempt_readback_v1'));

WITH reason AS (
  SELECT jsonb_build_object(
    'code', 'access_restricted',
    'label', 'Access restricted',
    'reattempt', TRUE,
    'photo', FALSE,
    'note', TRUE,
    'escalate', FALSE,
    'cod_only', FALSE
  ) AS value
),
patched AS (
  SELECT
    sv.id,
    sv.scope_hash,
    jsonb_set(
      COALESCE(sv.value, '{}'::jsonb),
      '{fail_reasons}',
      COALESCE(sv.value->'fail_reasons', '[]'::jsonb) || jsonb_build_array(reason.value),
      TRUE
    ) AS value
  FROM public.settings_versions sv
  CROSS JOIN reason
  WHERE sv.category = 'mobile_pod_policy'
    AND sv.effective_until IS NULL
    AND sv.approved_at IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(sv.value->'fail_reasons', '[]'::jsonb)) AS item(row)
      WHERE item.row->>'code' = 'access_restricted'
    )
)
UPDATE public.settings_versions sv
   SET value = patched.value
  FROM patched
 WHERE sv.id = patched.id
   AND sv.scope_hash = patched.scope_hash;

WITH reason AS (
  SELECT jsonb_build_object(
    'code', 'access_restricted',
    'label', 'Access restricted',
    'reattempt', TRUE,
    'photo', FALSE,
    'note', TRUE,
    'escalate', FALSE,
    'cod_only', FALSE
  ) AS value
),
patched AS (
  SELECT
    s.id,
    jsonb_set(
      COALESCE(s.cached_value, '{}'::jsonb),
      '{fail_reasons}',
      COALESCE(s.cached_value->'fail_reasons', '[]'::jsonb) || jsonb_build_array(reason.value),
      TRUE
    ) AS cached_value
  FROM public.settings s
  CROSS JOIN reason
  WHERE s.category = 'mobile_pod_policy'
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(s.cached_value->'fail_reasons', '[]'::jsonb)) AS item(row)
      WHERE item.row->>'code' = 'access_restricted'
    )
)
UPDATE public.settings s
   SET cached_value = patched.cached_value,
       last_updated = now()
  FROM patched
 WHERE s.id = patched.id;

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
  v_nested_artifact_ids JSONB := '[]'::jsonb;
  v_nested_artifact_count_text TEXT := NULL;
  v_nested_artifact_count INT := 0;
  v_flat_artifact_count_text TEXT := NULL;
  v_flat_artifact_count INT := 0;
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
        v_payload #>> '{pod,evidence,exception_notes}',
        v_payload #>> '{pod,evidence,failure_note}',
        v_payload #>> '{pod,evidence,failed_delivery,note}',
        ''
      )
    ),
    ''
  ) IS NOT NULL;

  v_nested_artifact_ids := COALESCE(
    v_payload #> '{pod,evidence,exception_evidence,artifact_ids}',
    v_payload #> '{pod,evidence,failure_artifact_ids}',
    v_payload #> '{pod,evidence,failed_delivery,artifact_ids}',
    '[]'::jsonb
  );
  IF jsonb_typeof(v_nested_artifact_ids) IS DISTINCT FROM 'array' THEN
    v_nested_artifact_ids := '[]'::jsonb;
  END IF;

  v_nested_artifact_count_text := NULLIF(
    btrim(COALESCE(v_payload #>> '{pod,evidence,exception_evidence,proof_artifact_count}', '')),
    ''
  );
  IF v_nested_artifact_count_text ~ '^[0-9]+$' THEN
    v_nested_artifact_count := v_nested_artifact_count_text::int;
  END IF;

  v_flat_artifact_count_text := NULLIF(
    btrim(COALESCE(v_payload #>> '{exception_evidence,proof_artifact_count}', '')),
    ''
  );
  IF v_flat_artifact_count_text ~ '^[0-9]+$' THEN
    v_flat_artifact_count := v_flat_artifact_count_text::int;
  END IF;

  v_has_artifacts := (
    COALESCE(
      CASE
        WHEN jsonb_typeof(v_payload->'artifact_ids') = 'array' THEN jsonb_array_length(v_payload->'artifact_ids')
        ELSE 0
      END,
      0
    ) > 0
    OR NULLIF(btrim(COALESCE(v_payload->>'signature_artifact_id', '')), '') IS NOT NULL
    OR v_flat_artifact_count > 0
    OR jsonb_array_length(v_nested_artifact_ids) > 0
    OR v_nested_artifact_count > 0
  );

  v_has_geostamp := COALESCE(jsonb_typeof(v_payload #> '{exception_evidence,geostamp}') = 'object', FALSE)
    OR COALESCE(jsonb_typeof(v_payload->'geostamp') = 'object', FALSE)
    OR COALESCE(jsonb_typeof(v_payload #> '{pod,geostamp}') = 'object', FALSE)
    OR COALESCE(jsonb_typeof(v_payload #> '{pod,evidence,geostamp}') = 'object', FALSE)
    OR COALESCE(jsonb_typeof(v_payload #> '{pod,evidence,exception_evidence,geostamp}') = 'object', FALSE)
    OR COALESCE(jsonb_typeof(v_payload #> '{pod,evidence,failed_delivery,geostamp}') = 'object', FALSE);

  IF NOT v_has_notes AND NOT v_has_artifacts AND NOT v_has_geostamp THEN
    RAISE EXCEPTION 'access_restricted delivery attempts require notes, proof artifacts, or a geostamp'
      USING ERRCODE = '23514';
  END IF;

  NEW.payload := v_payload;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.validate_delivery_attempt_evidence_v1() IS
  'Before-insert task_events guard for access_restricted delivery attempts: require notes, proof artifacts, or geostamp evidence, including nested Mobile V2 POD failure evidence.';

SELECT pg_advisory_unlock(hashtext('202605271520_fieldops_mobile_v2_access_restricted_attempt_readback_v1'));
COMMIT;
