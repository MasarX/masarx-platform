-- Plan: Batch 8 proof-of-delivery signature contract / Step: E01
-- Migration: delivery handover signature requirement + task_event enforcement + dispatch evidence signature paths
-- Purpose:
-- - Keep POD signature requirements row-driven through canonical delivery_handover_mode lookup metadata.
-- - Enforce signature-required delivery completions at the canonical task_events write path.
-- - Normalize signature artifacts into task payload evidence so route_stop_finalize links them without app-specific branching.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604031330_pod_signature_required_handover_contract_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) delivery_handover_mode metadata: signature requirement is lookup-row driven
-------------------------------------------------------------------------------

UPDATE public.lookup_values lv
   SET metadata = jsonb_strip_nulls(
         COALESCE(lv.metadata, '{}'::jsonb)
         || jsonb_build_object(
           'requires_signature',
           CASE
             WHEN lower(lv.value) IN ('named_recipient', 'recipient_class') THEN TRUE
             ELSE FALSE
           END
         )
       ),
       updated_at = now()
 FROM public.lookup_definitions ld
 WHERE ld.id = lv.lookup_definition_id
   AND ld.category = 'delivery_handover_mode'
   AND COALESCE(lv.status, 'active') = 'active'
   AND (lv.effective_from IS NULL OR lv.effective_from <= now())
   AND (lv.effective_until IS NULL OR lv.effective_until > now());

-------------------------------------------------------------------------------
-- 2) dispatch_evidence_policy: signature artifacts must be extractable from canonical POD paths
-------------------------------------------------------------------------------

WITH target_rows AS (
  SELECT
    s.id AS settings_id,
    s.settings_version_id,
    sv.version,
    sv.value
  FROM public.settings s
  JOIN public.settings_versions sv
    ON sv.id = s.settings_version_id
  WHERE s.category = 'dispatch_evidence_policy'
    AND s.scope_type = 'global'
    AND s.scope_id IS NULL
),
rewritten AS (
  SELECT
    tr.settings_id,
    tr.settings_version_id,
    tr.version,
    tr.value,
    jsonb_set(
      COALESCE(tr.value, '{}'::jsonb),
      '{artifact_id_paths}',
      jsonb_build_array(
        '$.artifact_ids[*]',
        '$.signature_artifact_id',
        '$.pod.signature_artifact_id',
        '$.exception_evidence.signature_artifact_id'
      ),
      TRUE
    ) AS next_value
  FROM target_rows tr
),
changed AS (
  SELECT
    r.settings_id,
    r.settings_version_id,
    r.version,
    r.next_value
  FROM rewritten r
  WHERE r.next_value IS DISTINCT FROM r.value
),
applied AS (
  UPDATE public.settings_versions sv
     SET value = c.next_value,
         version = COALESCE(c.version, 0) + 1,
         change_reason = 'Expand dispatch evidence artifact paths for POD signature capture',
         approved_at = now(),
         effective_from = now()
    FROM changed c
   WHERE sv.id = c.settings_version_id
  RETURNING sv.id, sv.value, c.settings_id
)
UPDATE public.settings s
   SET cached_value = a.value,
       last_updated = now()
  FROM applied a
 WHERE s.id = a.settings_id;

-------------------------------------------------------------------------------
-- 3) task_events trigger: delivery handover modes can require signature artifacts
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.enforce_delivery_signature_task_event_v1()
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
  v_handover_mode TEXT := NULL;
  v_requires_signature BOOLEAN := FALSE;
  v_signature_artifact_id UUID := NULL;
  v_signature_artifact_text TEXT := NULL;
  v_artifact_ids JSONB := '[]'::jsonb;
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

  v_handover_mode := lower(
    NULLIF(
      btrim(
        COALESCE(
          v_payload->>'handover_mode',
          v_payload #>> '{pod,handover_mode}',
          ''
        )
      ),
      ''
    )
  );

  IF v_handover_mode IS NULL THEN
    NEW.payload := v_payload;
    RETURN NEW;
  END IF;

  SELECT COALESCE((lv.metadata->>'requires_signature')::boolean, FALSE)
    INTO v_requires_signature
  FROM public.lookup_values lv
  JOIN public.lookup_definitions ld
    ON ld.id = lv.lookup_definition_id
  WHERE ld.category = 'delivery_handover_mode'
    AND lower(lv.value) = v_handover_mode
    AND COALESCE(lv.status, 'active') = 'active'
    AND (lv.effective_from IS NULL OR lv.effective_from <= now())
    AND (lv.effective_until IS NULL OR lv.effective_until > now())
  ORDER BY lv.sort_order NULLS LAST, lv.created_at, lv.id
  LIMIT 1;

  BEGIN
    v_signature_artifact_id := NULLIF(
      btrim(
        COALESCE(
          v_payload->>'signature_artifact_id',
          v_payload #>> '{pod,signature_artifact_id}',
          ''
        )
      ),
      ''
    )::uuid;
  EXCEPTION
    WHEN others THEN
      RAISE EXCEPTION 'delivery signature_artifact_id must be a valid uuid'
        USING ERRCODE = '23514';
  END;

  IF v_requires_signature AND v_signature_artifact_id IS NULL THEN
    RAISE EXCEPTION 'delivery handover mode % requires signature_artifact_id', v_handover_mode
      USING ERRCODE = '23514';
  END IF;

  IF v_signature_artifact_id IS NOT NULL THEN
    v_signature_artifact_text := v_signature_artifact_id::text;
    v_payload := jsonb_set(v_payload, '{signature_artifact_id}', to_jsonb(v_signature_artifact_text), TRUE);
    v_payload := jsonb_set(v_payload, '{pod,signature_artifact_id}', to_jsonb(v_signature_artifact_text), TRUE);

    v_artifact_ids := COALESCE(v_payload->'artifact_ids', '[]'::jsonb);
    IF jsonb_typeof(v_artifact_ids) IS DISTINCT FROM 'array' THEN
      v_artifact_ids := '[]'::jsonb;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(v_artifact_ids) AS artifact_id(value)
      WHERE artifact_id.value = v_signature_artifact_text
    ) THEN
      v_artifact_ids := v_artifact_ids || jsonb_build_array(v_signature_artifact_text);
      v_payload := jsonb_set(v_payload, '{artifact_ids}', v_artifact_ids, TRUE);
    END IF;
  END IF;

  NEW.payload := v_payload;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.enforce_delivery_signature_task_event_v1()
  IS 'Before-insert task_events guard for delivery completions: enforce signature-required handover modes and normalize signature evidence into payload.artifact_ids.';

DROP TRIGGER IF EXISTS trg_task_events_delivery_signature_enforce ON public.task_events;
CREATE TRIGGER trg_task_events_delivery_signature_enforce
  BEFORE INSERT ON public.task_events
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_delivery_signature_task_event_v1();

SELECT pg_advisory_unlock(hashtext('202604031330_pod_signature_required_handover_contract_v1'));
COMMIT;
