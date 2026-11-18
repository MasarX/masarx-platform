-- Migration: guard direct shipment label completion with canonical box identity.
-- Purpose:
--   - complete_label_job already normalizes shipment labels before delegating to
--     the preserved shipment completion function.
--   - Direct calls to complete_label_job_shipment_v1 must resolve shipment boxes
--     first too, so a renderer-provided base tracking barcode cannot create a
--     duplicate stable labels row for one-box shipments.

BEGIN;

SET search_path TO public, extensions, pg_temp;

DO $$
BEGIN
    IF to_regprocedure('public.complete_label_job_shipment_base_v1(uuid,text,text,integer,jsonb,text)') IS NULL THEN
        IF to_regprocedure('public.complete_label_job_shipment_v1(uuid,text,text,integer,jsonb,text)') IS NULL THEN
            RAISE EXCEPTION 'complete_label_job_shipment_v1(uuid,text,text,integer,jsonb,text) is missing';
        END IF;

        ALTER FUNCTION public.complete_label_job_shipment_v1(
            UUID,
            TEXT,
            TEXT,
            INTEGER,
            JSONB,
            TEXT
        ) RENAME TO complete_label_job_shipment_base_v1;
    ELSE
        RAISE NOTICE 'complete_label_job_shipment_base_v1 already exists; preserving existing base implementation';
    END IF;
END $$;

CREATE OR REPLACE FUNCTION public.complete_label_job_shipment_v1(
    p_job_id UUID,
    p_status TEXT,
    p_file_url TEXT,
    p_file_size_bytes INTEGER,
    p_renderer_metadata JSONB DEFAULT NULL::jsonb,
    p_error_reason TEXT DEFAULT NULL::text
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
    v_job public.label_jobs%ROWTYPE;
    v_now TIMESTAMPTZ := now();
    v_renderer JSONB := COALESCE(p_renderer_metadata, '{}'::jsonb);
    v_normalized_renderer JSONB := COALESCE(p_renderer_metadata, '{}'::jsonb);
    v_effective_box_id UUID := NULL;
    v_effective_barcode TEXT := NULL;
    v_box_count INTEGER := 0;
    v_canonical_label_id UUID := NULL;
    v_job_label_barcode TEXT := NULL;
BEGIN
    SELECT *
      INTO v_job
      FROM public.label_jobs
     WHERE id = p_job_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Label job % not found', p_job_id;
    END IF;

    IF lower(p_status) = 'succeeded'
       AND v_job.shipment_id IS NOT NULL
       AND NOT (lower(v_job.status) = 'succeeded' AND v_job.completed_at IS NOT NULL) THEN
        SELECT sb.id, sb.barcode
          INTO v_effective_box_id, v_effective_barcode
          FROM public.shipment_boxes sb
         WHERE sb.shipment_id = v_job.shipment_id
           AND sb.id = COALESCE(v_job.shipment_box_id, v_job.target_box_id)
         LIMIT 1;

        IF v_effective_box_id IS NULL THEN
            SELECT sb.id, sb.barcode
              INTO v_effective_box_id, v_effective_barcode
              FROM public.shipment_boxes sb
             WHERE sb.shipment_id = v_job.shipment_id
               AND sb.barcode = NULLIF(v_renderer ->> 'barcode', '')
             ORDER BY sb.box_number
             LIMIT 1;
        END IF;

        IF v_effective_box_id IS NULL THEN
            SELECT COUNT(*)::int
              INTO v_box_count
              FROM public.shipment_boxes sb
             WHERE sb.shipment_id = v_job.shipment_id;

            IF v_box_count = 1 THEN
                SELECT sb.id, sb.barcode
                  INTO v_effective_box_id, v_effective_barcode
                  FROM public.shipment_boxes sb
                 WHERE sb.shipment_id = v_job.shipment_id
                 ORDER BY sb.box_number
                 LIMIT 1;
            ELSIF v_box_count > 1 THEN
                RAISE EXCEPTION 'Shipment label job % requires shipment_box_id for multi-box shipment %',
                    p_job_id, v_job.shipment_id;
            END IF;
        END IF;

        IF v_effective_barcode IS NULL THEN
            RAISE EXCEPTION 'Unable to resolve shipment-box barcode for label job %', p_job_id;
        END IF;

        SELECT l.id
          INTO v_canonical_label_id
          FROM public.labels l
         WHERE l.shipment_id = v_job.shipment_id
           AND l.barcode = v_effective_barcode
         ORDER BY l.generated_at DESC NULLS LAST, l.created_at DESC
         LIMIT 1;

        IF v_job.label_id IS NOT NULL THEN
            SELECT l.barcode
              INTO v_job_label_barcode
              FROM public.labels l
             WHERE l.id = v_job.label_id
               AND l.shipment_id = v_job.shipment_id
             FOR UPDATE;

            IF v_job_label_barcode = v_effective_barcode THEN
                v_canonical_label_id := COALESCE(v_canonical_label_id, v_job.label_id);
            ELSIF v_job_label_barcode IS NOT NULL AND v_canonical_label_id IS NULL THEN
                UPDATE public.labels
                   SET barcode = v_effective_barcode,
                       metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                           'canonical_box_barcode_repaired_at', v_now,
                           'legacy_renderer_barcode', v_job_label_barcode
                       ),
                       updated_at = v_now
                 WHERE id = v_job.label_id
                   AND shipment_id = v_job.shipment_id;

                v_canonical_label_id := v_job.label_id;
            END IF;
        END IF;

        IF v_canonical_label_id IS NULL THEN
            SELECT l.id, l.barcode
              INTO v_canonical_label_id, v_job_label_barcode
              FROM public.labels l
              JOIN public.shipments s
                ON s.id = l.shipment_id
             WHERE l.shipment_id = v_job.shipment_id
               AND l.barcode = s.tracking_number
             ORDER BY l.generated_at DESC NULLS LAST, l.created_at DESC
             LIMIT 1
             FOR UPDATE;

            IF v_canonical_label_id IS NOT NULL THEN
                UPDATE public.labels
                   SET barcode = v_effective_barcode,
                       metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                           'canonical_box_barcode_repaired_at', v_now,
                           'legacy_renderer_barcode', v_job_label_barcode
                       ),
                       updated_at = v_now
                 WHERE id = v_canonical_label_id
                   AND shipment_id = v_job.shipment_id;
            END IF;
        END IF;

        IF v_canonical_label_id IS NOT NULL THEN
            PERFORM public.merge_shipment_box_label_identity_v1(
                v_job.shipment_id,
                v_canonical_label_id,
                v_effective_barcode,
                v_effective_box_id
            );
        END IF;

        v_normalized_renderer := jsonb_set(
            COALESCE(v_renderer, '{}'::jsonb),
            '{barcode}',
            to_jsonb(v_effective_barcode),
            true
        );

        UPDATE public.label_jobs
           SET shipment_box_id = COALESCE(shipment_box_id, v_effective_box_id),
               target_type = COALESCE(target_type, 'shipment'),
               target_id = COALESCE(target_id, v_job.shipment_id),
               target_box_id = COALESCE(target_box_id, v_effective_box_id),
               target_metadata = COALESCE(target_metadata, '{}'::jsonb)
                   || jsonb_build_object(
                        'shipment_id', v_job.shipment_id,
                        'shipment_box_id', v_effective_box_id,
                        'barcode', v_effective_barcode
                      ),
               label_id = COALESCE(v_canonical_label_id, label_id)
         WHERE id = v_job.id;

        PERFORM public.complete_label_job_shipment_base_v1(
            p_job_id,
            p_status,
            p_file_url,
            p_file_size_bytes,
            v_normalized_renderer,
            p_error_reason
        );
        RETURN;
    END IF;

    PERFORM public.complete_label_job_shipment_base_v1(
        p_job_id,
        p_status,
        p_file_url,
        p_file_size_bytes,
        p_renderer_metadata,
        p_error_reason
    );
END;
$function$;

COMMENT ON FUNCTION public.complete_label_job_shipment_v1(UUID, TEXT, TEXT, INTEGER, JSONB, TEXT)
    IS 'Shipment label completion guard that resolves shipment_boxes.barcode before delegating to the preserved shipment completion implementation.';

REVOKE ALL ON FUNCTION public.complete_label_job_shipment_v1(UUID, TEXT, TEXT, INTEGER, JSONB, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_label_job_shipment_v1(UUID, TEXT, TEXT, INTEGER, JSONB, TEXT) TO edge_label_renderer_role;

REVOKE ALL ON FUNCTION public.complete_label_job_shipment_base_v1(UUID, TEXT, TEXT, INTEGER, JSONB, TEXT) FROM PUBLIC;

DO $$
DECLARE
    rec RECORD;
BEGIN
    FOR rec IN
        SELECT rolname
          FROM pg_roles
         WHERE rolname IN ('anon', 'authenticated', 'service_role', 'edge_label_renderer_role', 'label_renderer_role')
    LOOP
        EXECUTE format(
            'REVOKE ALL ON FUNCTION public.complete_label_job_shipment_base_v1(UUID, TEXT, TEXT, INTEGER, JSONB, TEXT) FROM %I',
            rec.rolname
        );
    END LOOP;
END $$;

COMMIT;
