-- Mobile V2 POD same-context readback.
-- Keeps submit_fieldops_proof_v1 as the mobile write contract, but makes
-- the backend read model visible immediately to stop detail and route screens:
--   - route_stops.metadata.proof records the committed POD methods.
--   - resolve_fieldops_tasks_v1 exposes route_stop_status in task meta so
--     the Route tab can reflect done/failed from route-stop truth.
--   - terminal route_stop_status also drives task CTA/tone readback so
--     Mobile V2 task cards do not keep saying Open/Scan after completion.

BEGIN;
SET search_path TO public, extensions, pg_temp;

CREATE SCHEMA IF NOT EXISTS api;
GRANT USAGE ON SCHEMA api TO authenticated, service_role;

INSERT INTO public.lookup_definitions (
  category,
  description,
  owner_role,
  approval_policy,
  is_mutable
)
VALUES (
  'decision_category',
  'Business decision categories for decision_log',
  'engineering',
  'tier_1',
  FALSE
)
ON CONFLICT (category) DO NOTHING;

WITH decision_category_definition AS (
  SELECT id
    FROM public.lookup_definitions
   WHERE category = 'decision_category'
   LIMIT 1
)
INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  description,
  sort_order,
  is_default,
  metadata
)
SELECT
  d.id,
  'fieldops_stop_detail_read',
  'FieldOps stop detail read',
  'Audit category for Mobile V2 stop-detail resolver readback.',
  9320,
  FALSE,
  '{}'::jsonb
FROM decision_category_definition d
WHERE d.id IS NOT NULL
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    description = EXCLUDED.description,
    sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata,
    updated_at = now();

CREATE OR REPLACE FUNCTION public.submit_fieldops_proof_v1(
  p_stop_id UUID,
  p_outcome TEXT,
  p_evidence JSONB,
  p_idempotency_key UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id   UUID := auth.uid();
  v_org       UUID;
  v_outcome   TEXT := lower(btrim(COALESCE(p_outcome, '')));
  v_stop      public.route_stops%ROWTYPE;
  v_existing  UUID;
  v_meta      JSONB;
  v_prev_status TEXT;
  v_new_status  TEXT;
  v_decision_id UUID;
  v_proof JSONB;
  v_method TEXT;
  v_methods TEXT[];
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_proof_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;
  v_org := public.current_user_org_id();
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_proof_v1 requires organization context' USING ERRCODE = '42501';
  END IF;

  IF p_stop_id IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_proof_v1 requires stop_id' USING ERRCODE = '22023';
  END IF;
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_proof_v1 requires idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF v_outcome NOT IN ('delivered', 'failed', 'partial') THEN
    RAISE EXCEPTION 'submit_fieldops_proof_v1: invalid outcome %', p_outcome USING ERRCODE = '22023';
  END IF;

  v_existing := public.fieldops_v2_existing_decision_v1(v_org, 'fieldops_proof', p_idempotency_key);
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object(
      'decision_log_id', v_existing,
      'ok', TRUE,
      'state', 'replayed',
      'stop_id', p_stop_id
    );
  END IF;

  SELECT * INTO v_stop FROM public.route_stops WHERE id = p_stop_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'submit_fieldops_proof_v1: stop % not found', p_stop_id USING ERRCODE = '22023';
  END IF;
  IF v_stop.organization_id IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'submit_fieldops_proof_v1: stop % outside tenant scope', p_stop_id USING ERRCODE = '42501';
  END IF;

  v_meta := COALESCE(v_stop.metadata, '{}'::jsonb);
  v_prev_status := lower(COALESCE(NULLIF(btrim(v_meta->>'status'), ''), 'pending'));
  IF v_prev_status NOT IN ('pending', 'en_route', 'arrived') THEN
    RAISE EXCEPTION 'submit_fieldops_proof_v1: stop is in terminal state %', v_prev_status USING ERRCODE = 'P0001';
  END IF;

  v_new_status := CASE v_outcome
    WHEN 'delivered' THEN 'done'
    WHEN 'failed'    THEN 'failed'
    WHEN 'partial'   THEN 'partial'
  END;

  v_proof := CASE
    WHEN jsonb_typeof(v_meta->'proof') = 'object' THEN v_meta->'proof'
    ELSE '{}'::jsonb
  END;

  SELECT COALESCE(array_agg(method), ARRAY[]::text[])
    INTO v_methods
    FROM regexp_split_to_table(lower(COALESCE(p_evidence->>'pod_methods', '')), '[^a-z0-9_]+') AS method
   WHERE method <> '';

  IF v_outcome = 'delivered' THEN
    IF COALESCE(array_length(v_methods, 1), 0) = 0 THEN
      v_methods := ARRAY['scan', 'photo', 'sig'];
    END IF;
    FOREACH v_method IN ARRAY v_methods LOOP
      IF v_method IN ('scan', 'photo', 'sig', 'otp', 'id', 'cod') THEN
        v_proof := jsonb_set(v_proof, ARRAY[v_method], 'true'::jsonb, TRUE);
      END IF;
    END LOOP;
  END IF;

  UPDATE public.route_stops
     SET metadata = jsonb_set(
                      jsonb_set(
                        jsonb_set(v_meta, '{status}', to_jsonb(v_new_status), TRUE),
                        '{last_proof}',
                        jsonb_build_object(
                          'outcome', v_outcome,
                          'evidence', COALESCE(p_evidence, '{}'::jsonb),
                          'submitted_at', now(),
                          'submitted_by', v_user_id
                        ),
                        TRUE
                      ),
                      '{proof}',
                      v_proof,
                      TRUE
                    ),
         updated_at = now()
   WHERE id = v_stop.id;

  v_decision_id := public.log_decision(
    p_organization_id     := v_org,
    p_decision_category   := 'fieldops_proof',
    p_resource_type       := 'route_stop',
    p_resource_id         := v_stop.id,
    p_decision_point      := 'submit_proof',
    p_decision_outcome    := v_outcome,
    p_performed_by_system := 'fieldops_mobile_v2',
    p_correlation_id      := p_idempotency_key,
    p_decision_inputs     := jsonb_strip_nulls(jsonb_build_object(
                               'previous_status', v_prev_status,
                               'new_status',      v_new_status,
                               'proof',           v_proof,
                               'evidence',        COALESCE(p_evidence, '{}'::jsonb),
                               'actor_user_id',   v_user_id
                             )),
    p_decision_reason     := NULL,
    p_settings_resolution_id := NULL
  );

  RETURN jsonb_build_object(
    'decision_log_id', v_decision_id,
    'ok', TRUE,
    'state', v_new_status,
    'stop_id', v_stop.id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.submit_fieldops_proof_v1(UUID, TEXT, JSONB, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_fieldops_proof_v1(UUID, TEXT, JSONB, UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.submit_fieldops_proof_v1(
  p_stop_id UUID,
  p_outcome TEXT,
  p_evidence JSONB,
  p_idempotency_key UUID
)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.submit_fieldops_proof_v1(p_stop_id, p_outcome, p_evidence, p_idempotency_key);
$$;

REVOKE ALL ON FUNCTION api.submit_fieldops_proof_v1(UUID, TEXT, JSONB, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.submit_fieldops_proof_v1(UUID, TEXT, JSONB, UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.resolve_fieldops_tasks_v1(
  p_active_role TEXT DEFAULT 'driver',
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  task_id TEXT,
  type TEXT,
  title TEXT,
  sub TEXT,
  urgency TEXT,
  cta TEXT,
  route TEXT,
  eta_iso TIMESTAMPTZ,
  priority INT,
  area TEXT,
  code TEXT,
  action TEXT,
  tone TEXT,
  meta JSONB
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_caller_org UUID;
  v_active_role TEXT := lower(btrim(COALESCE(p_active_role, 'driver')));
  v_now TIMESTAMPTZ := now();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'resolve_fieldops_tasks_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;

  v_caller_org := public.current_user_org_id();
  IF v_caller_org IS NULL THEN
    RAISE EXCEPTION 'resolve_fieldops_tasks_v1: caller has no organization context' USING ERRCODE = '42501';
  END IF;

  IF v_active_role IN ('driver', 'rider') THEN
    RETURN QUERY
    SELECT
      ('stop:' || rs.id::text) AS task_id,
      COALESCE(rs.stop_kind, 'delivery') AS type,
      COALESCE(s.tracking_number, 'STOP-' || substr(rs.id::text, 1, 6)) AS title,
      CONCAT_WS(
        ' ' || chr(183) || ' ',
        NULLIF(s.service_level, ''),
        CASE WHEN s.cod_amount IS NOT NULL AND s.cod_amount > 0
             THEN 'COD ' || s.cod_amount::text || ' ' || COALESCE(s.cod_currency, 'SAR')
             ELSE NULL END,
        NULLIF(rs.metadata->>'area', '')
      ) AS sub,
      public.fieldops_v2_classify_urgency(rs.planned_window_start_at, v_now) AS urgency,
      CASE lower(COALESCE(NULLIF(btrim(rs.metadata->>'status'), ''), 'pending'))
        WHEN 'done' THEN 'Done'
        WHEN 'failed' THEN 'Failed'
        WHEN 'partial' THEN 'Partial'
        ELSE CASE
          WHEN rs.planned_window_start_at IS NOT NULL
           AND rs.planned_window_start_at <= v_now + INTERVAL '60 minutes' THEN 'Start'
          ELSE 'Open'
        END
      END AS cta,
      ('/mobile/stop/' || rs.id::text) AS route,
      rs.planned_window_start_at AS eta_iso,
      public.fieldops_v2_priority_int(s.priority_score) AS priority,
      NULLIF(rs.metadata->>'area', '') AS area,
      s.tracking_number AS code,
      lower(rs.stop_kind) AS action,
      CASE lower(COALESCE(NULLIF(btrim(rs.metadata->>'status'), ''), 'pending'))
        WHEN 'done' THEN 'success'
        WHEN 'failed' THEN 'danger'
        WHEN 'partial' THEN 'warning'
        ELSE public.fieldops_v2_resolve_tone(
          public.fieldops_v2_classify_urgency(rs.planned_window_start_at, v_now),
          public.fieldops_v2_priority_int(s.priority_score),
          rs.planned_window_start_at,
          v_now
        )
      END AS tone,
      jsonb_strip_nulls(jsonb_build_object(
        'route_run_id', rr.id,
        'route_run_status', rr.status,
        'route_stop_status', lower(COALESCE(NULLIF(btrim(rs.metadata->>'status'), ''), 'pending')),
        'shipment_id', rs.shipment_id,
        'client_id', rs.client_id,
        'sequence_order', rs.sequence_order,
        'service_level', s.service_level,
        'cod_amount', s.cod_amount,
        'cod_currency', s.cod_currency,
        'box_count', s.box_count,
        'shipment_status', s.status
      )) AS meta
    FROM public.route_runs rr
    JOIN public.route_stops rs
      ON rs.route_run_id = rr.id
     AND rs.organization_id = rr.organization_id
    LEFT JOIN public.shipments s
      ON s.id = rs.shipment_id
     AND s.client_id = rs.client_id
    WHERE rr.organization_id = v_caller_org
      AND rr.driver_user_id = v_user_id
      AND rr.status NOT IN ('completed', 'cancelled', 'closed')
    ORDER BY
      CASE public.fieldops_v2_classify_urgency(rs.planned_window_start_at, v_now)
        WHEN 'now' THEN 0
        WHEN 'today' THEN 1
        ELSE 2
      END,
      public.fieldops_v2_priority_int(s.priority_score) DESC,
      rs.planned_window_start_at NULLS LAST,
      rs.sequence_order;

  ELSIF v_active_role = 'loader' THEN
    RETURN QUERY
    SELECT
      ('stop:' || rs.id::text) AS task_id,
      COALESCE(rs.stop_kind, 'pickup') AS type,
      COALESCE(s.tracking_number, 'STOP-' || substr(rs.id::text, 1, 6)) AS title,
      CONCAT_WS(' ' || chr(183) || ' ', NULLIF(s.service_level, ''), 'box ' || s.box_count::text) AS sub,
      public.fieldops_v2_classify_urgency(rs.planned_window_start_at, v_now) AS urgency,
      CASE lower(COALESCE(NULLIF(btrim(rs.metadata->>'status'), ''), 'pending'))
        WHEN 'done' THEN 'Done'
        WHEN 'failed' THEN 'Failed'
        WHEN 'partial' THEN 'Partial'
        ELSE 'Scan'
      END AS cta,
      ('/mobile/loader-scan?stop=' || rs.id::text) AS route,
      rs.planned_window_start_at AS eta_iso,
      public.fieldops_v2_priority_int(s.priority_score) AS priority,
      NULLIF(rs.metadata->>'area', '') AS area,
      s.tracking_number AS code,
      'load_scan' AS action,
      CASE lower(COALESCE(NULLIF(btrim(rs.metadata->>'status'), ''), 'pending'))
        WHEN 'done' THEN 'success'
        WHEN 'failed' THEN 'danger'
        WHEN 'partial' THEN 'warning'
        ELSE public.fieldops_v2_resolve_tone(
          public.fieldops_v2_classify_urgency(rs.planned_window_start_at, v_now),
          public.fieldops_v2_priority_int(s.priority_score),
          rs.planned_window_start_at,
          v_now
        )
      END AS tone,
      jsonb_build_object(
        'route_run_id', rr.id,
        'route_stop_status', lower(COALESCE(NULLIF(btrim(rs.metadata->>'status'), ''), 'pending')),
        'shipment_id', rs.shipment_id,
        'client_id', rs.client_id,
        'box_count', s.box_count,
        'shipment_status', s.status
      ) AS meta
    FROM public.route_runs rr
    JOIN public.route_stops rs
      ON rs.route_run_id = rr.id
     AND rs.organization_id = rr.organization_id
    LEFT JOIN public.shipments s
      ON s.id = rs.shipment_id
     AND s.client_id = rs.client_id
    WHERE rr.organization_id = v_caller_org
      AND rr.status IN ('planned', 'loading', 'in_progress', 'started')
      AND rs.stop_kind IN ('pickup', 'load', 'transfer')
    ORDER BY
      CASE public.fieldops_v2_classify_urgency(rs.planned_window_start_at, v_now)
        WHEN 'now' THEN 0
        WHEN 'today' THEN 1
        ELSE 2
      END,
      public.fieldops_v2_priority_int(s.priority_score) DESC,
      rs.sequence_order;

  ELSIF v_active_role = 'supervisor' THEN
    RETURN QUERY
    SELECT
      ('run:' || rr.id::text) AS task_id,
      'route_review' AS type,
      COALESCE('Run ' || substr(rr.id::text, 1, 8), 'Run') AS title,
      CONCAT_WS(' ' || chr(183) || ' ', rr.status, rr.planned_date::text) AS sub,
      public.fieldops_v2_classify_urgency(rr.planned_start_at, v_now) AS urgency,
      'Review' AS cta,
      ('/mobile/supervisor-today?run=' || rr.id::text) AS route,
      rr.planned_start_at AS eta_iso,
      public.fieldops_v2_priority_int(
        CASE
          WHEN rr.metadata ? 'priority_score'
          THEN (rr.metadata->>'priority_score')::numeric::int
          ELSE 50
        END
      ) AS priority,
      NULLIF(rr.metadata->>'area', '') AS area,
      ('RUN-' || substr(rr.id::text, 1, 6)) AS code,
      'review' AS action,
      public.fieldops_v2_resolve_tone(
        public.fieldops_v2_classify_urgency(rr.planned_start_at, v_now),
        public.fieldops_v2_priority_int(
          CASE
            WHEN rr.metadata ? 'priority_score'
            THEN (rr.metadata->>'priority_score')::numeric::int
            ELSE 50
          END
        ),
        rr.planned_start_at,
        v_now
      ) AS tone,
      jsonb_build_object(
        'route_run_id', rr.id,
        'route_run_status', rr.status,
        'driver_user_id', rr.driver_user_id,
        'branch_id', rr.branch_id
      ) AS meta
    FROM public.route_runs rr
    WHERE rr.organization_id = v_caller_org
      AND rr.status IN ('pending_review', 'requires_review', 'awaiting_approval')
    ORDER BY
      CASE public.fieldops_v2_classify_urgency(rr.planned_start_at, v_now)
        WHEN 'now' THEN 0
        WHEN 'today' THEN 1
        ELSE 2
      END,
      rr.planned_start_at NULLS LAST;

  ELSE
    RETURN;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_fieldops_tasks_v1(TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_fieldops_tasks_v1(TEXT, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.resolve_fieldops_tasks_v1(TEXT, JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.resolve_fieldops_tasks_v1(
  p_active_role TEXT DEFAULT 'driver',
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  task_id TEXT,
  type TEXT,
  title TEXT,
  sub TEXT,
  urgency TEXT,
  cta TEXT,
  route TEXT,
  eta_iso TIMESTAMPTZ,
  priority INT,
  area TEXT,
  code TEXT,
  action TEXT,
  tone TEXT,
  meta JSONB
)
LANGUAGE sql
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT * FROM public.resolve_fieldops_tasks_v1(p_active_role, p_context);
$$;

REVOKE ALL ON FUNCTION api.resolve_fieldops_tasks_v1(TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.resolve_fieldops_tasks_v1(TEXT, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.resolve_fieldops_tasks_v1(TEXT, JSONB) TO authenticated, service_role;

COMMIT;
