-- Migration: Label barcode observability preserve renderer metrics v1
-- Date: 2026-06-04
--
-- Shipment label completion must keep renderer barcode quality metrics in
-- renderer_metadata/decision_log while also recording the canonical box barcode.

BEGIN;
SELECT pg_advisory_lock(hashtext('202606042140_label_barcode_observability_preserve_renderer_metrics_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $do$
DECLARE
  v_signature REGPROCEDURE;
  v_def TEXT;
  v_old TEXT := $$v_normalized_renderer := jsonb_set(
            COALESCE(v_renderer, '{}'::jsonb),
            '{barcode}',
            to_jsonb(v_effective_barcode),
            true
        );$$;
  v_new TEXT := $$v_normalized_renderer := CASE
            WHEN jsonb_typeof(v_renderer->'barcode') = 'object' THEN
                jsonb_set(
                    COALESCE(v_renderer, '{}'::jsonb),
                    '{barcode}',
                    COALESCE(v_renderer->'barcode', '{}'::jsonb)
                      || jsonb_build_object(
                          'value', v_effective_barcode,
                          'canonical_value', v_effective_barcode,
                          'shipment_box_id', v_effective_box_id
                         ),
                    true
                )
            ELSE
                jsonb_set(
                    COALESCE(v_renderer, '{}'::jsonb),
                    '{barcode}',
                    to_jsonb(v_effective_barcode),
                    true
                )
        END;$$;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'public.complete_label_job(uuid,text,text,integer,jsonb,text)'::regprocedure,
    'public.complete_label_job_shipment_v1(uuid,text,text,integer,jsonb,text)'::regprocedure
  ]
  LOOP
    SELECT pg_get_functiondef(v_signature)
      INTO v_def;

    IF position('canonical_value' IN v_def) = 0 THEN
      IF position(v_old IN v_def) = 0 THEN
        RAISE EXCEPTION 'label barcode observability migration could not find renderer normalization block for %', v_signature;
      END IF;

      v_def := replace(v_def, v_old, v_new);
      EXECUTE v_def;
    END IF;
  END LOOP;
END;
$do$;

COMMENT ON FUNCTION public.complete_label_job(UUID, TEXT, TEXT, INTEGER, JSONB, TEXT)
  IS 'Mark a label job as succeeded or failed, keep shipment-backed labels current through canonical box identity while preserving renderer barcode metrics, and persist target-neutral renders in label_artifacts.';

COMMENT ON FUNCTION public.complete_label_job_shipment_v1(UUID, TEXT, TEXT, INTEGER, JSONB, TEXT)
  IS 'Normalize shipment label jobs to canonical shipment-box identity while preserving renderer barcode metrics before delegating to the shipment label completion base.';

SELECT pg_advisory_unlock(hashtext('202606042140_label_barcode_observability_preserve_renderer_metrics_v1'));
COMMIT;
