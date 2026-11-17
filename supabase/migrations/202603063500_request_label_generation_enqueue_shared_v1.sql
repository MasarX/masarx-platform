-- Migration: canonical shared label-generation enqueue helper
-- Purpose:
--  - Remove the remaining bulk-via-batch fan-out from the fresh print path.
--  - Repoint both batch and bulk public entrypoints to one reusable, set-based helper.
--  - Preserve current request-scoped freshness semantics, idempotency, ordering, and audit writes.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603063500_request_label_generation_enqueue_shared_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.request_label_generation_enqueue_shared_v1(
  p_shipments jsonb,
  p_label_type text,
  p_requested_by uuid DEFAULT NULL,
  p_requested_source text DEFAULT NULL,
  p_job_purpose text DEFAULT 'primary'
)
RETURNS TABLE (
  job_id uuid,
  shipment_id uuid,
  shipment_box_id uuid,
  inserted boolean,
  shipment_index int,
  box_index int
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_label_type text := lower(COALESCE(NULLIF(btrim(p_label_type), ''), ''));
  v_job_purpose text := COALESCE(NULLIF(p_job_purpose, ''), 'primary');
  v_run_scope_key text := COALESCE(
    NULLIF(current_setting('platform.workflow_run_step_id', true), ''),
    NULLIF(current_setting('app.workflow_run_step_id', true), ''),
    NULLIF(p_requested_source, ''),
    'reprint'
  );
  v_requested_count int := 0;
  v_resolved_count int := 0;
  v_missing_shipment_id uuid := NULL;
  v_access_denied_shipment_id uuid := NULL;
  v_missing_template_shipment_id uuid := NULL;
BEGIN
  IF v_label_type = '' THEN
    RAISE EXCEPTION 'Label type is required.';
  END IF;

  WITH shipment_rows AS (
    SELECT
      ordinality::int AS shipment_index,
      NULLIF(item->>'shipment_id', '')::uuid AS shipment_id,
      ARRAY(
        SELECT box_text::uuid
        FROM jsonb_array_elements_text(COALESCE(item->'box_ids', '[]'::jsonb))
             WITH ORDINALITY AS box(box_text, box_ordinality)
        WHERE box_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        ORDER BY box_ordinality
      ) AS shipment_box_ids
    FROM jsonb_array_elements(
           CASE
             WHEN jsonb_typeof(COALESCE(p_shipments, '[]'::jsonb)) = 'array' THEN COALESCE(p_shipments, '[]'::jsonb)
             ELSE '[]'::jsonb
           END
         ) WITH ORDINALITY AS t(item, ordinality)
    WHERE item ? 'shipment_id'
  ),
  resolved_shipments AS (
    SELECT
      sr.shipment_index,
      sr.shipment_id,
      sr.shipment_box_ids,
      s.organization_id,
      s.client_id,
      s.sender_id
    FROM shipment_rows sr
    JOIN public.shipments s
      ON s.id = sr.shipment_id
  )
  SELECT
    COALESCE((SELECT COUNT(*) FROM shipment_rows), 0),
    COALESCE((SELECT COUNT(*) FROM resolved_shipments), 0),
    (
      SELECT sr.shipment_id
      FROM shipment_rows sr
      LEFT JOIN resolved_shipments rs
        ON rs.shipment_index = sr.shipment_index
       AND rs.shipment_id = sr.shipment_id
      WHERE rs.shipment_id IS NULL
      ORDER BY sr.shipment_index
      LIMIT 1
    )
  INTO v_requested_count, v_resolved_count, v_missing_shipment_id;

  IF v_requested_count = 0 THEN
    RETURN;
  END IF;

  IF v_resolved_count <> v_requested_count THEN
    RAISE EXCEPTION 'Shipment % not found', v_missing_shipment_id;
  END IF;

  IF current_user NOT IN ('service_role', 'postgres', 'supabase_admin') THEN
    IF public.current_user_org_id() IS NULL THEN
      RAISE EXCEPTION 'Access denied for shipment %', v_missing_shipment_id;
    END IF;

    WITH shipment_rows AS (
      SELECT
        ordinality::int AS shipment_index,
        NULLIF(item->>'shipment_id', '')::uuid AS shipment_id
      FROM jsonb_array_elements(
             CASE
               WHEN jsonb_typeof(COALESCE(p_shipments, '[]'::jsonb)) = 'array' THEN COALESCE(p_shipments, '[]'::jsonb)
               ELSE '[]'::jsonb
             END
           ) WITH ORDINALITY AS t(item, ordinality)
      WHERE item ? 'shipment_id'
    )
    SELECT sr.shipment_id
    INTO v_access_denied_shipment_id
    FROM shipment_rows sr
    JOIN public.shipments s
      ON s.id = sr.shipment_id
    WHERE s.organization_id <> public.current_user_org_id()
    ORDER BY sr.shipment_index
    LIMIT 1;

    IF v_access_denied_shipment_id IS NOT NULL THEN
      RAISE EXCEPTION 'Access denied for shipment %', v_access_denied_shipment_id;
    END IF;
  END IF;

  WITH shipment_rows AS (
    SELECT
      ordinality::int AS shipment_index,
      NULLIF(item->>'shipment_id', '')::uuid AS shipment_id,
      ARRAY(
        SELECT box_text::uuid
        FROM jsonb_array_elements_text(COALESCE(item->'box_ids', '[]'::jsonb))
             WITH ORDINALITY AS box(box_text, box_ordinality)
        WHERE box_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        ORDER BY box_ordinality
      ) AS shipment_box_ids
    FROM jsonb_array_elements(
           CASE
             WHEN jsonb_typeof(COALESCE(p_shipments, '[]'::jsonb)) = 'array' THEN COALESCE(p_shipments, '[]'::jsonb)
             ELSE '[]'::jsonb
           END
         ) WITH ORDINALITY AS t(item, ordinality)
    WHERE item ? 'shipment_id'
  ),
  resolved_shipments AS (
    SELECT
      sr.shipment_index,
      sr.shipment_id,
      sr.shipment_box_ids,
      s.organization_id,
      s.client_id,
      s.sender_id
    FROM shipment_rows sr
    JOIN public.shipments s
      ON s.id = sr.shipment_id
  ),
  distinct_scopes AS (
    SELECT DISTINCT
      rs.organization_id,
      rs.client_id,
      rs.sender_id
    FROM resolved_shipments rs
  ),
  resolved_templates AS (
    SELECT
      ds.organization_id,
      ds.client_id,
      ds.sender_id,
      rt.template_id,
      rt.template_version,
      rt.template_snapshot,
      COALESCE(rt.max_attempts, 5) AS max_attempts,
      rt.template_snapshot -> 'label_config' ->> 'provider_hint' AS renderer_hint,
      COALESCE(rt.retry_backoff, '[]'::jsonb) AS retry_state
    FROM distinct_scopes ds
    CROSS JOIN LATERAL public.resolve_label_template(
      ds.organization_id,
      ds.client_id,
      ds.sender_id,
      v_label_type
    ) rt
  )
  SELECT rs.shipment_id
  INTO v_missing_template_shipment_id
  FROM resolved_shipments rs
  LEFT JOIN resolved_templates rt
    ON rt.organization_id = rs.organization_id
   AND rt.client_id IS NOT DISTINCT FROM rs.client_id
   AND rt.sender_id IS NOT DISTINCT FROM rs.sender_id
  WHERE rt.template_id IS NULL
  ORDER BY rs.shipment_index
  LIMIT 1;

  IF v_missing_template_shipment_id IS NOT NULL THEN
    RAISE EXCEPTION 'Unable to resolve label template for shipment % label_type %', v_missing_template_shipment_id, v_label_type;
  END IF;

  RETURN QUERY
  WITH shipment_rows AS (
    SELECT
      ordinality::int AS shipment_index,
      NULLIF(item->>'shipment_id', '')::uuid AS shipment_id,
      ARRAY(
        SELECT box_text::uuid
        FROM jsonb_array_elements_text(COALESCE(item->'box_ids', '[]'::jsonb))
             WITH ORDINALITY AS box(box_text, box_ordinality)
        WHERE box_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        ORDER BY box_ordinality
      ) AS shipment_box_ids
    FROM jsonb_array_elements(
           CASE
             WHEN jsonb_typeof(COALESCE(p_shipments, '[]'::jsonb)) = 'array' THEN COALESCE(p_shipments, '[]'::jsonb)
             ELSE '[]'::jsonb
           END
         ) WITH ORDINALITY AS t(item, ordinality)
    WHERE item ? 'shipment_id'
  ),
  resolved_shipments AS (
    SELECT
      sr.shipment_index,
      sr.shipment_id,
      sr.shipment_box_ids,
      s.organization_id,
      s.client_id,
      s.sender_id
    FROM shipment_rows sr
    JOIN public.shipments s
      ON s.id = sr.shipment_id
  ),
  ensured_boxes AS (
    SELECT
      rs.shipment_index,
      rs.shipment_id,
      rs.shipment_box_ids,
      rs.organization_id,
      rs.client_id,
      rs.sender_id,
      eb.shipment_box_id,
      eb.box_number
    FROM resolved_shipments rs
    CROSS JOIN LATERAL public.ensure_shipment_boxes(rs.shipment_id) eb
  ),
  distinct_scopes AS (
    SELECT DISTINCT
      eb.organization_id,
      eb.client_id,
      eb.sender_id
    FROM ensured_boxes eb
  ),
  resolved_templates AS (
    SELECT
      ds.organization_id,
      ds.client_id,
      ds.sender_id,
      rt.template_id,
      rt.template_version,
      rt.template_snapshot,
      COALESCE(rt.max_attempts, 5) AS max_attempts,
      rt.template_snapshot -> 'label_config' ->> 'provider_hint' AS renderer_hint,
      COALESCE(rt.retry_backoff, '[]'::jsonb) AS retry_state
    FROM distinct_scopes ds
    CROSS JOIN LATERAL public.resolve_label_template(
      ds.organization_id,
      ds.client_id,
      ds.sender_id,
      v_label_type
    ) rt
  ),
  input_boxes AS (
    SELECT
      eb.shipment_index,
      eb.shipment_id,
      eb.organization_id,
      eb.client_id,
      eb.sender_id,
      eb.shipment_box_id,
      COALESCE(rb.input_index, eb.box_number, 0) AS sort_index
    FROM ensured_boxes eb
    LEFT JOIN LATERAL (
      SELECT u.input_index::int AS input_index
      FROM unnest(eb.shipment_box_ids) WITH ORDINALITY AS u(box_id, input_index)
      WHERE u.box_id = eb.shipment_box_id
      LIMIT 1
    ) rb ON TRUE
    WHERE (
      eb.shipment_box_ids IS NULL
      OR array_length(eb.shipment_box_ids, 1) IS NULL
      OR eb.shipment_box_id = ANY (eb.shipment_box_ids)
    )
  ),
  job_inputs AS (
    SELECT
      ib.shipment_index,
      ib.shipment_id,
      ib.shipment_box_id,
      ib.sort_index,
      rt.organization_id,
      rt.client_id,
      rt.template_id,
      rt.template_version,
      rt.template_snapshot,
      rt.max_attempts,
      rt.renderer_hint,
      rt.retry_state,
      v_label_type AS label_type,
      now() AS scheduled_at,
      v_job_purpose AS job_purpose,
      CASE
        WHEN lower(v_job_purpose) = 'primary' THEN
          format(
            '%s:%s:%s:%s:%s:%s',
            rt.organization_id,
            ib.shipment_id,
            ib.shipment_box_id,
            v_label_type,
            rt.template_id,
            v_job_purpose
          )
        ELSE
          format(
            '%s:%s:%s:%s:%s:%s:%s',
            rt.organization_id,
            ib.shipment_id,
            ib.shipment_box_id,
            v_label_type,
            rt.template_id,
            v_job_purpose,
            v_run_scope_key
          )
      END AS idempotency_key
    FROM input_boxes ib
    JOIN resolved_templates rt
      ON rt.organization_id = ib.organization_id
     AND rt.client_id IS NOT DISTINCT FROM ib.client_id
     AND rt.sender_id IS NOT DISTINCT FROM ib.sender_id
  ),
  inserted_jobs AS (
    INSERT INTO public.label_jobs AS lj (
      organization_id,
      client_id,
      shipment_id,
      shipment_box_id,
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
      renderer_hint,
      retry_state
    )
    SELECT
      ji.organization_id,
      ji.client_id,
      ji.shipment_id,
      ji.shipment_box_id,
      ji.label_type,
      ji.template_id,
      ji.template_version,
      ji.template_snapshot,
      'pending',
      0,
      ji.max_attempts,
      ji.scheduled_at,
      ji.job_purpose,
      ji.idempotency_key,
      p_requested_by,
      p_requested_source,
      ji.renderer_hint,
      ji.retry_state
    FROM job_inputs ji
    ON CONFLICT ON CONSTRAINT label_jobs_unique_request DO NOTHING
    RETURNING
      lj.id AS job_id,
      lj.shipment_id,
      lj.shipment_box_id,
      lj.idempotency_key
  ),
  resolved AS (
    SELECT
      ji.shipment_index,
      ji.shipment_id,
      ji.shipment_box_id,
      COALESCE(ins.job_id, lj.id) AS job_id,
      (ins.job_id IS NOT NULL) AS inserted,
      row_number() OVER (
        PARTITION BY ji.shipment_index
        ORDER BY ji.sort_index, ji.shipment_box_id
      ) AS box_index
    FROM job_inputs ji
    LEFT JOIN inserted_jobs ins
      ON ins.idempotency_key = ji.idempotency_key
    LEFT JOIN public.label_jobs lj
      ON lj.organization_id = ji.organization_id
     AND lj.idempotency_key = ji.idempotency_key
    WHERE COALESCE(ins.job_id, lj.id) IS NOT NULL
  ),
  decision_rows AS (
    INSERT INTO public.decision_log (
      organization_id,
      decision_category,
      resource_type,
      resource_id,
      decision_point,
      decision_outcome,
      decision_inputs,
      decision_reason,
      performed_by_system,
      correlation_id,
      settings_resolution_id,
      timestamp
    )
    SELECT
      ji.organization_id,
      'label_job',
      'label_job',
      r.job_id,
      'request_label_generation',
      CASE WHEN r.inserted THEN 'enqueued' ELSE 'reused' END,
      jsonb_strip_nulls(
        jsonb_build_object(
          'shipment_id', r.shipment_id,
          'shipment_box_id', r.shipment_box_id,
          'label_type', v_label_type,
          'template_id', ji.template_id,
          'template_version', ji.template_version,
          'job_purpose', v_job_purpose,
          'batch', TRUE,
          'run_scope_key', CASE WHEN lower(v_job_purpose) = 'primary' THEN NULL ELSE v_run_scope_key END
        )
      ),
      CASE WHEN r.inserted THEN NULL ELSE 'idempotent_reuse' END,
      'workflow_engine',
      NULL,
      NULL,
      now()
    FROM resolved r
    JOIN job_inputs ji
      ON ji.shipment_index = r.shipment_index
     AND ji.shipment_id = r.shipment_id
     AND ji.shipment_box_id = r.shipment_box_id
    RETURNING 1
  )
  SELECT
    r.job_id,
    r.shipment_id,
    r.shipment_box_id,
    r.inserted,
    r.shipment_index::int,
    r.box_index::int
  FROM resolved r
  ORDER BY r.shipment_index, r.box_index;
END;
$function$;

COMMENT ON FUNCTION public.request_label_generation_enqueue_shared_v1(jsonb, text, uuid, text, text)
  IS 'Canonical shared set-based label enqueue helper used by batch and bulk entrypoints with request-scoped freshness for non-primary jobs.';

CREATE OR REPLACE FUNCTION public.request_label_generation_batch(
  p_shipment_id uuid,
  p_label_type text,
  p_requested_by uuid DEFAULT NULL,
  p_requested_source text DEFAULT NULL,
  p_shipment_box_ids uuid[] DEFAULT NULL,
  p_job_purpose text DEFAULT 'primary'
)
RETURNS TABLE (
  job_id uuid,
  shipment_box_id uuid,
  inserted boolean
)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT
    r.job_id,
    r.shipment_box_id,
    r.inserted
  FROM public.request_label_generation_enqueue_shared_v1(
    jsonb_build_array(
      jsonb_strip_nulls(
        jsonb_build_object(
          'shipment_id', p_shipment_id,
          'box_ids', CASE
            WHEN p_shipment_box_ids IS NULL OR array_length(p_shipment_box_ids, 1) IS NULL THEN NULL
            ELSE to_jsonb(p_shipment_box_ids)
          END
        )
      )
    ),
    p_label_type,
    p_requested_by,
    p_requested_source,
    p_job_purpose
  ) AS r
  ORDER BY r.shipment_index, r.box_index;
$function$;

COMMENT ON FUNCTION public.request_label_generation_batch(uuid, text, uuid, text, uuid[], text)
  IS 'Batch enqueue label jobs through the canonical shared set-based enqueue helper. Primary requests stay idempotent; non-primary requests are request-scoped for fresh per-click generation.';

CREATE OR REPLACE FUNCTION public.request_label_generation_bulk_v1(
  p_shipments jsonb,
  p_label_type text,
  p_requested_by uuid DEFAULT NULL,
  p_requested_source text DEFAULT NULL,
  p_job_purpose text DEFAULT 'primary'
)
RETURNS TABLE (
  job_id uuid,
  shipment_id uuid,
  shipment_box_id uuid,
  inserted boolean,
  shipment_index int,
  box_index int
)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT
    r.job_id,
    r.shipment_id,
    r.shipment_box_id,
    r.inserted,
    r.shipment_index,
    r.box_index
  FROM public.request_label_generation_enqueue_shared_v1(
    p_shipments,
    p_label_type,
    p_requested_by,
    p_requested_source,
    p_job_purpose
  ) AS r
  ORDER BY r.shipment_index, r.box_index;
$function$;

COMMENT ON FUNCTION public.request_label_generation_bulk_v1(jsonb, text, uuid, text, text)
  IS 'Bulk label-job enqueue through the canonical shared set-based enqueue helper with request-scoped freshness for non-primary jobs.';

REVOKE ALL ON FUNCTION public.request_label_generation_enqueue_shared_v1(jsonb, text, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.request_label_generation_enqueue_shared_v1(jsonb, text, uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.request_label_generation_batch(uuid, text, uuid, text, uuid[], text) TO service_role;
GRANT EXECUTE ON FUNCTION public.request_label_generation_bulk_v1(jsonb, text, uuid, text, text) TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_label_renderer_role') THEN
    GRANT EXECUTE ON FUNCTION public.request_label_generation_enqueue_shared_v1(jsonb, text, uuid, text, text) TO edge_label_renderer_role;
    GRANT EXECUTE ON FUNCTION public.request_label_generation_batch(uuid, text, uuid, text, uuid[], text) TO edge_label_renderer_role;
    GRANT EXECUTE ON FUNCTION public.request_label_generation_bulk_v1(jsonb, text, uuid, text, text) TO edge_label_renderer_role;
  END IF;
END;
$$;

SELECT pg_advisory_unlock(hashtext('202603063500_request_label_generation_enqueue_shared_v1'));
COMMIT;
