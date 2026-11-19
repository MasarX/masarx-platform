-- Migration: harden shipment label completion around canonical box label identity.
-- Purpose:
--   - Shipment labels are box labels: the stable labels.barcode identity must
--     resolve from shipment_boxes.barcode, never renderer-supplied tracking-only
--     payloads.
--   - Existing one-box legacy duplicates are merged into the canonical box label
--     so Console V2 does not show both base-tracking and box-label identities.

BEGIN;

SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.merge_shipment_box_label_identity_v1(
    p_shipment_id UUID,
    p_canonical_label_id UUID,
    p_canonical_barcode TEXT,
    p_shipment_box_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
    rec RECORD;
    v_now TIMESTAMPTZ := now();
    v_active_version_id UUID;
    v_active_version_number INTEGER;
BEGIN
    IF p_shipment_id IS NULL OR p_canonical_label_id IS NULL OR NULLIF(p_canonical_barcode, '') IS NULL THEN
        RETURN;
    END IF;

    FOR rec IN
        SELECT
            legacy.id AS legacy_label_id,
            p_canonical_label_id AS canonical_label_id,
            legacy.shipment_id,
            legacy.organization_id,
            p_shipment_box_id AS shipment_box_id,
            p_canonical_barcode AS canonical_barcode,
            legacy.barcode AS legacy_barcode
        FROM public.labels legacy
        JOIN public.shipments s
          ON s.id = legacy.shipment_id
        WHERE legacy.shipment_id = p_shipment_id
          AND legacy.id <> p_canonical_label_id
          AND legacy.barcode = s.tracking_number
    LOOP
        UPDATE public.label_jobs
           SET label_id = rec.canonical_label_id,
               shipment_box_id = COALESCE(shipment_box_id, rec.shipment_box_id),
               target_type = COALESCE(target_type, 'shipment'),
               target_id = COALESCE(target_id, rec.shipment_id),
               target_box_id = COALESCE(target_box_id, rec.shipment_box_id),
               target_metadata = COALESCE(target_metadata, '{}'::jsonb)
                   || jsonb_build_object(
                        'shipment_id', rec.shipment_id,
                        'shipment_box_id', rec.shipment_box_id,
                        'barcode', rec.canonical_barcode,
                        'merged_legacy_label_id', rec.legacy_label_id
                      )
         WHERE shipment_id = rec.shipment_id
           AND (label_id = rec.legacy_label_id OR label_id = rec.canonical_label_id);

        WITH ordered AS (
            SELECT
                lv.id,
                row_number() OVER (
                    ORDER BY lv.generated_at NULLS LAST, lv.created_at NULLS LAST, lv.id
                )::int AS rn
            FROM public.label_versions lv
            WHERE lv.shipment_id = rec.shipment_id
              AND lv.label_id IN (rec.legacy_label_id, rec.canonical_label_id)
        )
        UPDATE public.label_versions lv
           SET label_id = rec.canonical_label_id,
               version_number = -ordered.rn,
               version_status = 'superseded',
               barcode = rec.canonical_barcode,
               superseded_at = COALESCE(lv.superseded_at, v_now),
               metadata = COALESCE(lv.metadata, '{}'::jsonb)
                   || jsonb_strip_nulls(jsonb_build_object(
                        'merged_legacy_label_id', CASE
                            WHEN lv.label_id = rec.legacy_label_id THEN rec.legacy_label_id
                            ELSE NULL
                        END,
                        'legacy_barcode', CASE
                            WHEN lv.label_id = rec.legacy_label_id THEN rec.legacy_barcode
                            ELSE NULL
                        END
                      )),
               updated_at = v_now
          FROM ordered
         WHERE lv.id = ordered.id;

        SELECT lv.id
          INTO v_active_version_id
          FROM public.label_versions lv
         WHERE lv.shipment_id = rec.shipment_id
           AND lv.label_id = rec.canonical_label_id
         ORDER BY lv.generated_at DESC NULLS LAST, lv.created_at DESC NULLS LAST, lv.id DESC
         LIMIT 1;

        WITH ordered AS (
            SELECT
                lv.id,
                row_number() OVER (
                    ORDER BY lv.generated_at NULLS LAST, lv.created_at NULLS LAST, lv.id
                )::int AS rn
            FROM public.label_versions lv
            WHERE lv.shipment_id = rec.shipment_id
              AND lv.label_id = rec.canonical_label_id
        )
        UPDATE public.label_versions lv
           SET version_number = ordered.rn,
               version_status = CASE
                   WHEN lv.id = v_active_version_id THEN 'active'
                   ELSE 'superseded'
               END,
               superseded_by_version_id = CASE
                   WHEN lv.id = v_active_version_id THEN NULL
                   ELSE COALESCE(lv.superseded_by_version_id, v_active_version_id)
               END,
               superseded_at = CASE
                   WHEN lv.id = v_active_version_id THEN NULL
                   ELSE COALESCE(lv.superseded_at, v_now)
               END,
               updated_at = v_now
          FROM ordered
         WHERE lv.id = ordered.id;

        SELECT lv.version_number
          INTO v_active_version_number
          FROM public.label_versions lv
         WHERE lv.id = v_active_version_id;

        UPDATE public.labels l
           SET active_version_id = v_active_version_id,
               active_version_number = v_active_version_number,
               file_url = COALESCE(lv.file_url, l.file_url),
               file_size_bytes = COALESCE(lv.file_size_bytes, l.file_size_bytes),
               generated_by = COALESCE(lv.generated_by, l.generated_by),
               generated_at = COALESCE(lv.generated_at, l.generated_at),
               last_printed_at = COALESCE(lv.last_printed_at, l.last_printed_at),
               print_count = COALESCE(lv.print_count, l.print_count),
               metadata = COALESCE(l.metadata, '{}'::jsonb)
                   || jsonb_build_object(
                        'merged_legacy_label_id', rec.legacy_label_id,
                        'legacy_barcode', rec.legacy_barcode
                      ),
               updated_at = v_now
          FROM public.label_versions lv
         WHERE l.id = rec.canonical_label_id
           AND l.shipment_id = rec.shipment_id
           AND lv.id = v_active_version_id;

        UPDATE public.shipment_actions sa
           SET action_data = jsonb_set(
               jsonb_set(
                   COALESCE(sa.action_data, '{}'::jsonb),
                   '{label_id}',
                   to_jsonb(rec.canonical_label_id::text),
                   true
               ),
               '{merged_legacy_label_id}',
               to_jsonb(rec.legacy_label_id::text),
               true
           )
         WHERE sa.shipment_id = rec.shipment_id
           AND sa.action_data->>'label_id' = rec.legacy_label_id::text;

        DELETE FROM public.labels l
         WHERE l.id = rec.legacy_label_id
           AND l.shipment_id = rec.shipment_id;
    END LOOP;
END;
$function$;

COMMENT ON FUNCTION public.merge_shipment_box_label_identity_v1(UUID, UUID, TEXT, UUID)
    IS 'Merge legacy shipment-tracking label rows into the canonical shipment-box label identity for a shipment.';

REVOKE ALL ON FUNCTION public.merge_shipment_box_label_identity_v1(UUID, UUID, TEXT, UUID) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.complete_label_job(
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
    v_barcode TEXT;
    v_barcode_format TEXT;
    v_label_id UUID;
    v_label_metadata JSONB;
    v_retry_seconds INTEGER;
    v_retry_length INTEGER;
    v_index INTEGER;
    v_max_delay INTEGER := 3600;
    v_renderer JSONB := COALESCE(p_renderer_metadata, '{}'::jsonb);
    v_normalized_renderer JSONB := COALESCE(p_renderer_metadata, '{}'::jsonb);
    v_settings_resolution_id UUID := NULL;
    v_correlation_id UUID := NULL;
    v_duration_ms NUMERIC := NULL;
    v_reprint_reason TEXT := NULL;
    v_effective_box_id UUID := NULL;
    v_effective_barcode TEXT := NULL;
    v_box_count INTEGER := 0;
    v_canonical_label_id UUID := NULL;
    v_job_label_barcode TEXT := NULL;
BEGIN
    BEGIN
        v_settings_resolution_id := NULLIF(v_renderer #>> '{settings_resolution,label_render_policy}', '')::uuid;
    EXCEPTION WHEN OTHERS THEN
        v_settings_resolution_id := NULL;
    END;

    BEGIN
        v_correlation_id := NULLIF(v_renderer #>> '{correlation_id}', '')::uuid;
    EXCEPTION WHEN OTHERS THEN
        v_correlation_id := NULL;
    END;

    BEGIN
        v_duration_ms := NULLIF(v_renderer #>> '{timings,total_ms}', '')::numeric;
    EXCEPTION WHEN OTHERS THEN
        v_duration_ms := NULL;
    END;

    SELECT *
    INTO v_job
    FROM public.label_jobs
    WHERE id = p_job_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Label job % not found', p_job_id;
    END IF;

    IF current_user NOT IN ('service_role', 'postgres', 'supabase_admin') THEN
        IF current_user_org_id() IS NULL OR current_user_org_id() <> v_job.organization_id THEN
            RAISE EXCEPTION 'Access denied for label job %', p_job_id;
        END IF;
    END IF;

    IF lower(p_status) = 'succeeded'
       AND lower(v_job.status) = 'succeeded'
       AND v_job.completed_at IS NOT NULL THEN
        RETURN;
    END IF;

    v_reprint_reason := NULLIF(btrim(COALESCE(v_job.reprint_reason, '')), '');

    IF lower(p_status) = 'succeeded' THEN
        IF v_job.shipment_id IS NULL THEN
            v_barcode := NULLIF(v_renderer ->> 'barcode', '');
            v_barcode := COALESCE(
                v_barcode,
                v_job.template_snapshot -> 'label_config' ->> 'fallback_barcode'
            );

            IF v_barcode IS NULL THEN
                RAISE EXCEPTION 'Unable to resolve barcode for label job %', p_job_id;
            END IF;

            v_barcode_format := COALESCE(
                v_job.template_snapshot -> 'label_config' ->> 'barcode_format',
                v_job.template_snapshot -> 'renderer_config' -> 'barcode' ->> 'type',
                'CODE128'
            );

            v_label_id := COALESCE(v_job.label_id, gen_random_uuid());
            v_label_metadata := jsonb_strip_nulls(
                jsonb_build_object(
                    'label_job_id', v_job.id,
                    'template', v_job.template_snapshot,
                    'target', CASE
                        WHEN v_job.target_type IS NULL THEN NULL
                        ELSE jsonb_build_object(
                            'target_type', v_job.target_type,
                            'target_id', v_job.target_id,
                            'target_box_id', v_job.target_box_id
                        )
                    END,
                    'target_metadata', CASE
                        WHEN v_job.target_type IS NULL THEN NULL
                        ELSE COALESCE(v_job.target_metadata, '{}'::jsonb)
                    END,
                    'requested_source', v_job.requested_source,
                    'reprint_reason', v_reprint_reason
                )
            );

            INSERT INTO public.label_artifacts (
                id,
                organization_id,
                client_id,
                target_type,
                target_id,
                target_box_id,
                label_type,
                barcode,
                barcode_format,
                layout_template_id,
                file_url,
                file_size_bytes,
                generated_by,
                generated_at,
                print_count,
                last_printed_at,
                source_label_job_id,
                metadata,
                renderer_metadata
            )
            VALUES (
                v_label_id,
                v_job.organization_id,
                v_job.client_id,
                v_job.target_type,
                v_job.target_id,
                v_job.target_box_id,
                v_job.label_type,
                v_barcode,
                v_barcode_format,
                v_job.template_id,
                p_file_url,
                COALESCE(p_file_size_bytes, 0),
                v_job.requested_by,
                v_now,
                1,
                v_now,
                v_job.id,
                v_label_metadata,
                v_renderer
            )
            ON CONFLICT (source_label_job_id) DO UPDATE
            SET file_url = EXCLUDED.file_url,
                file_size_bytes = EXCLUDED.file_size_bytes,
                generated_by = EXCLUDED.generated_by,
                generated_at = EXCLUDED.generated_at,
                last_printed_at = EXCLUDED.last_printed_at,
                print_count = public.label_artifacts.print_count + 1,
                metadata = EXCLUDED.metadata,
                renderer_metadata = EXCLUDED.renderer_metadata;

            UPDATE public.label_jobs
            SET status = 'succeeded',
                completed_at = v_now,
                lease_expires_at = NULL,
                output_file_url = p_file_url,
                output_file_size_bytes = COALESCE(p_file_size_bytes, 0),
                renderer_metadata = v_renderer,
                error_reason = NULL,
                label_id = v_label_id
            WHERE id = v_job.id;

            PERFORM public.log_decision(
                p_organization_id := v_job.organization_id,
                p_decision_category := 'label_job',
                p_resource_type := 'label_job',
                p_resource_id := v_job.id,
                p_decision_point := 'complete_label_job',
                p_decision_outcome := 'render_succeeded',
                p_performed_by_system := 'label_renderer',
                p_correlation_id := v_correlation_id,
                p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
                    'label_id', v_label_id,
                    'file_url', p_file_url,
                    'file_size_bytes', COALESCE(p_file_size_bytes, 0),
                    'attempts', v_job.attempts + 1,
                    'template_id', v_job.template_id,
                    'template_version', v_job.template_version,
                    'target_type', v_job.target_type,
                    'target_id', v_job.target_id,
                    'target_box_id', v_job.target_box_id
                )),
                p_decision_reason := COALESCE(v_reprint_reason, 'rendered'),
                p_settings_resolution_id := v_settings_resolution_id
            );

            RETURN;
        END IF;

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

        IF v_canonical_label_id IS NULL AND v_job.label_id IS NOT NULL THEN
            SELECT l.barcode
              INTO v_job_label_barcode
              FROM public.labels l
             WHERE l.id = v_job.label_id
               AND l.shipment_id = v_job.shipment_id
             FOR UPDATE;

            IF v_job_label_barcode IS NOT NULL AND v_job_label_barcode <> v_effective_barcode THEN
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

        PERFORM public.complete_label_job_shipment_v1(
            p_job_id,
            p_status,
            p_file_url,
            p_file_size_bytes,
            v_normalized_renderer,
            p_error_reason
        );
        RETURN;
    END IF;

    PERFORM public.complete_label_job_shipment_v1(
        p_job_id,
        p_status,
        p_file_url,
        p_file_size_bytes,
        p_renderer_metadata,
        p_error_reason
    );
END;
$function$;

COMMENT ON FUNCTION public.complete_label_job(UUID, TEXT, TEXT, INTEGER, JSONB, TEXT)
    IS 'Mark a label job as succeeded or failed, keep shipment-backed labels on canonical shipment-box barcode identities, and persist target-neutral renders in label_artifacts.';

REVOKE ALL ON FUNCTION public.complete_label_job(UUID, TEXT, TEXT, INTEGER, JSONB, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_label_job(UUID, TEXT, TEXT, INTEGER, JSONB, TEXT) TO edge_label_renderer_role;

DO $$
DECLARE
    rec RECORD;
BEGIN
    FOR rec IN
        SELECT
            canonical.id AS canonical_label_id,
            legacy.shipment_id,
            sb.id AS shipment_box_id,
            sb.barcode AS canonical_barcode
        FROM public.labels legacy
        JOIN public.shipments s
          ON s.id = legacy.shipment_id
        JOIN LATERAL (
            SELECT COUNT(*)::int AS box_count
            FROM public.shipment_boxes sb_count
            WHERE sb_count.shipment_id = legacy.shipment_id
        ) box_scope ON TRUE
        JOIN public.shipment_boxes sb
          ON sb.shipment_id = legacy.shipment_id
         AND sb.box_number = 1
        JOIN public.labels canonical
          ON canonical.shipment_id = legacy.shipment_id
         AND canonical.barcode = sb.barcode
        WHERE box_scope.box_count = 1
          AND legacy.id <> canonical.id
          AND legacy.barcode = s.tracking_number
    LOOP
        PERFORM public.merge_shipment_box_label_identity_v1(
            rec.shipment_id,
            rec.canonical_label_id,
            rec.canonical_barcode,
            rec.shipment_box_id
        );
    END LOOP;
END $$;

COMMIT;
