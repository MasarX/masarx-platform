BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '10s';

GRANT SELECT (organization_id, client_id, sender_id, shipment_id, rating, submitted_at)
  ON public.feedback_events TO ui_rpc_executor;
CREATE POLICY feedback_events_executor_select ON public.feedback_events
  FOR SELECT TO ui_rpc_executor USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
    )
    OR (
      public.current_user_scope_type() = 'client'
      AND client_id IS NOT NULL
      AND client_id = public.current_user_client_id()
    )
    OR (
      public.current_user_scope_type() = 'sender'
      AND sender_id IS NOT NULL
      AND sender_id = public.current_user_sender_id()
    )
  );

CREATE INDEX idx_shipments_delivered_at_org
  ON public.shipments (delivered_at, organization_id)
  WHERE delivered_at IS NOT NULL;

DO $directory$
DECLARE
  original_view text := regexp_replace(pg_get_viewdef('public.v_driver_directory'::regclass, true), ';\s*$', '');
BEGIN
  EXECUTE format($view$
    CREATE OR REPLACE VIEW public.v_driver_directory WITH (security_invoker = true) AS
    WITH delivery_evidence AS (
      SELECT DISTINCT ON (shipment.organization_id, shipment.client_id, shipment.id)
        shipment.organization_id, shipment.client_id, shipment.id AS shipment_id,
        assignment.driver_user_id AS user_id, shipment.delivered_at, stop.planned_window_end_at
      FROM public.shipments AS shipment
      JOIN public.route_stops AS stop
        ON stop.organization_id = shipment.organization_id AND stop.client_id = shipment.client_id
        AND stop.shipment_id = shipment.id AND stop.stop_kind = 'delivery'
        AND stop.created_at <= shipment.delivered_at
      JOIN public.route_run_assignments AS assignment
        ON assignment.organization_id = stop.organization_id AND assignment.route_run_id = stop.route_run_id
        AND assignment.driver_user_id IS NOT NULL AND assignment.assigned_at <= shipment.delivered_at
        AND assignment.assignment_status IN ('accepted', 'completed')
        AND assignment.accepted_at <= shipment.delivered_at
      WHERE shipment.delivered_at >= date_trunc('week', statement_timestamp(), 'UTC')
        AND shipment.delivered_at <= statement_timestamp()
      ORDER BY shipment.organization_id, shipment.client_id, shipment.id,
        stop.created_at DESC, assignment.assigned_at DESC, stop.id
    ), completion_kpis AS (
      SELECT organization_id, user_id,
        count(*) FILTER (WHERE delivered_at >= date_trunc('day', statement_timestamp(), 'UTC'))::int AS deliveries_today,
        count(*)::int AS deliveries_week,
        avg((delivered_at <= planned_window_end_at)::int) AS on_time_pct
      FROM delivery_evidence GROUP BY organization_id, user_id
    ), rating_kpis AS (
      SELECT delivery.organization_id, delivery.user_id, avg(feedback.rating) AS customer_rating
      FROM delivery_evidence AS delivery
      JOIN public.feedback_events AS feedback
        ON feedback.organization_id = delivery.organization_id AND feedback.client_id = delivery.client_id
        AND feedback.shipment_id = delivery.shipment_id AND feedback.submitted_at >= delivery.delivered_at
      GROUP BY delivery.organization_id, delivery.user_id
    )
    SELECT driver.*, completion.deliveries_today, completion.deliveries_week, completion.on_time_pct, ratings.customer_rating
    FROM (%s) AS driver
    LEFT JOIN completion_kpis AS completion USING (organization_id, user_id)
    LEFT JOIN rating_kpis AS ratings USING (organization_id, user_id)
  $view$, original_view);

END;
$directory$;

DO $receipt$
DECLARE
  plan_function constant regprocedure := 'public.ui_rpc_executor_privilege_plan_v1()'::regprocedure;
  feedback_columns constant text[] := ARRAY['organization_id', 'client_id', 'sender_id', 'shipment_id', 'rating', 'submitted_at'];
  relation_projection constant text := $sql$r.oid AS object_id, 'SELECT'::text AS privilege, NULL::text AS column_name
      FROM relations r JOIN pg_class c ON c.oid=r.oid WHERE NOT EXISTS ($sql$;
  scoped_projection constant text := $sql$r.oid AS object_id, 'SELECT'::text AS privilege, selected.column_name
      FROM relations r JOIN pg_class c ON c.oid=r.oid
      CROSS JOIN LATERAL unnest(CASE WHEN r.oid='public.feedback_events'::regclass
        THEN %L::text[] ELSE ARRAY[NULL::text] END) selected(column_name)
      WHERE NOT EXISTS ($sql$;
  definition text := pg_get_functiondef(plan_function);
  prior_seal text;
  prior_before jsonb;
  prior_after jsonb;
  dependencies jsonb;
  current_plan jsonb;
  expected_plan jsonb;
  digest text;
BEGIN
  LOCK TABLE public.marketplace_review_readback_state_v1 IN EXCLUSIVE MODE;
  IF (SELECT relowner FROM pg_class WHERE oid = 'public.marketplace_review_readback_state_v1'::regclass)
      IS DISTINCT FROM current_user::regrole::oid THEN
    RAISE EXCEPTION 'Driver feedback receipt requires the existing receipt owner' USING ERRCODE = '42501';
  END IF;
  prior_seal := obj_description('public.marketplace_review_readback_state_v1'::regclass, 'pg_class');
  SELECT encode(sha256(convert_to(jsonb_object_agg(key, value ORDER BY key)::text, 'UTF8')), 'hex')
    INTO digest FROM public.marketplace_review_readback_state_v1;
  IF prior_seal IS DISTINCT FROM 'marketplace_review_readback_state_v1:sha256:' || digest
     OR cardinality(string_to_array(definition, relation_projection)) <> 2 THEN
    RAISE EXCEPTION 'Unexpected executor receipt or relation projection before adding driver feedback';
  END IF;

  SELECT value INTO STRICT prior_before FROM public.marketplace_review_readback_state_v1 WHERE key = 'plan_before';
  SELECT value INTO STRICT prior_after FROM public.marketplace_review_readback_state_v1 WHERE key = 'plan_after';
  EXECUTE replace(definition, relation_projection, format(scoped_projection, feedback_columns));
  SELECT jsonb_agg(jsonb_build_object('object_kind', 'relation', 'object_id', 'public.feedback_events'::regclass::oid,
    'privilege', 'SELECT', 'column_name', column_name)) INTO dependencies
  FROM unnest(feedback_columns) AS selected(column_name);

  SELECT jsonb_agg(to_jsonb(p) ORDER BY object_kind, object_id, privilege, column_name) INTO current_plan
  FROM public.ui_rpc_executor_privilege_plan_v1() p;
  SELECT jsonb_agg(entry ORDER BY entry->>'object_kind', (entry->>'object_id')::oid,
    entry->>'privilege', entry->>'column_name') INTO expected_plan
  FROM jsonb_array_elements(prior_after || dependencies) entry;
  IF current_plan IS DISTINCT FROM expected_plan THEN
    RAISE EXCEPTION 'Only the scoped driver feedback columns may extend the executor receipt';
  END IF;

  INSERT INTO public.marketplace_review_readback_state_v1(key, value)
  VALUES ('driver_feedback_extension_v1', jsonb_build_object('predecessor_seal', prior_seal,
    'plan_before', prior_before, 'plan_after', prior_after, 'added', dependencies));
  UPDATE public.marketplace_review_readback_state_v1 SET value = (
    SELECT jsonb_agg(entry ORDER BY entry->>'object_kind', (entry->>'object_id')::oid,
      entry->>'privilege', entry->>'column_name')
    FROM jsonb_array_elements(value || dependencies) entry
  ) WHERE key IN ('plan_before', 'plan_after');

  SELECT encode(sha256(convert_to(jsonb_object_agg(key, value ORDER BY key)::text, 'UTF8')), 'hex')
    INTO digest FROM public.marketplace_review_readback_state_v1;
  EXECUTE format('COMMENT ON TABLE public.marketplace_review_readback_state_v1 IS %L',
    'marketplace_review_readback_state_v1:sha256:' || digest);
END;
$receipt$;

CREATE OR REPLACE VIEW public.driver_profile_summary_v1 WITH (security_invoker = true) AS
WITH active_assignment AS (
  SELECT DISTINCT ON (va.assigned_to_user_id)
    va.assigned_to_user_id,
    va.vehicle_id   AS current_vehicle_id,
    va.branch_id    AS current_branch_id,
    va.started_at   AS assignment_started_at
  FROM public.vehicle_assignments va
  WHERE va.status = 'active'
    AND va.ended_at IS NULL
    AND va.assigned_to_user_id IS NOT NULL
  ORDER BY va.assigned_to_user_id, va.started_at DESC
),
latest_license AS (
  SELECT DISTINCT ON (dd.user_id)
    dd.user_id,
    dd.id                AS license_doc_id,
    dd.expires_at        AS license_expires_at,
    dd.metadata          AS license_metadata,
    dd.document_ref_hash AS license_ref_hash,
    dd.status            AS license_status
  FROM public.driver_documents dd
  WHERE dd.doc_type IN ('driver_license', 'license')
  ORDER BY dd.user_id, dd.created_at DESC
)
SELECT
  dp.id,
  dp.organization_id,
  dp.user_id,
  dp.driver_code,
  dp.status,
  dp.hired_at,
  dp.terminated_at,
  dp.metadata        AS profile_metadata,
  dp.created_at,
  dp.updated_at,

  -- Identity projections (users join)
  u.full_name        AS name,
  CASE
    WHEN u.full_name IS NULL OR btrim(u.full_name) = '' THEN ''
    ELSE upper(
      substr(split_part(u.full_name, ' ', 1), 1, 1)
      || COALESCE(substr(split_part(u.full_name, ' ', 2), 1, 1), '')
    )
  END                AS initials,
  -- W41 F4: phone now sourced from driver_profiles.metadata only.
  -- public.users does not have a `phone` column; sourcing through
  -- profile metadata keeps the view canonical and FE-stable.
  NULLIF(btrim(dp.metadata->>'phone'), '')
                     AS phone,

  -- License projections (driver_documents join)
  COALESCE(
    NULLIF(btrim(ll.license_metadata->>'license_number'), ''),
    NULLIF(btrim(ll.license_ref_hash), ''),
    NULLIF(btrim(dp.metadata->>'license_number'), '')
  )                  AS license_number,
  COALESCE(
    NULLIF(btrim(ll.license_metadata->>'class'), ''),
    NULLIF(btrim(dp.metadata->>'license_class'), '')
  )                  AS license_class,
  ll.license_expires_at,

  -- Active assignment projections
  aa.current_vehicle_id,
  aa.current_branch_id,
  aa.assignment_started_at,

  -- Profile metadata fallbacks (resolver landing-pads)
  COALESCE(
    NULLIF(btrim(dp.metadata->>'hours_of_service_state'), ''),
    'off_duty'
  )                  AS hours_of_service_state,
  COALESCE(
    NULLIF(btrim(dp.metadata->>'compliance_score'), '')::NUMERIC,
    0
  )                  AS compliance_score,
  NULLIF(btrim(dp.metadata->>'emergency_contact_name'), '')
                     AS emergency_contact_name,
  NULLIF(btrim(dp.metadata->>'emergency_contact_phone'), '')
                     AS emergency_contact_phone,

  directory.deliveries_today,
  directory.deliveries_week,
  directory.on_time_pct,
  directory.customer_rating
FROM public.driver_profiles dp
LEFT JOIN public.users u
  ON u.id = dp.user_id
LEFT JOIN active_assignment aa
  ON aa.assigned_to_user_id = dp.user_id
LEFT JOIN latest_license ll
  ON ll.user_id = dp.user_id
LEFT JOIN public.v_driver_directory directory
  ON directory.id = dp.id AND directory.organization_id = dp.organization_id;

COMMENT ON COLUMN public.v_driver_directory.deliveries_today IS 'Attributed deliveries completed since the beginning of the UTC day.';
COMMENT ON COLUMN public.v_driver_directory.deliveries_week IS 'Attributed deliveries completed since the beginning of the UTC ISO week.';
COMMENT ON COLUMN public.v_driver_directory.on_time_pct IS 'Fraction of weekly deliveries with a known planned end completed by that end.';
COMMENT ON COLUMN public.v_driver_directory.customer_rating IS 'Mean same-scope rating from feedback for the attributed weekly deliveries.';

COMMIT;
