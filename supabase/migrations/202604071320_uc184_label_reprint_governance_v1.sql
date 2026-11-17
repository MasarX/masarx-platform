-- Migration: UC184 label reprint governance
-- Purpose:
--  - Capture explicit reprint reasons on label jobs.
--  - Preserve stable active label identity on public.labels while recording immutable
--    active/superseded lineage in public.label_versions.
--  - Keep fresh-generation reprints compatible with the existing renderer contract.

BEGIN;

SET search_path TO public, extensions, pg_temp;

ALTER TABLE public.labels
    ADD COLUMN IF NOT EXISTS active_version_id UUID,
    ADD COLUMN IF NOT EXISTS active_version_number INTEGER NOT NULL DEFAULT 1;

ALTER TABLE public.label_jobs
    ADD COLUMN IF NOT EXISTS reprint_reason TEXT,
    ADD COLUMN IF NOT EXISTS source_label_version_id UUID;

CREATE TABLE IF NOT EXISTS public.label_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    label_id UUID NOT NULL,
    shipment_id UUID NOT NULL,
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
    label_job_id UUID,
    version_number INTEGER NOT NULL,
    version_status TEXT NOT NULL DEFAULT 'active',
    job_purpose TEXT NOT NULL DEFAULT 'primary',
    requested_source TEXT,
    reprint_reason TEXT,
    supersedes_version_id UUID,
    superseded_by_version_id UUID,
    superseded_at TIMESTAMPTZ,
    label_type TEXT NOT NULL,
    barcode TEXT NOT NULL,
    barcode_format TEXT NOT NULL,
    layout_template_id UUID,
    file_url TEXT NOT NULL,
    file_size_bytes INTEGER NOT NULL DEFAULT 0,
    generated_by UUID,
    generated_at TIMESTAMPTZ NOT NULL,
    print_count INTEGER NOT NULL DEFAULT 0,
    last_printed_at TIMESTAMPTZ,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    renderer_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT label_versions_label_fk
        FOREIGN KEY (label_id, shipment_id)
        REFERENCES public.labels(id, shipment_id)
        DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT label_versions_label_job_fk
        FOREIGN KEY (label_job_id, organization_id)
        REFERENCES public.label_jobs(id, organization_id)
        DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT label_versions_layout_template_fk
        FOREIGN KEY (layout_template_id, organization_id)
        REFERENCES public.label_template_specs(id, organization_id)
        DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT label_versions_supersedes_fk
        FOREIGN KEY (supersedes_version_id)
        REFERENCES public.label_versions(id)
        DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT label_versions_superseded_by_fk
        FOREIGN KEY (superseded_by_version_id)
        REFERENCES public.label_versions(id)
        DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT label_versions_version_status_chk
        CHECK (version_status IN ('active', 'superseded')),
    CONSTRAINT label_versions_job_purpose_chk
        CHECK (job_purpose IN ('primary', 'reprint', 'manual')),
    CONSTRAINT label_versions_metadata_obj
        CHECK (jsonb_typeof(metadata) = 'object'),
    CONSTRAINT label_versions_renderer_metadata_obj
        CHECK (jsonb_typeof(renderer_metadata) = 'object'),
    CONSTRAINT label_versions_unique_number
        UNIQUE (label_id, version_number),
    CONSTRAINT label_versions_unique_job
        UNIQUE (label_job_id)
);

ALTER TABLE public.label_versions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.label_versions FROM PUBLIC;
REVOKE ALL ON TABLE public.label_versions FROM anon;
REVOKE ALL ON TABLE public.label_versions FROM authenticated;

DROP POLICY IF EXISTS label_versions_tenant_select ON public.label_versions;
CREATE POLICY label_versions_tenant_select
    ON public.label_versions
    FOR SELECT
    TO authenticated
    USING (organization_id = current_user_org_id());

DROP POLICY IF EXISTS label_versions_service_policy ON public.label_versions;
CREATE POLICY label_versions_service_policy
    ON public.label_versions
    FOR ALL
    TO service_role
    USING (TRUE)
    WITH CHECK (TRUE);

CREATE UNIQUE INDEX IF NOT EXISTS idx_label_versions_active_unique
    ON public.label_versions (label_id, shipment_id)
    WHERE version_status = 'active';

CREATE INDEX IF NOT EXISTS idx_label_versions_label_history
    ON public.label_versions (label_id, version_number DESC);

CREATE INDEX IF NOT EXISTS idx_label_versions_shipment_generated
    ON public.label_versions (shipment_id, generated_at DESC);

CREATE INDEX IF NOT EXISTS idx_label_versions_supersedes
    ON public.label_versions (supersedes_version_id)
    WHERE supersedes_version_id IS NOT NULL;

INSERT INTO public.label_versions (
    id,
    label_id,
    shipment_id,
    organization_id,
    client_id,
    label_job_id,
    version_number,
    version_status,
    job_purpose,
    requested_source,
    reprint_reason,
    supersedes_version_id,
    superseded_by_version_id,
    superseded_at,
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
    metadata,
    renderer_metadata,
    created_at,
    updated_at
)
SELECT
    gen_random_uuid(),
    l.id,
    l.shipment_id,
    l.organization_id,
    l.client_id,
    NULL,
    1,
    'active',
    'primary',
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    l.label_type,
    l.barcode,
    l.barcode_format,
    l.layout_template_id,
    l.file_url,
    l.file_size_bytes,
    l.generated_by,
    l.generated_at,
    l.print_count,
    l.last_printed_at,
    COALESCE(l.metadata, '{}'::jsonb),
    COALESCE(l.renderer_metadata, '{}'::jsonb),
    COALESCE(l.created_at, l.generated_at, now()),
    now()
FROM public.labels l
WHERE NOT EXISTS (
    SELECT 1
    FROM public.label_versions lv
    WHERE lv.label_id = l.id
      AND lv.shipment_id = l.shipment_id
);

UPDATE public.labels l
SET active_version_id = lv.id,
    active_version_number = lv.version_number
FROM public.label_versions lv
WHERE lv.label_id = l.id
  AND lv.shipment_id = l.shipment_id
  AND lv.version_status = 'active'
  AND (
      l.active_version_id IS DISTINCT FROM lv.id
      OR l.active_version_number IS DISTINCT FROM lv.version_number
  );

ALTER TABLE public.labels
    DROP CONSTRAINT IF EXISTS labels_active_version_fk;

ALTER TABLE public.labels
    ADD CONSTRAINT labels_active_version_fk
        FOREIGN KEY (active_version_id)
        REFERENCES public.label_versions(id)
        DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE public.label_jobs
    DROP CONSTRAINT IF EXISTS label_jobs_source_label_version_fk;

ALTER TABLE public.label_jobs
    ADD CONSTRAINT label_jobs_source_label_version_fk
        FOREIGN KEY (source_label_version_id)
        REFERENCES public.label_versions(id)
        DEFERRABLE INITIALLY DEFERRED;

COMMENT ON TABLE public.label_versions
    IS 'Immutable label artifact lineage: one active version per stable label identity, superseded rows preserved for audit and reprint governance.';

COMMENT ON COLUMN public.labels.active_version_id
    IS 'Points to the current active label_versions row for this stable label identity.';

COMMENT ON COLUMN public.labels.active_version_number
    IS 'Cached current version_number from public.label_versions for fast active-label reads.';

COMMENT ON COLUMN public.label_jobs.reprint_reason
    IS 'Operator-supplied reason for explicit reprint requests; NULL for system-triggered fresh generation reprints.';

COMMENT ON COLUMN public.label_jobs.source_label_version_id
    IS 'Active label_versions row at reprint enqueue time for explicit reprint provenance.';

CREATE OR REPLACE FUNCTION public.ensure_label_active_version_v1(
    p_label_id UUID,
    p_shipment_id UUID
)
RETURNS TABLE (
    label_version_id UUID,
    version_number INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
    v_label public.labels%ROWTYPE;
    v_version public.label_versions%ROWTYPE;
BEGIN
    SELECT *
    INTO v_label
    FROM public.labels
    WHERE id = p_label_id
      AND shipment_id = p_shipment_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Label % (shipment %) not found', p_label_id, p_shipment_id;
    END IF;

    IF v_label.active_version_id IS NOT NULL THEN
        SELECT *
        INTO v_version
        FROM public.label_versions
        WHERE id = v_label.active_version_id
        LIMIT 1
        FOR UPDATE;

        IF FOUND THEN
            label_version_id := v_version.id;
            version_number := COALESCE(v_label.active_version_number, v_version.version_number, 1);
            RETURN NEXT;
            RETURN;
        END IF;
    END IF;

    SELECT *
    INTO v_version
    FROM public.label_versions
    WHERE label_id = p_label_id
      AND shipment_id = p_shipment_id
      AND version_status = 'active'
    ORDER BY version_number DESC
    LIMIT 1
    FOR UPDATE;

    IF NOT FOUND THEN
        INSERT INTO public.label_versions (
            id,
            label_id,
            shipment_id,
            organization_id,
            client_id,
            label_job_id,
            version_number,
            version_status,
            job_purpose,
            requested_source,
            reprint_reason,
            supersedes_version_id,
            superseded_by_version_id,
            superseded_at,
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
            metadata,
            renderer_metadata,
            created_at,
            updated_at
        )
        VALUES (
            gen_random_uuid(),
            v_label.id,
            v_label.shipment_id,
            v_label.organization_id,
            v_label.client_id,
            NULL,
            1,
            'active',
            'primary',
            NULL,
            NULL,
            NULL,
            NULL,
            NULL,
            v_label.label_type,
            v_label.barcode,
            v_label.barcode_format,
            v_label.layout_template_id,
            v_label.file_url,
            COALESCE(v_label.file_size_bytes, 0),
            v_label.generated_by,
            COALESCE(v_label.generated_at, now()),
            COALESCE(v_label.print_count, 0),
            v_label.last_printed_at,
            COALESCE(v_label.metadata, '{}'::jsonb),
            COALESCE(v_label.renderer_metadata, '{}'::jsonb),
            COALESCE(v_label.created_at, v_label.generated_at, now()),
            now()
        )
        RETURNING *
        INTO v_version;
    END IF;

    UPDATE public.labels
    SET active_version_id = v_version.id,
        active_version_number = v_version.version_number
    WHERE id = p_label_id
      AND shipment_id = p_shipment_id
      AND (
          active_version_id IS DISTINCT FROM v_version.id
          OR active_version_number IS DISTINCT FROM v_version.version_number
      );

    label_version_id := v_version.id;
    version_number := v_version.version_number;
    RETURN NEXT;
END;
$function$;

COMMENT ON FUNCTION public.ensure_label_active_version_v1(UUID, UUID)
    IS 'Backfills or returns the current active label_versions row for a stable labels identity.';

CREATE OR REPLACE FUNCTION public.request_label_reprint(
    p_label_id UUID,
    p_reprint_reason TEXT,
    p_actor_id UUID DEFAULT NULL,
    p_requested_source TEXT DEFAULT 'reprint'
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
    v_label RECORD;
    v_template_snapshot JSONB;
    v_template_version INTEGER;
    v_template_id UUID;
    v_retry JSONB;
    v_max_attempts INTEGER;
    v_job_id UUID;
    v_context JSONB;
    v_workflow_run_id UUID;
    v_workflow_run_step_id UUID;
    v_created_wrapper BOOLEAN := FALSE;
    v_reprint_reason TEXT := NULLIF(btrim(COALESCE(p_reprint_reason, '')), '');
    v_source_label_version_id UUID := NULL;
    v_source_label_version_number INTEGER := NULL;
BEGIN
    SELECT
        l.*,
        s.organization_id,
        s.client_id,
        s.sender_id,
        sb.id AS matched_box_id
    INTO v_label
    FROM public.labels l
    JOIN public.shipments s ON s.id = l.shipment_id
    LEFT JOIN public.shipment_boxes sb ON sb.barcode = l.barcode
    WHERE l.id = p_label_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Label % not found', p_label_id;
    END IF;

    IF current_user <> 'service_role' THEN
        IF current_user_org_id() IS NULL OR current_user_org_id() <> v_label.organization_id THEN
            RAISE EXCEPTION 'Access denied for label %', p_label_id;
        END IF;
    END IF;

    SELECT label_version_id, version_number
    INTO v_source_label_version_id, v_source_label_version_number
    FROM public.ensure_label_active_version_v1(v_label.id, v_label.shipment_id);

    v_template_snapshot := COALESCE(v_label.metadata -> 'template', '{}'::jsonb);

    IF jsonb_typeof(v_template_snapshot) IS DISTINCT FROM 'object'
        OR v_template_snapshot = '{}'::jsonb THEN
        SELECT
            rt.template_snapshot,
            rt.template_version,
            rt.template_id,
            rt.max_attempts,
            rt.retry_backoff
        INTO v_template_snapshot,
             v_template_version,
             v_template_id,
             v_max_attempts,
             v_retry
        FROM public.resolve_label_template(
            v_label.organization_id,
            v_label.client_id,
            v_label.sender_id,
            v_label.label_type
        ) AS rt
        LIMIT 1;
    ELSE
        v_template_version := COALESCE((v_template_snapshot ->> 'template_version')::INTEGER, 1);
        v_template_id := COALESCE(v_label.layout_template_id, (v_template_snapshot ->> 'template_id')::UUID);
        v_retry := COALESCE(v_template_snapshot -> 'label_config' -> 'retry_backoff_seconds', '[]'::jsonb);
        v_max_attempts := COALESCE((v_template_snapshot -> 'label_config' ->> 'max_attempts')::INTEGER, 5);
    END IF;

    IF v_template_id IS NULL THEN
        RAISE EXCEPTION 'Template reference missing for label %', p_label_id;
    END IF;

    v_context := jsonb_strip_nulls(jsonb_build_object(
        'organization_id', v_label.organization_id,
        'client_id', v_label.client_id,
        'sender_id', v_label.sender_id,
        'shipment_id', v_label.shipment_id,
        'shipment_box_id', v_label.matched_box_id,
        'label_id', p_label_id,
        'label_type', v_label.label_type,
        'job_purpose', 'reprint',
        'requested_source', p_requested_source,
        'source_label_version_id', v_source_label_version_id
    ));

    SELECT workflow_run_id, workflow_run_step_id, created_wrapper
    INTO v_workflow_run_id, v_workflow_run_step_id, v_created_wrapper
    FROM public.ensure_label_job_workflow_context(v_context)
    LIMIT 1;

    INSERT INTO public.label_jobs (
        organization_id,
        client_id,
        shipment_id,
        shipment_box_id,
        label_id,
        label_type,
        template_id,
        template_version,
        template_snapshot,
        status,
        attempts,
        max_attempts,
        scheduled_at,
        job_purpose,
        idempotency_key,
        requested_by,
        requested_source,
        reprint_reason,
        source_label_version_id,
        renderer_hint,
        retry_state,
        workflow_run_step_id
    )
    VALUES (
        v_label.organization_id,
        v_label.client_id,
        v_label.shipment_id,
        v_label.matched_box_id,
        p_label_id,
        v_label.label_type,
        v_template_id,
        v_template_version,
        v_template_snapshot,
        'pending',
        0,
        COALESCE(v_max_attempts, 5),
        now(),
        'reprint',
        gen_random_uuid()::text,
        p_actor_id,
        p_requested_source,
        v_reprint_reason,
        v_source_label_version_id,
        v_template_snapshot -> 'label_config' ->> 'provider_hint',
        COALESCE(v_retry, '[]'::jsonb),
        v_workflow_run_step_id
    )
    RETURNING id INTO v_job_id;

    IF v_created_wrapper AND v_job_id IS NOT NULL THEN
      UPDATE public.workflow_run_steps
      SET operation_result = jsonb_strip_nulls(jsonb_build_object(
            'label_job_id', v_job_id,
            'label_type', v_label.label_type,
            'job_purpose', 'reprint',
            'source_label_version_id', v_source_label_version_id
          )),
          updated_at = now()
      WHERE id = v_workflow_run_step_id;

      UPDATE public.workflow_runs
      SET context = jsonb_strip_nulls(COALESCE(context, '{}'::jsonb) || jsonb_build_object(
            'label_job_id', v_job_id,
            'label_job_status', 'pending'
          )),
          updated_at = now()
      WHERE id = v_workflow_run_id;
    END IF;

    PERFORM public.log_decision(
        p_organization_id := v_label.organization_id,
        p_decision_category := 'label_job',
        p_resource_type := 'label_job',
        p_resource_id := v_job_id,
        p_decision_point := 'request_label_reprint',
        p_decision_outcome := 'enqueued',
        p_performed_by_system := 'workflow_engine',
        p_correlation_id := NULL,
        p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
            'label_id', p_label_id,
            'label_type', v_label.label_type,
            'template_id', v_template_id,
            'template_version', v_template_version,
            'requested_source', p_requested_source,
            'source_label_version_id', v_source_label_version_id,
            'source_label_version_number', v_source_label_version_number
        )),
        p_decision_reason := v_reprint_reason
    );

    RETURN v_job_id;
END;
$function$;

COMMENT ON FUNCTION public.request_label_reprint(UUID, TEXT, UUID, TEXT)
    IS 'Queue a reprint job, capture an operator reason when provided, and preserve the active source version lineage at enqueue time.';

CREATE OR REPLACE FUNCTION public.request_label_reprint(
    p_label_id UUID,
    p_actor_id UUID DEFAULT NULL,
    p_requested_source TEXT DEFAULT 'reprint'
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
BEGIN
    RETURN public.request_label_reprint(
        p_label_id := p_label_id,
        p_reprint_reason := NULL,
        p_actor_id := p_actor_id,
        p_requested_source := p_requested_source
    );
END;
$function$;

COMMENT ON FUNCTION public.request_label_reprint(UUID, UUID, TEXT)
    IS 'Compatibility wrapper for reprint callers that do not yet provide an explicit reason.';

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
    v_settings_resolution_id UUID := NULL;
    v_correlation_id UUID := NULL;
    v_duration_ms NUMERIC := NULL;
    v_existing_label public.labels%ROWTYPE;
    v_existing_job_version public.label_versions%ROWTYPE;
    v_inserted_label BOOLEAN := FALSE;
    v_active_version_id UUID := NULL;
    v_active_version_number INTEGER := NULL;
    v_new_version_id UUID := NULL;
    v_new_version_number INTEGER := NULL;
    v_next_print_count INTEGER := 1;
    v_reprint_reason TEXT := NULL;
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
        v_barcode := NULLIF(v_renderer ->> 'barcode', '');

        IF v_job.shipment_box_id IS NOT NULL THEN
            SELECT barcode
            INTO v_barcode
            FROM public.shipment_boxes
            WHERE id = v_job.shipment_box_id;
        END IF;

        IF v_barcode IS NULL THEN
            SELECT sb.barcode
            INTO v_barcode
            FROM public.shipment_boxes sb
            WHERE sb.shipment_id = v_job.shipment_id
            ORDER BY sb.box_number
            LIMIT 1;
        END IF;

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

        SELECT *
        INTO v_existing_job_version
        FROM public.label_versions
        WHERE label_job_id = v_job.id
        LIMIT 1
        FOR UPDATE;

        IF v_job.label_id IS NOT NULL THEN
            SELECT *
            INTO v_existing_label
            FROM public.labels
            WHERE id = v_job.label_id
              AND shipment_id = v_job.shipment_id
            FOR UPDATE;
        END IF;

        IF NOT FOUND THEN
            SELECT *
            INTO v_existing_label
            FROM public.labels
            WHERE shipment_id = v_job.shipment_id
              AND barcode = v_barcode
            ORDER BY generated_at DESC
            LIMIT 1
            FOR UPDATE;
        END IF;

        IF NOT FOUND AND v_existing_job_version.id IS NOT NULL THEN
            SELECT *
            INTO v_existing_label
            FROM public.labels
            WHERE id = v_existing_job_version.label_id
              AND shipment_id = v_existing_job_version.shipment_id
            FOR UPDATE;
        END IF;

        IF FOUND THEN
            v_label_id := v_existing_label.id;
            v_next_print_count := COALESCE(v_existing_label.print_count, 0) + 1;
        ELSE
            v_label_id := COALESCE(v_job.label_id, gen_random_uuid());

            INSERT INTO public.labels (
                id,
                shipment_id,
                organization_id,
                client_id,
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
                metadata,
                renderer_metadata,
                active_version_id,
                active_version_number
            )
            VALUES (
                v_label_id,
                v_job.shipment_id,
                v_job.organization_id,
                v_job.client_id,
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
                '{}'::jsonb,
                v_renderer,
                NULL,
                1
            )
            RETURNING *
            INTO v_existing_label;

            v_inserted_label := TRUE;
            v_next_print_count := 1;
        END IF;

        IF v_existing_job_version.id IS NOT NULL THEN
            v_new_version_id := v_existing_job_version.id;
            v_new_version_number := v_existing_job_version.version_number;
        ELSIF v_inserted_label THEN
            v_new_version_id := gen_random_uuid();
            v_new_version_number := 1;
        ELSE
            SELECT label_version_id, version_number
            INTO v_active_version_id, v_active_version_number
            FROM public.ensure_label_active_version_v1(v_existing_label.id, v_existing_label.shipment_id);

            IF lower(v_job.job_purpose) = 'reprint' THEN
                v_new_version_id := gen_random_uuid();
                v_new_version_number := COALESCE(v_active_version_number, 0) + 1;
            ELSE
                v_new_version_id := v_active_version_id;
                v_new_version_number := COALESCE(v_active_version_number, 1);
            END IF;
        END IF;

        v_label_metadata := jsonb_strip_nulls(jsonb_build_object(
            'label_job_id', v_job.id,
            'template', v_job.template_snapshot,
            'active_version_id', v_new_version_id,
            'active_version_number', v_new_version_number,
            'requested_source', v_job.requested_source,
            'reprint_reason', v_reprint_reason
        ));

        IF v_existing_job_version.id IS NOT NULL THEN
            UPDATE public.label_versions
            SET version_status = COALESCE(v_existing_job_version.version_status, 'active'),
                job_purpose = v_job.job_purpose,
                requested_source = COALESCE(v_job.requested_source, requested_source),
                reprint_reason = COALESCE(v_reprint_reason, reprint_reason),
                label_type = v_job.label_type,
                barcode = v_barcode,
                barcode_format = v_barcode_format,
                layout_template_id = v_job.template_id,
                file_url = p_file_url,
                file_size_bytes = COALESCE(p_file_size_bytes, 0),
                generated_by = v_job.requested_by,
                generated_at = v_now,
                print_count = v_next_print_count,
                last_printed_at = v_now,
                metadata = v_label_metadata,
                renderer_metadata = v_renderer,
                updated_at = v_now
            WHERE id = v_existing_job_version.id;
        ELSIF v_inserted_label OR lower(v_job.job_purpose) = 'reprint' THEN
            INSERT INTO public.label_versions (
                id,
                label_id,
                shipment_id,
                organization_id,
                client_id,
                label_job_id,
                version_number,
                version_status,
                job_purpose,
                requested_source,
                reprint_reason,
                supersedes_version_id,
                superseded_by_version_id,
                superseded_at,
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
                metadata,
                renderer_metadata,
                created_at,
                updated_at
            )
            VALUES (
                v_new_version_id,
                v_existing_label.id,
                v_existing_label.shipment_id,
                v_existing_label.organization_id,
                v_existing_label.client_id,
                v_job.id,
                v_new_version_number,
                'active',
                v_job.job_purpose,
                v_job.requested_source,
                v_reprint_reason,
                CASE
                    WHEN lower(v_job.job_purpose) = 'reprint' THEN v_active_version_id
                    ELSE NULL
                END,
                NULL,
                NULL,
                v_job.label_type,
                v_barcode,
                v_barcode_format,
                v_job.template_id,
                p_file_url,
                COALESCE(p_file_size_bytes, 0),
                v_job.requested_by,
                v_now,
                v_next_print_count,
                v_now,
                v_label_metadata,
                v_renderer,
                v_now,
                v_now
            );

            IF lower(v_job.job_purpose) = 'reprint' AND v_active_version_id IS NOT NULL THEN
                UPDATE public.label_versions
                SET version_status = 'superseded',
                    superseded_by_version_id = v_new_version_id,
                    superseded_at = v_now,
                    updated_at = v_now
                WHERE id = v_active_version_id
                  AND id <> v_new_version_id;
            END IF;
        ELSE
            UPDATE public.label_versions
            SET requested_source = COALESCE(v_job.requested_source, requested_source),
                label_type = v_job.label_type,
                barcode = v_barcode,
                barcode_format = v_barcode_format,
                layout_template_id = v_job.template_id,
                file_url = p_file_url,
                file_size_bytes = COALESCE(p_file_size_bytes, 0),
                generated_by = v_job.requested_by,
                generated_at = v_now,
                print_count = v_next_print_count,
                last_printed_at = v_now,
                metadata = v_label_metadata,
                renderer_metadata = v_renderer,
                updated_at = v_now
            WHERE id = v_active_version_id;
        END IF;

        UPDATE public.labels
        SET file_url = p_file_url,
            file_size_bytes = COALESCE(p_file_size_bytes, 0),
            generated_by = v_job.requested_by,
            generated_at = v_now,
            last_printed_at = v_now,
            print_count = v_next_print_count,
            label_type = v_job.label_type,
            layout_template_id = v_job.template_id,
            barcode_format = v_barcode_format,
            metadata = v_label_metadata,
            renderer_metadata = v_renderer,
            active_version_id = v_new_version_id,
            active_version_number = v_new_version_number
        WHERE id = v_existing_label.id
          AND shipment_id = v_existing_label.shipment_id;

        UPDATE public.label_jobs
        SET status = 'succeeded',
            completed_at = v_now,
            lease_expires_at = NULL,
            output_file_url = p_file_url,
            output_file_size_bytes = COALESCE(p_file_size_bytes, 0),
            renderer_metadata = v_renderer,
            error_reason = NULL,
            label_id = v_existing_label.id
        WHERE id = v_job.id;

        INSERT INTO public.shipment_actions (
            id,
            shipment_id,
            organization_id,
            client_id,
            action_type,
            action_category,
            action_data,
            timestamp,
            created_at,
            performed_by_system
        )
        VALUES (
            gen_random_uuid(),
            v_job.shipment_id,
            v_job.organization_id,
            v_job.client_id,
            'label_generated',
            'operational',
            jsonb_strip_nulls(jsonb_build_object(
                'label_job_id', v_job.id,
                'label_id', v_existing_label.id,
                'label_version_id', v_new_version_id,
                'label_version_number', v_new_version_number,
                'supersedes_label_version_id', CASE
                    WHEN lower(v_job.job_purpose) = 'reprint' THEN v_active_version_id
                    ELSE NULL
                END,
                'reprint_reason', v_reprint_reason,
                'attempts', v_job.attempts,
                'template_version', v_job.template_version
            )),
            v_now,
            v_now,
            'label_renderer'
        );

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
                'label_id', v_existing_label.id,
                'label_version_id', v_new_version_id,
                'label_version_number', v_new_version_number,
                'supersedes_label_version_id', CASE
                    WHEN lower(v_job.job_purpose) = 'reprint' THEN v_active_version_id
                    ELSE NULL
                END,
                'file_url', p_file_url,
                'file_size_bytes', COALESCE(p_file_size_bytes, 0),
                'attempts', v_job.attempts + 1,
                'template_id', v_job.template_id,
                'template_version', v_job.template_version,
                'barcode', v_renderer->'barcode'
            )),
            p_decision_reason := v_reprint_reason,
            p_settings_resolution_id := v_settings_resolution_id
        );

        PERFORM public.log_decision(
            p_organization_id := v_job.organization_id,
            p_decision_category := 'label_rendering',
            p_resource_type := 'label_job',
            p_resource_id := v_job.id,
            p_decision_point := 'label_renderer',
            p_decision_outcome := 'succeeded',
            p_performed_by_system := 'label_renderer',
            p_correlation_id := v_correlation_id,
            p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
                'template_id', v_job.template_id,
                'template_version', v_job.template_version,
                'duration_ms', v_duration_ms,
                'timings', v_renderer->'timings',
                'barcode', v_renderer->'barcode',
                'label_version_id', v_new_version_id,
                'label_version_number', v_new_version_number
            )),
            p_decision_reason := COALESCE(v_reprint_reason, 'rendered'),
            p_settings_resolution_id := v_settings_resolution_id
        );
    ELSE
        v_retry_length := COALESCE(jsonb_array_length(v_job.retry_state), 0);
        IF v_retry_length >= v_job.attempts AND v_job.attempts > 0 THEN
            v_index := v_job.attempts;
            v_retry_seconds := COALESCE((v_job.retry_state ->> (v_index - 1))::INTEGER, 0);
        ELSE
            v_retry_seconds := 0;
        END IF;
        IF v_retry_seconds <= 0 THEN
            v_retry_seconds := LEAST(v_max_delay, 60 * (2 ^ GREATEST(v_job.attempts - 1, 0)));
        END IF;
        v_retry_seconds := LEAST(v_max_delay, GREATEST(v_retry_seconds, 30));

        IF v_job.attempts >= v_job.max_attempts THEN
            UPDATE public.label_jobs
            SET status = 'failed',
                completed_at = v_now,
                lease_expires_at = NULL,
                renderer_metadata = v_renderer,
                error_reason = COALESCE(p_error_reason, 'max_attempts_exceeded')
            WHERE id = v_job.id;

            PERFORM public.log_decision(
                p_organization_id := v_job.organization_id,
                p_decision_category := 'label_job',
                p_resource_type := 'label_job',
                p_resource_id := v_job.id,
                p_decision_point := 'complete_label_job',
                p_decision_outcome := 'render_failed',
                p_performed_by_system := 'label_renderer',
                p_correlation_id := v_correlation_id,
                p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
                    'attempts', v_job.attempts,
                    'max_attempts', v_job.max_attempts,
                    'template_id', v_job.template_id,
                    'template_version', v_job.template_version,
                    'barcode', v_renderer->'barcode'
                )),
                p_decision_reason := COALESCE(p_error_reason, 'max_attempts_exceeded'),
                p_settings_resolution_id := v_settings_resolution_id
            );
        ELSE
            UPDATE public.label_jobs
            SET status = 'pending',
                lease_expires_at = NULL,
                scheduled_at = v_now + make_interval(secs => v_retry_seconds),
                renderer_metadata = v_renderer,
                error_reason = p_error_reason
            WHERE id = v_job.id;

            PERFORM public.log_decision(
                p_organization_id := v_job.organization_id,
                p_decision_category := 'label_job',
                p_resource_type := 'label_job',
                p_resource_id := v_job.id,
                p_decision_point := 'complete_label_job',
                p_decision_outcome := 'render_retry_scheduled',
                p_performed_by_system := 'label_renderer',
                p_correlation_id := v_correlation_id,
                p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
                    'next_attempt_in_seconds', v_retry_seconds,
                    'attempts', v_job.attempts,
                    'max_attempts', v_job.max_attempts,
                    'template_id', v_job.template_id,
                    'template_version', v_job.template_version,
                    'barcode', v_renderer->'barcode'
                )),
                p_decision_reason := p_error_reason,
                p_settings_resolution_id := v_settings_resolution_id
            );
        END IF;
    END IF;
END;
$function$;

COMMENT ON FUNCTION public.complete_label_job(UUID, TEXT, TEXT, INTEGER, JSONB, TEXT)
    IS 'Mark a label job as succeeded or failed, keep the stable labels row current, and preserve immutable active/superseded label_versions lineage for reprints.';

COMMIT;
