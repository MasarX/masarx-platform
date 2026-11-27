BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE FUNCTION public.fieldops_route_read_role_v1(
  p_active_role TEXT,
  p_organization_id UUID,
  p_loader_read_resource TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user_id UUID := auth.uid();
  v_role TEXT := lower(btrim(COALESCE(p_active_role, 'driver')));
BEGIN
  IF v_user_id IS NULL
     OR p_organization_id IS NULL
     OR p_organization_id IS DISTINCT FROM public.current_user_org_id()
     OR public.current_user_scope_type() IS DISTINCT FROM 'tenant'
     OR (auth.jwt() ? 'organization_id'
         AND lower(auth.jwt()->>'organization_id') IS DISTINCT FROM p_organization_id::text) THEN
    RAISE EXCEPTION 'FieldOps route read requires tenant access' USING ERRCODE = '42501';
  END IF;

  -- A driver or rider view can only read runs assigned to the caller.
  IF v_role IN ('driver', 'rider') THEN
    RETURN v_role;
  END IF;

  IF v_role NOT IN ('loader', 'supervisor', 'dispatcher')
     OR NOT EXISTS (
       SELECT 1
       FROM public.mobile_v2_active_role active_role
       JOIN public.rbac_user_role_assignments assignment
         ON assignment.user_id = active_role.user_id
        AND assignment.organization_id = active_role.organization_id
        AND assignment.revoked_at IS NULL
       JOIN public.rbac_roles role
         ON role.id = assignment.role_id
        AND role.organization_id = assignment.organization_id
        AND role.is_active
       WHERE active_role.user_id = v_user_id
         AND active_role.organization_id = p_organization_id
         AND active_role.role_key = v_role
         AND lower(COALESCE(NULLIF(role.metadata->>'mobile_v2_role', ''), role.key)) = v_role
     )
     OR NOT COALESCE(CASE WHEN v_role = 'loader' AND p_loader_read_resource = 'tasks'
       THEN public.user_has_permission_v1('tasks.read', p_organization_id)
       ELSE public.user_has_resource_capability_v1('routes', 'read', 'tenant', p_organization_id)
     END, FALSE) THEN
    RAISE EXCEPTION 'FieldOps route read requires an authorized active role' USING ERRCODE = '42501';
  END IF;

  RETURN v_role;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.fieldops_route_read_role_v1(TEXT, UUID, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fieldops_route_read_role_v1(TEXT, UUID, TEXT) TO postgres;

CREATE OR REPLACE FUNCTION public.resolve_fieldops_stop_detail_base_v1(
  p_stop_id UUID,
  p_active_role TEXT DEFAULT 'driver',
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id      UUID := auth.uid();
  v_caller_org   UUID;
  v_active_role  TEXT;
  v_now          TIMESTAMPTZ := now();
  v_correlation  UUID;

  v_stop         public.route_stops%ROWTYPE;
  v_run          public.route_runs%ROWTYPE;
  v_ship         public.shipments%ROWTYPE;
  v_recipient    public.recipients%ROWTYPE;
  v_addr         public.addresses%ROWTYPE;
  v_total_stops  INT;

  v_initials     TEXT;
  v_address_lines JSONB;
  v_address_note  TEXT;
  v_hazards      JSONB;
  v_parcels      JSONB;
  v_proof        JSONB;
  v_timeline     JSONB;
  v_cod          JSONB;
  v_window_label TEXT;
  v_eta_minutes  INT;
  v_distance_km  NUMERIC(10,2);
  v_total_weight NUMERIC(10,2);
  v_total_units  INT;
  v_parcels_label TEXT;
  v_envelope     JSONB;
  v_otp_required BOOLEAN;
BEGIN
  -- Fail-closed on unauthenticated.
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'resolve_fieldops_stop_detail_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  v_caller_org := public.current_user_org_id();
  IF v_caller_org IS NULL THEN
    RAISE EXCEPTION 'resolve_fieldops_stop_detail_v1: caller has no organization context'
      USING ERRCODE = '42501';
  END IF;

  v_active_role := public.fieldops_route_read_role_v1(p_active_role, v_caller_org, 'routes');

  -- Required input.
  IF p_stop_id IS NULL THEN
    RAISE EXCEPTION 'resolve_fieldops_stop_detail_v1 requires stop_id'
      USING ERRCODE = '22023';
  END IF;

  -- Optional correlation id for audit trace.
  v_correlation := NULLIF(btrim(COALESCE(p_context->>'correlation_id', '')), '')::uuid;

  -- Fetch the anchor stop. Do NOT filter by org here — we want a distinct
  -- 42501 for cross-org versus a not-found 22023 so the FE error-mapping can
  -- distinguish the two.
  SELECT * INTO v_stop
    FROM public.route_stops
   WHERE id = p_stop_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'resolve_fieldops_stop_detail_v1: stop % not found', p_stop_id
      USING ERRCODE = '22023';
  END IF;

  -- Cross-org isolation: a stop NOT in the caller's org must raise 42501.
  -- This protects against authenticated callers probing other tenants.
  IF v_stop.organization_id IS DISTINCT FROM v_caller_org THEN
    RAISE EXCEPTION 'resolve_fieldops_stop_detail_v1: stop % outside tenant scope', p_stop_id
      USING ERRCODE = '42501';
  END IF;

  -- Fetch the owning route_run. Trigger
  -- route_stops_enforce_org_match_v1 guarantees same-org, so v_run.org will
  -- equal v_stop.org if it exists; we still defensively check.
  SELECT * INTO v_run
    FROM public.route_runs
   WHERE id = v_stop.route_run_id
     AND organization_id = v_caller_org;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'resolve_fieldops_stop_detail_v1: route_run % outside tenant scope', v_stop.route_run_id
      USING ERRCODE = '42501';
  END IF;

  -- Narrow stop detail to the caller's assigned run in driver and rider views.
  IF v_active_role IN ('driver', 'rider')
     AND v_run.driver_user_id IS DISTINCT FROM v_user_id THEN
    RAISE EXCEPTION 'resolve_fieldops_stop_detail_v1: stop % is not assigned to caller', p_stop_id
      USING ERRCODE = '42501';
  END IF;

  -- Fetch shipment (org + client deterministic join).
  SELECT * INTO v_ship
    FROM public.shipments
   WHERE id = v_stop.shipment_id
     AND client_id = v_stop.client_id
     AND organization_id = v_caller_org;

  -- v_ship may be NULL if the shipment row was archived; resolver continues
  -- with NULLs rather than failing so the FE can render an empty parcel list.

  -- Fetch recipient (row owns customer name + phone). The recipients table
  -- is shared reference data; we still scope by client_id + org for safety.
  IF v_ship.recipient_id IS NOT NULL THEN
    SELECT * INTO v_recipient
      FROM public.recipients
     WHERE id = v_ship.recipient_id
       AND organization_id = v_caller_org;
  END IF;

  -- Fetch destination address (delivery) or origin address (pickup / rto).
  IF v_stop.stop_kind = 'pickup' THEN
    IF v_ship.origin_address_id IS NOT NULL THEN
      SELECT * INTO v_addr
        FROM public.addresses
       WHERE id = v_ship.origin_address_id
         AND client_id = v_stop.client_id
         AND organization_id = v_caller_org;
    END IF;
  ELSE
    IF v_ship.destination_address_id IS NOT NULL THEN
      SELECT * INTO v_addr
        FROM public.addresses
       WHERE id = v_ship.destination_address_id
         AND client_id = v_stop.client_id
         AND organization_id = v_caller_org;
    END IF;
  END IF;

  -- Total stops on the run for "Stop X of Y".
  SELECT COUNT(*)::int INTO v_total_stops
    FROM public.route_stops
   WHERE route_run_id = v_run.id
     AND organization_id = v_caller_org;

  -- Customer initials (up to 2 alpha glyphs from the first 2 name tokens).
  IF v_recipient.name IS NOT NULL AND length(btrim(v_recipient.name)) > 0 THEN
    SELECT string_agg(upper(substring(part FROM 1 FOR 1)), '')
      INTO v_initials
      FROM (
        SELECT part
          FROM regexp_split_to_table(btrim(v_recipient.name), '\s+') AS part
         LIMIT 2
      ) parts;
  END IF;
  v_initials := COALESCE(NULLIF(v_initials, ''), '—');

  -- Address lines (line1 + optional line2 + city). Build a values-driven
  -- array so NULL / empty entries collapse cleanly without per-line branching.
  SELECT COALESCE(jsonb_agg(line ORDER BY ord), '[]'::jsonb)
    INTO v_address_lines
    FROM (
      VALUES
        (1, NULLIF(btrim(v_addr.normalized_line1), '')),
        (2, NULLIF(btrim(v_addr.normalized_line2), '')),
        (3, NULLIF(btrim(v_addr.city), ''))
    ) AS raw(ord, line)
   WHERE line IS NOT NULL;
  v_address_note := NULLIF(btrim(COALESCE(v_addr.additional_directions, v_stop.metadata->>'address_note', '')), '');

  -- COD envelope (only when shipment carries COD).
  IF v_ship.cod_amount IS NOT NULL AND v_ship.cod_amount > 0 THEN
    v_cod := jsonb_build_object(
      'amount',   v_ship.cod_amount,
      'currency', COALESCE(NULLIF(btrim(v_ship.cod_currency), ''), 'SAR')
    );
  ELSE
    v_cod := NULL;
  END IF;

  -- OTP requirement (row-driven).
  v_otp_required := public.fieldops_v2_stop_otp_required_v1(
    COALESCE(v_ship.metadata, '{}'::jsonb),
    COALESCE(v_stop.metadata, '{}'::jsonb),
    v_ship.service_level
  );

  -- Hazard chips: derived from row data. Each entry is shape-compatible
  -- with MobileV2StopHazardChip { label, tone, icon? }.
  v_hazards := (
    SELECT jsonb_agg(chip)
      FROM (
        SELECT jsonb_build_object(
                 'label', 'Collect ' || v_ship.cod_amount::text || ' '
                          || COALESCE(NULLIF(btrim(v_ship.cod_currency), ''), 'SAR'),
                 'tone',  'accent',
                 'icon',  'shield'
               ) AS chip
         WHERE v_cod IS NOT NULL
        UNION ALL
        SELECT jsonb_build_object('label','OTP required','tone','info','icon','shield')
         WHERE v_otp_required
        UNION ALL
        SELECT jsonb_build_object('label','Fragile','tone','warning','icon','alert')
         WHERE EXISTS (
           SELECT 1 FROM public.shipment_boxes b
            WHERE b.shipment_id = v_ship.id
              AND COALESCE(b.fragile, FALSE) = TRUE
         )
        UNION ALL
        SELECT jsonb_build_object('label','Hazmat','tone','danger','icon','flame')
         WHERE EXISTS (
           SELECT 1 FROM public.shipment_boxes b
            WHERE b.shipment_id = v_ship.id
              AND COALESCE(b.hazmat, FALSE) = TRUE
         )
      ) chips
  );
  v_hazards := COALESCE(v_hazards, '[]'::jsonb);

  -- Parcels list — shape-compatible with MobileV2StopParcel.
  WITH boxes AS (
    SELECT b.*
      FROM public.shipment_boxes b
     WHERE b.shipment_id = v_ship.id
     ORDER BY b.box_number
  )
  SELECT
    COALESCE(jsonb_agg(
      jsonb_build_object(
        'id',          b.id::text,
        'code',        b.barcode,
        'status',      CASE
                         WHEN b.status IN ('delivered', 'scanned') THEN 'scanned'
                         WHEN b.status = 'missing' THEN 'missing'
                         WHEN b.status = 'damaged' THEN 'damaged'
                         ELSE 'pending'
                       END,
        'description', CONCAT_WS(' · ',
                         NULLIF(v_ship.service_level, ''),
                         CASE WHEN b.weight_kg IS NOT NULL
                              THEN '~' || trim(to_char(b.weight_kg, 'FM999990.0')) || ' kg'
                              ELSE NULL
                         END
                       )
      )
    ), '[]'::jsonb),
    COALESCE(SUM(b.weight_kg), 0)::numeric(10,2),
    COUNT(*)::int
  INTO v_parcels, v_total_weight, v_total_units
  FROM boxes b;

  -- Aggregate label "Nx · X.Y kg" (omit weight when zero).
  IF v_total_units IS NULL OR v_total_units <= 0 THEN
    v_parcels_label := NULL;
  ELSIF v_total_weight > 0 THEN
    v_parcels_label := v_total_units::text || 'x · '
                       || trim(to_char(v_total_weight, 'FM999990.0')) || ' kg';
  ELSE
    v_parcels_label := v_total_units::text || 'x';
  END IF;

  -- Proof checklist: derived from row state, not tenant constants. Items
  -- depend on stop kind + COD presence + OTP presence.
  v_proof := (
    SELECT jsonb_agg(item)
      FROM (
        SELECT jsonb_build_object('key','scan','label','Scan all parcels','status',
                 CASE WHEN COALESCE((v_stop.metadata->'proof'->>'scan')::boolean, FALSE)
                      THEN 'done' ELSE 'pending' END) AS item
        UNION ALL
        SELECT jsonb_build_object('key','photo','label','Capture photo at door','status',
                 CASE WHEN COALESCE((v_stop.metadata->'proof'->>'photo')::boolean, FALSE)
                      THEN 'done' ELSE 'pending' END)
        UNION ALL
        SELECT jsonb_build_object('key','sig','label','Recipient signature','status',
                 CASE WHEN COALESCE((v_stop.metadata->'proof'->>'sig')::boolean, FALSE)
                      THEN 'done' ELSE 'pending' END)
        UNION ALL
        SELECT jsonb_build_object('key','otp','label','OTP verification','status',
                 CASE WHEN COALESCE((v_stop.metadata->'proof'->>'otp')::boolean, FALSE)
                      THEN 'done' ELSE 'pending' END)
         WHERE v_otp_required
        UNION ALL
        SELECT jsonb_build_object(
                 'key','cod',
                 'label','Collect COD ' || v_ship.cod_amount::text || ' '
                          || COALESCE(NULLIF(btrim(v_ship.cod_currency), ''), 'SAR'),
                 'status',
                 CASE WHEN COALESCE((v_stop.metadata->'proof'->>'cod')::boolean, FALSE)
                      THEN 'done' ELSE 'pending' END)
         WHERE v_cod IS NOT NULL
      ) checklist
  );
  v_proof := COALESCE(v_proof, '[]'::jsonb);

  -- Timeline: recent decision_log entries scoped to this stop. We restrict
  -- by org + resource (route_stop / shipment) so cross-org leakage cannot
  -- occur even if a future migration adds rows tied to other resources.
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id',    dl.id::text,
        'label', COALESCE(NULLIF(dl.decision_reason, ''), dl.decision_point),
        'time',  to_char(dl.timestamp AT TIME ZONE 'Asia/Riyadh', 'HH24:MI'),
        'icon',  CASE dl.decision_outcome
                   WHEN 'delivered'   THEN 'check'
                   WHEN 'failed'      THEN 'alert'
                   WHEN 'partial'     THEN 'alert'
                   WHEN 'arrived'     THEN 'navigate'
                   WHEN 'en_route'    THEN 'navigate'
                   ELSE 'check'
                 END,
        'tone',  CASE dl.decision_outcome
                   WHEN 'delivered' THEN 'success'
                   WHEN 'failed'    THEN 'danger'
                   WHEN 'partial'   THEN 'warning'
                   ELSE 'neutral'
                 END
      )
      ORDER BY dl.timestamp ASC
    ), '[]'::jsonb)
  INTO v_timeline
  FROM (
    SELECT *
      FROM public.decision_log dl
     WHERE dl.organization_id = v_caller_org
       AND (
         (dl.resource_type = 'route_stop' AND dl.resource_id = v_stop.id)
         OR (dl.resource_type = 'shipment' AND dl.resource_id = v_ship.id)
       )
     ORDER BY dl.timestamp DESC
     LIMIT 12
  ) dl;

  -- Planned window label "HH:MM" (start) in Asia/Riyadh; empty when null.
  v_window_label := COALESCE(
    to_char(v_stop.planned_window_start_at AT TIME ZONE 'Asia/Riyadh', 'HH24:MI'),
    ''
  );

  -- ETA + distance (metadata-driven; row-level. No geocoding here — that's
  -- a separate resolver scope).
  v_eta_minutes := COALESCE((v_stop.metadata->>'eta_min')::int, 0);
  v_distance_km := COALESCE((v_stop.metadata->>'distance_km')::numeric, 0);

  -- Build the envelope. Field names match MobileV2StopDetail exactly so the
  -- FE can drop the fixture once this resolver is wired through the hooks.
  v_envelope := jsonb_strip_nulls(jsonb_build_object(
    'id',                COALESCE(v_ship.tracking_number,
                                  'STP-' || substr(v_stop.id::text, 1, 6)),
    'seq',               v_stop.sequence_order,
    'stopCount',         v_total_stops,
    'customerInitials',  v_initials,
    'customerName',      COALESCE(v_recipient.name, '—'),
    'customerPhone',     v_recipient.phone_number,
    'trackingCode',      COALESCE(v_ship.tracking_number,
                                  'STP-' || substr(v_stop.id::text, 1, 6)),
    'stopType',          COALESCE(v_stop.stop_kind, 'delivery'),
    'hazards',           v_hazards,
    'etaMinutes',        v_eta_minutes,
    'distanceKm',        v_distance_km,
    'window',            v_window_label,
    'addressLines',      v_address_lines,
    'addressNote',       v_address_note,
    'parcels',           v_parcels,
    'parcelsTotalLabel', v_parcels_label,
    'proofChecklist',    v_proof,
    'timeline',          v_timeline,
    'cod',               v_cod,
    'meta',              jsonb_strip_nulls(jsonb_build_object(
                           'route_run_id',   v_run.id,
                           'route_run_status', v_run.status,
                           'shipment_id',    v_ship.id,
                           'client_id',      v_stop.client_id,
                           'driver_user_id', v_run.driver_user_id,
                           'service_level',  v_ship.service_level,
                           'priority_score', v_ship.priority_score,
                           'special_instructions', v_ship.special_instructions
                         ))
  ));

  -- Audit trail. We use the canonical helper so the row carries
  -- correlation_id (per AGENTS.md trace propagation) and timestamps via
  -- log_decision's clock-aware path.
  PERFORM public.log_decision(
    p_organization_id     := v_caller_org,
    p_decision_category   := 'fieldops_stop_detail_read',
    p_resource_type       := 'route_stop',
    p_resource_id         := v_stop.id,
    p_decision_point      := 'resolve_fieldops_stop_detail_v1',
    p_decision_outcome    := 'ok',
    p_performed_by_system := 'fieldops_mobile_v2',
    p_correlation_id      := v_correlation,
    p_decision_inputs     := jsonb_strip_nulls(jsonb_build_object(
                               'active_role',  v_active_role,
                               'stop_id',      v_stop.id,
                               'route_run_id', v_run.id,
                               'shipment_id',  v_ship.id
                             )),
    p_decision_reason     := NULL,
    p_settings_resolution_id := NULL
  );

  RETURN v_envelope;
END;
$$;

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
  v_active_role TEXT;
  v_now TIMESTAMPTZ := now();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'resolve_fieldops_tasks_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;

  v_caller_org := public.current_user_org_id();
  IF v_caller_org IS NULL THEN
    RAISE EXCEPTION 'resolve_fieldops_tasks_v1: caller has no organization context' USING ERRCODE = '42501';
  END IF;

  v_active_role := public.fieldops_route_read_role_v1(p_active_role, v_caller_org, 'tasks');

  IF v_active_role IN ('driver', 'rider') THEN
    RETURN QUERY
    SELECT
      ('stop:' || rs.id::text) AS task_id,
      COALESCE(rs.stop_kind, 'delivery') AS type,
      CASE
        WHEN lower(COALESCE(rs.stop_kind, '')) = 'pickup'
        THEN COALESCE(NULLIF(btrim(s.client_reference_number), ''), NULLIF(btrim(s.tracking_number), ''), 'STOP-' || substr(rs.id::text, 1, 6))
        ELSE COALESCE(NULLIF(btrim(s.tracking_number), ''), NULLIF(btrim(s.client_reference_number), ''), 'STOP-' || substr(rs.id::text, 1, 6))
      END AS title,
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
        'shipment_status', s.status,
        'client_reference_number', NULLIF(btrim(s.client_reference_number), ''),
        'tracking_number', NULLIF(btrim(s.tracking_number), ''),
        'display_reference', CASE
          WHEN lower(COALESCE(rs.stop_kind, '')) = 'pickup'
          THEN COALESCE(NULLIF(btrim(s.client_reference_number), ''), NULLIF(btrim(s.tracking_number), ''))
          ELSE COALESCE(NULLIF(btrim(s.tracking_number), ''), NULLIF(btrim(s.client_reference_number), ''))
        END,
        'destination_address_id', s.destination_address_id,
        'address_validation_status', da.validation_status,
        'short_address', NULLIF(da.sa_short_code, ''),
        'short_national_address', NULLIF(da.sa_short_code, ''),
        'latitude', geo.latitude,
        'longitude', geo.longitude,
        'destination_latitude', geo.latitude,
        'destination_longitude', geo.longitude,
        'geocoding_status', CASE
          WHEN da.id IS NULL THEN NULL
          WHEN geo.latitude IS NULL OR geo.longitude IS NULL THEN 'needs_review'
          ELSE 'geocoded'
        END,
        'geocoding_accuracy', geo.accuracy_type,
        'geocoding_confidence', geo.confidence_score,
        'geocoding_accuracy_m', geo.accuracy_m,
        'geocoding_provider', geo.provider_name,
        'geocoding_match_strategy', COALESCE(
          geo.match_strategy,
          CASE WHEN NULLIF(da.sa_short_code, '') IS NOT NULL THEN 'sa_short_code' ELSE NULL END
        )
      )) AS meta
    FROM public.route_runs rr
    JOIN public.route_stops rs
      ON rs.route_run_id = rr.id
     AND rs.organization_id = rr.organization_id
    LEFT JOIN public.shipments s
      ON s.id = rs.shipment_id
     AND s.client_id = rs.client_id
    LEFT JOIN public.addresses da
      ON da.id = s.destination_address_id
     AND da.client_id = s.client_id
     AND da.organization_id = rr.organization_id
    LEFT JOIN LATERAL (
      SELECT
        g.provider_name,
        g.confidence_score,
        g.accuracy_type,
        ST_Y(g.coordinates::geometry) AS latitude,
        ST_X(g.coordinates::geometry) AS longitude,
        CASE
          WHEN jsonb_typeof(g.metadata->'accuracy_m') = 'number'
          THEN (g.metadata->>'accuracy_m')::NUMERIC
          WHEN jsonb_typeof(g.metadata->'accuracyM') = 'number'
          THEN (g.metadata->>'accuracyM')::NUMERIC
          ELSE NULL
        END AS accuracy_m,
        COALESCE(
          NULLIF(g.metadata->>'match_strategy', ''),
          NULLIF(g.metadata->>'match_type', ''),
          NULLIF(g.metadata->>'source', '')
        ) AS match_strategy
      FROM public.geocodes g
      WHERE g.address_id = da.id
        AND g.client_id = da.client_id
        AND g.organization_id = da.organization_id
      ORDER BY
        CASE WHEN COALESCE(g.is_primary, FALSE) THEN 0 ELSE 1 END,
        g.geocoded_at DESC NULLS LAST
      LIMIT 1
    ) geo ON TRUE
    WHERE rr.organization_id = v_caller_org
      AND rr.driver_user_id = v_user_id
      AND (
        rr.status NOT IN ('completed', 'cancelled', 'closed')
        OR (
          rr.status = 'completed'
          AND lower(COALESCE(NULLIF(btrim(rs.metadata->>'status'), ''), 'pending')) IN ('done', 'failed', 'partial')
          AND COALESCE(rr.updated_at, rr.ended_at, rr.created_at) >= v_now - INTERVAL '12 hours'
        )
      )
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
      CASE
        WHEN lower(COALESCE(rs.stop_kind, '')) = 'pickup'
        THEN COALESCE(NULLIF(btrim(s.client_reference_number), ''), NULLIF(btrim(s.tracking_number), ''), 'STOP-' || substr(rs.id::text, 1, 6))
        ELSE COALESCE(NULLIF(btrim(s.tracking_number), ''), NULLIF(btrim(s.client_reference_number), ''), 'STOP-' || substr(rs.id::text, 1, 6))
      END AS title,
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
        'shipment_status', s.status,
        'client_reference_number', NULLIF(btrim(s.client_reference_number), ''),
        'tracking_number', NULLIF(btrim(s.tracking_number), ''),
        'display_reference', CASE
          WHEN lower(COALESCE(rs.stop_kind, '')) = 'pickup'
          THEN COALESCE(NULLIF(btrim(s.client_reference_number), ''), NULLIF(btrim(s.tracking_number), ''))
          ELSE COALESCE(NULLIF(btrim(s.tracking_number), ''), NULLIF(btrim(s.client_reference_number), ''))
        END,
        'destination_address_id', s.destination_address_id,
        'address_validation_status', da.validation_status,
        'short_address', NULLIF(da.sa_short_code, ''),
        'short_national_address', NULLIF(da.sa_short_code, ''),
        'latitude', geo.latitude,
        'longitude', geo.longitude,
        'destination_latitude', geo.latitude,
        'destination_longitude', geo.longitude,
        'geocoding_status', CASE
          WHEN da.id IS NULL THEN NULL
          WHEN geo.latitude IS NULL OR geo.longitude IS NULL THEN 'needs_review'
          ELSE 'geocoded'
        END,
        'geocoding_accuracy', geo.accuracy_type,
        'geocoding_confidence', geo.confidence_score,
        'geocoding_accuracy_m', geo.accuracy_m,
        'geocoding_provider', geo.provider_name,
        'geocoding_match_strategy', COALESCE(
          geo.match_strategy,
          CASE WHEN NULLIF(da.sa_short_code, '') IS NOT NULL THEN 'sa_short_code' ELSE NULL END
        )
      ) AS meta
    FROM public.route_runs rr
    JOIN public.route_stops rs
      ON rs.route_run_id = rr.id
     AND rs.organization_id = rr.organization_id
    LEFT JOIN public.shipments s
      ON s.id = rs.shipment_id
     AND s.client_id = rs.client_id
    LEFT JOIN public.addresses da
      ON da.id = s.destination_address_id
     AND da.client_id = s.client_id
     AND da.organization_id = rr.organization_id
    LEFT JOIN LATERAL (
      SELECT
        g.provider_name,
        g.confidence_score,
        g.accuracy_type,
        ST_Y(g.coordinates::geometry) AS latitude,
        ST_X(g.coordinates::geometry) AS longitude,
        CASE
          WHEN jsonb_typeof(g.metadata->'accuracy_m') = 'number'
          THEN (g.metadata->>'accuracy_m')::NUMERIC
          WHEN jsonb_typeof(g.metadata->'accuracyM') = 'number'
          THEN (g.metadata->>'accuracyM')::NUMERIC
          ELSE NULL
        END AS accuracy_m,
        COALESCE(
          NULLIF(g.metadata->>'match_strategy', ''),
          NULLIF(g.metadata->>'match_type', ''),
          NULLIF(g.metadata->>'source', '')
        ) AS match_strategy
      FROM public.geocodes g
      WHERE g.address_id = da.id
        AND g.client_id = da.client_id
        AND g.organization_id = da.organization_id
      ORDER BY
        CASE WHEN COALESCE(g.is_primary, FALSE) THEN 0 ELSE 1 END,
        g.geocoded_at DESC NULLS LAST
      LIMIT 1
    ) geo ON TRUE
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

CREATE OR REPLACE FUNCTION public.resolve_fieldops_pickups_v1(
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
  v_active_role TEXT;
  v_now TIMESTAMPTZ := now();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'resolve_fieldops_pickups_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  v_caller_org := public.current_user_org_id();
  IF v_caller_org IS NULL THEN
    RAISE EXCEPTION 'resolve_fieldops_pickups_v1: caller has no organization context'
      USING ERRCODE = '42501';
  END IF;

  v_active_role := public.fieldops_route_read_role_v1(p_active_role, v_caller_org, 'tasks');

  RETURN QUERY
  SELECT
    ('pickup:' || rs.id::text)                                              AS task_id,
    'pickup'::text                                                          AS type,
    COALESCE(s.tracking_number, 'PU-' || substr(rs.id::text, 1, 6))         AS title,
    CONCAT_WS(' - ',
      NULLIF(s.service_level, ''),
      'box ' || pickup_projection.expected_qty::text,
      NULLIF(rs.metadata->>'area', '')
    )                                                                       AS sub,
    public.fieldops_v2_classify_urgency(rs.planned_window_start_at, v_now)  AS urgency,
    CASE
      WHEN pickup_projection.pickup_status IN ('completed', 'failed') THEN 'Readback'
      WHEN rs.planned_window_start_at IS NOT NULL
       AND rs.planned_window_start_at <= v_now + INTERVAL '60 minutes' THEN 'Pick up'
      ELSE 'Open'
    END                                                                     AS cta,
    ('/mobile/pickup/' || rs.id::text)                                      AS route,
    rs.planned_window_start_at                                              AS eta_iso,
    public.fieldops_v2_priority_int(s.priority_score)                       AS priority,
    COALESCE(NULLIF(rs.metadata->>'area', ''), NULLIF(origin.district, ''), NULLIF(origin.city, '')) AS area,
    s.tracking_number                                                       AS code,
    'pickup'::text                                                          AS action,
    public.fieldops_v2_resolve_tone(
      public.fieldops_v2_classify_urgency(rs.planned_window_start_at, v_now),
      public.fieldops_v2_priority_int(s.priority_score),
      rs.planned_window_start_at,
      v_now
    )                                                                       AS tone,
    jsonb_strip_nulls(jsonb_build_object(
      'route_stop_id', rs.id,
      'stop_kind', rs.stop_kind,
      'status', pickup_projection.pickup_status,
      'route_stop_status', pickup_projection.route_stop_status,
      'pickup_status', pickup_projection.pickup_status,
      'expected_qty', pickup_projection.expected_qty,
      'picked', pickup_projection.picked_qty,
      'failure_reason', pickup_projection.failure_reason,
      'failure_note', pickup_projection.failure_note,
      'route_stop_task_id', route_task.task_id,
      'task_event_id', latest_action.task_event_id,
      'workflow_run_id', latest_action.workflow_run_id,
      'shipment_action_id', latest_action.shipment_action_id,
      'route_run_id', rr.id,
      'route_run_status', rr.status,
      'shipment_id', rs.shipment_id,
      'client_id', rs.client_id,
      'sender_id', s.sender_id,
      'sequence_order', rs.sequence_order,
      'service_level', s.service_level,
      'box_count', s.box_count,
      'shipment_status', s.status,
      'service_type', s.service_type,
      'tracking_number', s.tracking_number,
      'merchant', COALESCE(NULLIF(sender.brand_name, ''), NULLIF(sender.name, ''), NULLIF(client.name, '')),
      'address', CONCAT_WS(', ',
        NULLIF(origin.normalized_line1, ''),
        NULLIF(origin.district, ''),
        NULLIF(origin.city, '')
      ),
      'window', CONCAT_WS(' - ',
        CASE WHEN s.promised_window_start_at IS NOT NULL THEN to_char(s.promised_window_start_at, 'HH24:MI') ELSE NULL END,
        CASE WHEN s.promised_window_end_at IS NOT NULL THEN to_char(s.promised_window_end_at, 'HH24:MI') ELSE NULL END
      ),
      'instructions', NULLIF(origin.additional_directions, '')
    ))                                                                      AS meta
  FROM public.route_runs rr
  JOIN public.route_stops rs
    ON rs.route_run_id = rr.id
   AND rs.organization_id = rr.organization_id
  LEFT JOIN public.shipments s
    ON s.id = rs.shipment_id
   AND s.client_id = rs.client_id
  LEFT JOIN public.clients client
    ON client.id = rs.client_id
   AND client.organization_id = rr.organization_id
  LEFT JOIN public.senders sender
    ON sender.id = s.sender_id
   AND sender.client_id = rs.client_id
  LEFT JOIN public.addresses origin
    ON origin.id = s.origin_address_id
   AND origin.client_id = rs.client_id
  LEFT JOIN LATERAL (
    SELECT
      lower(COALESCE(NULLIF(btrim(rs.metadata->>'status'), ''), 'pending')) AS route_stop_status,
      lower(COALESCE(NULLIF(btrim(s.status), ''), 'pending')) AS shipment_status,
      GREATEST(COALESCE(s.box_count, 0), 0)::int AS expected_qty,
      NULLIF(btrim(COALESCE(
        rs.metadata #>> '{last_proof,evidence,confirmed_quantity}',
        rs.metadata #>> '{last_proof,evidence,pickup,confirmed_quantity}',
        rs.metadata #>> '{last_proof,evidence,picked}',
        ''
      )), '') AS confirmed_quantity_text,
      NULLIF(btrim(COALESCE(
        rs.metadata #>> '{last_proof,evidence,status_reason}',
        rs.metadata #>> '{last_proof,evidence,reason_code}',
        rs.metadata #>> '{last_proof,evidence,exception_reason}',
        rs.metadata #>> '{last_proof,evidence,pickup,failure_reason}',
        ''
      )), '') AS failure_reason,
      NULLIF(btrim(COALESCE(
        rs.metadata #>> '{last_proof,evidence,exception_notes}',
        rs.metadata #>> '{last_proof,evidence,pickup,failure_notes}',
        ''
      )), '') AS failure_note
  ) AS projection_seed ON TRUE
  LEFT JOIN LATERAL (
    SELECT
      projection_seed.route_stop_status,
      CASE
        WHEN projection_seed.route_stop_status IN ('failed')
          OR projection_seed.shipment_status = 'pickup_failed' THEN 'failed'
        WHEN projection_seed.route_stop_status IN ('done', 'completed')
          OR projection_seed.shipment_status IN ('in_transit', 'picked_up') THEN 'completed'
        ELSE 'pending'
      END AS pickup_status,
      projection_seed.expected_qty,
      CASE
        WHEN projection_seed.route_stop_status IN ('done', 'completed')
          OR projection_seed.shipment_status IN ('in_transit', 'picked_up') THEN projection_seed.expected_qty
        WHEN COALESCE(projection_seed.confirmed_quantity_text, '') ~ '^[0-9]+$' THEN
          LEAST(projection_seed.expected_qty, projection_seed.confirmed_quantity_text::int)
        ELSE 0
      END AS picked_qty,
      projection_seed.failure_reason,
      projection_seed.failure_note
  ) AS pickup_projection ON TRUE
  LEFT JOIN LATERAL (
    SELECT t.id::text AS task_id
      FROM public.tasks t
      JOIN public.task_types tt
        ON tt.id = t.task_type_id
       AND tt.organization_id = t.organization_id
     WHERE t.organization_id = rr.organization_id
       AND t.resource_type = 'route_stop'
       AND t.resource_id = rs.id
       AND tt.key = 'route_stop_execute'
     ORDER BY
       CASE WHEN lower(COALESCE(t.status, '')) IN ('completed', 'cancelled', 'canceled') THEN 1 ELSE 0 END,
       t.created_at DESC,
       t.id DESC
     LIMIT 1
  ) AS route_task ON TRUE
  LEFT JOIN LATERAL (
    SELECT
      sa.id::text AS shipment_action_id,
      NULLIF(sa.action_data->>'task_event_id', '') AS task_event_id,
      NULLIF(sa.action_data->>'workflow_run_id', '') AS workflow_run_id
      FROM public.shipment_actions sa
     WHERE sa.organization_id = rr.organization_id
       AND sa.shipment_id = rs.shipment_id
       AND sa.action_data->>'route_stop_id' = rs.id::text
     ORDER BY sa.timestamp DESC, sa.created_at DESC, sa.id DESC
     LIMIT 1
  ) AS latest_action ON TRUE
  WHERE rr.organization_id = v_caller_org
    AND rs.stop_kind = 'pickup'
    AND (
      lower(COALESCE(rr.status, '')) NOT IN ('completed', 'cancelled', 'canceled', 'closed')
      OR (
        lower(COALESCE(rr.status, '')) = 'completed'
        AND pickup_projection.pickup_status IN ('completed', 'failed')
        AND COALESCE(rr.updated_at, rr.ended_at, rr.created_at) >= v_now - INTERVAL '12 hours'
      )
    )
    AND (
      v_active_role NOT IN ('driver', 'rider')
      OR rr.driver_user_id = v_user_id
    )
  ORDER BY
    CASE
      WHEN pickup_projection.pickup_status = 'pending'
       AND public.fieldops_v2_classify_urgency(rs.planned_window_start_at, v_now) = 'now' THEN 0
      WHEN pickup_projection.pickup_status = 'pending'
       AND public.fieldops_v2_classify_urgency(rs.planned_window_start_at, v_now) = 'today' THEN 1
      ELSE 2
    END,
    public.fieldops_v2_priority_int(s.priority_score) DESC,
    rs.planned_window_start_at NULLS LAST,
    rs.sequence_order;
END;
$$;

CREATE OR REPLACE FUNCTION public.resolve_fieldops_trips_v1(
  p_active_role TEXT DEFAULT 'driver',
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org UUID;
  v_role TEXT;
  v_rows JSONB := '[]'::jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'resolve_fieldops_trips_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;
  v_org := public.current_user_org_id();
  IF v_org IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;

  v_role := public.fieldops_route_read_role_v1(p_active_role, v_org, 'routes');

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id',              rr.id::text,
        'code',            'TRIP-' || substr(rr.id::text, 1, 8),
        'leg',             COALESCE(rr.metadata->>'leg', 'Hub → Hub'),
        'driver',          CASE WHEN rr.driver_user_id = v_user_id THEN 'You'
                                ELSE COALESCE(rr.metadata->>'driver_name', '—') END,
        'vehicle',         COALESCE(rr.metadata->>'vehicle', '—'),
        -- 2nd-pass audit fix: prefer explicit metadata.stage when present
        -- (already in FE allow-list); else map rr.status (run-status
        -- vocabulary) into the FE trip-stage allow-list. Unknown values
        -- safely fall to "assigned".
        'stage',           CASE
                             WHEN rr.metadata->>'stage' IN (
                               'assigned', 'gate-in', 'loading', 'sealed',
                               'in-transit', 'arrived', 'gate-out', 'reconciled'
                             ) THEN rr.metadata->>'stage'
                             WHEN rr.status = 'pending'      THEN 'assigned'
                             WHEN rr.status = 'in_progress'  THEN 'in-transit'
                             WHEN rr.status = 'completed'    THEN 'reconciled'
                             WHEN rr.status = 'closed'       THEN 'reconciled'
                             WHEN rr.status = 'cancelled'    THEN 'reconciled'
                             ELSE 'assigned'
                           END,
        'origin',          jsonb_build_object(
          'id',   COALESCE(rr.metadata->>'origin_hub_id', 'HUB-ORG'),
          'name', COALESCE(rr.metadata->>'origin_hub_name', 'Origin hub')
        ),
        'dest',            jsonb_build_object(
          'id',   COALESCE(rr.metadata->>'dest_hub_id', 'HUB-ORG'),
          'name', COALESCE(rr.metadata->>'dest_hub_name', 'Dest hub')
        ),
        'plannedDepart',   COALESCE(rr.metadata->>'planned_depart', ''),
        'plannedArrive',   COALESCE(rr.metadata->>'planned_arrive', ''),
        'etaMin',          COALESCE((rr.metadata->>'eta_min')::numeric, 0)::int,
        'distance',        COALESCE((rr.metadata->>'distance_km')::numeric, 0)::int,
        'totalParcels',    COALESCE((rr.metadata->>'total_parcels')::numeric, 0)::int,
        'scanned',         COALESCE((rr.metadata->>'scanned_parcels')::numeric, 0)::int,
        'sealNo',          rr.metadata->>'seal_no',
        'manifest',        COALESCE(rr.metadata->'manifest', '[]'::jsonb)
      )
      ORDER BY rr.created_at DESC
    ),
    '[]'::jsonb
  )
  INTO v_rows
  FROM public.route_runs rr
  WHERE rr.organization_id = v_org
    AND (v_role NOT IN ('driver', 'rider') OR rr.driver_user_id = v_user_id)
    AND COALESCE(rr.metadata->>'kind', 'route') = ANY (ARRAY['route', 'trip', 'linehaul', 'transfer']);

  RETURN v_rows;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.resolve_fieldops_stop_detail_base_v1(UUID, TEXT, JSONB)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.resolve_fieldops_stop_detail_contact_base_v1(UUID, TEXT, JSONB)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.resolve_fieldops_stop_detail_cod_collection_base_v1(UUID, TEXT, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_fieldops_stop_detail_base_v1(UUID, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.resolve_fieldops_stop_detail_contact_base_v1(UUID, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.resolve_fieldops_stop_detail_cod_collection_base_v1(UUID, TEXT, JSONB) TO service_role;

REVOKE EXECUTE ON FUNCTION public.resolve_fieldops_tasks_v1(TEXT, JSONB) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.resolve_fieldops_pickups_v1(TEXT, JSONB) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.resolve_fieldops_trips_v1(TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_fieldops_tasks_v1(TEXT, JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resolve_fieldops_pickups_v1(TEXT, JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resolve_fieldops_trips_v1(TEXT, JSONB) TO authenticated, service_role;

COMMIT;
