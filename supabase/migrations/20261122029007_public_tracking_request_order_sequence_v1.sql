-- Migration: Deterministic public tracking request ordering
-- Why:
--   - Requester session rehydrate must surface the latest request outcome for
--     the verified shipment.
--   - Multiple request/review events can share a transaction timestamp, so the
--     ordering needs a monotonic request sequence instead of UUID tie-breaking.

BEGIN;
SELECT pg_advisory_xact_lock(hashtext('20261122029007_public_tracking_request_order_sequence_v1'));
SET LOCAL search_path TO public, extensions, pg_temp;

CREATE SEQUENCE public.public_tracking_request_order_seq;
REVOKE ALL ON SEQUENCE public.public_tracking_request_order_seq FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SEQUENCE public.public_tracking_request_order_seq TO service_role;

LOCK TABLE public.support_cases IN SHARE ROW EXCLUSIVE MODE;

WITH ordered AS (
  SELECT
    sc.id,
    row_number() OVER (ORDER BY sc.created_at, sc.id)::BIGINT AS request_order
  FROM public.support_cases sc
  WHERE COALESCE(NULLIF(sc.request_source, ''), NULLIF(sc.metadata->>'source', '')) = 'public_tracking'
    AND NULLIF(sc.metadata #>> ARRAY['public_tracking_request_order'], '') IS NULL
)
UPDATE public.support_cases sc
   SET metadata = jsonb_set(
     COALESCE(sc.metadata, '{}'::jsonb),
     ARRAY['public_tracking_request_order'],
     to_jsonb(ordered.request_order),
     TRUE
   )
  FROM ordered
 WHERE sc.id = ordered.id;

DO $do$
DECLARE
  v_max_order BIGINT := 0;
BEGIN
  SELECT COALESCE(
           max(
             CASE
               WHEN sc.metadata #>> ARRAY['public_tracking_request_order'] ~ '^[0-9]+$'
                 THEN (sc.metadata #>> ARRAY['public_tracking_request_order'])::BIGINT
               ELSE NULL
             END
           ),
           0
         )
    INTO v_max_order
    FROM public.support_cases sc
   WHERE COALESCE(NULLIF(sc.request_source, ''), NULLIF(sc.metadata->>'source', '')) = 'public_tracking';

  IF v_max_order > 0 THEN
    PERFORM setval('public.public_tracking_request_order_seq'::regclass, v_max_order, TRUE);
  ELSE
    PERFORM setval('public.public_tracking_request_order_seq'::regclass, 1, FALSE);
  END IF;
END;
$do$;

CREATE OR REPLACE FUNCTION public.set_public_tracking_request_order_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO public, extensions, pg_temp
AS $function$
BEGIN
  IF COALESCE(NULLIF(NEW.request_source, ''), NULLIF(NEW.metadata->>'source', '')) = 'public_tracking'
     AND NULLIF(NEW.metadata #>> ARRAY['public_tracking_request_order'], '') IS NULL THEN
    NEW.metadata := jsonb_set(
      COALESCE(NEW.metadata, '{}'::jsonb),
      ARRAY['public_tracking_request_order'],
      to_jsonb(nextval('public.public_tracking_request_order_seq'::regclass)),
      TRUE
    );
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE TRIGGER trg_support_cases_public_tracking_request_order_v1
BEFORE INSERT ON public.support_cases
FOR EACH ROW
EXECUTE FUNCTION public.set_public_tracking_request_order_v1();

CREATE OR REPLACE FUNCTION public.public_tracking_session_v1(
  p_input JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_input JSONB := COALESCE(p_input, '{}'::jsonb);
  v_token TEXT := NULLIF(btrim(COALESCE(v_input->>'session_token', '')), '');
  v_ip_hash TEXT := NULLIF(btrim(COALESCE(v_input->>'ip_hash', '')), '');
  v_global_policy JSONB := public.public_tracking_policy_v1('{}'::jsonb);
  v_rate RECORD;
  v_session RECORD;
  v_policy JSONB;
  v_payload JSONB;
  v_latest_request JSONB;
BEGIN
  IF v_token IS NULL OR v_ip_hash IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'invalid_session'));
  END IF;

  SELECT * INTO v_rate
  FROM public.public_tracking_rate_limit_state_v1(v_global_policy, 'session', v_ip_hash)
  LIMIT 1;

  IF COALESCE(v_rate.recent_requests, 0) >= COALESCE(v_rate.max_requests, 1) THEN
    PERFORM public.public_tracking_log_event_v1('session', v_ip_hash, NULL, 'rate_limited');
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'rate_limited'));
  END IF;

  SELECT ts.id, ts.organization_id, ts.client_id, ts.sender_id, ts.shipment_id, ts.expires_at
    INTO v_session
    FROM public.tracking_sessions ts
   WHERE ts.status = 'active'
     AND (ts.expires_at IS NULL OR ts.expires_at > workflow_now())
     AND ts.token_hash = crypt(v_token, ts.token_hash)
   ORDER BY ts.created_at DESC
   LIMIT 1;

  IF NOT FOUND THEN
    PERFORM public.public_tracking_log_event_v1('session', v_ip_hash, NULL, 'invalid_session');
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'invalid_session'));
  END IF;

  UPDATE public.tracking_sessions
  SET last_viewed_at = workflow_now(),
      view_count = view_count + 1
  WHERE id = v_session.id;

  v_policy := public.public_tracking_policy_v1(jsonb_build_object(
    'organization_id', v_session.organization_id,
    'client_id', v_session.client_id,
    'sender_id', v_session.sender_id
  ));

  v_payload := public.public_tracking_build_payload_v1(v_session.id, v_policy);

  SELECT jsonb_strip_nulls(
           jsonb_build_object(
             'support_case_id', sc.id,
             'request_type', sc.request_type_key,
             'outcome',
               COALESCE(
                 NULLIF(btrim(sc.request_outcome), ''),
                 CASE
                   WHEN NULLIF(btrim(sc.status_reason), '') = 'applied' THEN 'applied'
                   WHEN NULLIF(btrim(sc.status_reason), '') = 'rejected' THEN 'rejected'
                   WHEN NULLIF(btrim(sc.status), '') = 'open' THEN 'pending_review'
                   ELSE NULL
                 END
               )
           )
         )
    INTO v_latest_request
    FROM public.support_cases sc
    JOIN public.shipments s
      ON s.id = v_session.shipment_id
     AND s.client_id = v_session.client_id
    LEFT JOIN LATERAL (
      SELECT max(sce.created_at) AS last_event_at
      FROM public.support_case_events sce
      WHERE sce.support_case_id = sc.id
        AND sce.event_type IN ('requested', 'applied', 'rejected')
    ) latest_event ON true
    LEFT JOIN LATERAL (
      SELECT CASE
               WHEN sc.metadata #>> ARRAY['public_tracking_request_order'] ~ '^[0-9]+$'
                 THEN (sc.metadata #>> ARRAY['public_tracking_request_order'])::BIGINT
               ELSE 0
             END AS request_order
    ) request_sequence ON true
   WHERE sc.organization_id = v_session.organization_id
     AND sc.client_id = v_session.client_id
     AND sc.request_source = 'public_tracking'
     AND sc.tracking_number = s.tracking_number
     AND COALESCE(
           NULLIF(btrim(sc.request_outcome), ''),
           CASE
             WHEN NULLIF(btrim(sc.status_reason), '') = 'applied' THEN 'applied'
             WHEN NULLIF(btrim(sc.status_reason), '') = 'rejected' THEN 'rejected'
             WHEN NULLIF(btrim(sc.status), '') = 'open' THEN 'pending_review'
             ELSE NULL
           END
         ) IS NOT NULL
   ORDER BY request_sequence.request_order DESC,
            COALESCE(latest_event.last_event_at, sc.created_at) DESC,
            sc.created_at DESC,
            sc.id DESC
   LIMIT 1;

  IF v_latest_request IS NOT NULL AND v_latest_request <> '{}'::jsonb THEN
    v_payload := public.deep_merge_jsonb(
      v_payload,
      jsonb_build_object('request', v_latest_request)
    );
  END IF;

  PERFORM public.public_tracking_log_event_v1(
    'session',
    v_ip_hash,
    NULL,
    'rehydrated',
    v_session.organization_id,
    v_session.client_id,
    v_session.shipment_id,
    v_session.id
  );

  RETURN jsonb_build_object('ok', TRUE, 'tracking', v_payload);
END;
$function$;

COMMIT;
