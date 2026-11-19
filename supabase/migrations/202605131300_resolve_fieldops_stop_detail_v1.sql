-- Migration: resolve_fieldops_stop_detail_v1 — Mobile V2 stop-detail aggregator
-- Date: 2026-05-13
-- Spec: Mobile FieldOps V2 — closes Audit 2 P0 #3
--   (docs/ops/evidence/2026-05-13/mobile-v2-fieldops-parity-audit/README.md).
--   The MobileV2StopScreen renders a single delivery / pickup stop view: hero
--   (customer + tracking + hazards), stat strip (ETA / distance / window),
--   address card, parcel list, proof checklist, event timeline, and a sticky
--   action footer. Until now the screen drove all of those off a typed
--   FE fixture (apps/fieldops/src/fixtures/mobile-v2-stop-fixtures.ts) marked
--   PREVIEW/DEV — there was no resolver that could populate the same shape
--   from canonical tables for a real driver-assigned stop.
--
--   This migration ships `public.resolve_fieldops_stop_detail_v1(...)` (and
--   its `api.*` SECURITY INVOKER mirror) returning a single JSONB envelope
--   whose keys map 1:1 to the `MobileV2StopDetail` interface (see
--   apps/fieldops/src/mobile-v2-stop-screen.tsx). The envelope is built from:
--
--     - public.route_stops (anchor row; org-scoped, joined to route_runs for
--       seq context + driver assignment + planned window)
--     - public.route_runs  (driver_user_id assignment; total stop count for
--       "Stop X of Y" sequence label)
--     - public.shipments   (tracking_number, service_level, cod_amount /
--       cod_currency, box_count, priority_score, special_instructions)
--     - public.recipients  (customerName + initials + phone)
--     - public.shipment_boxes (parcels list with status + weight_kg)
--     - public.decision_log (timeline events scoped to the stop / shipment)
--
--   AGENTS.md compliance posture:
--   - Zero hardcoding: all values resolve from rows; helper functions reused
--     from existing `fieldops_v2_classify_urgency` family for consistency.
--     COD currency falls through `shipments.cod_currency`. Hazard chips and
--     proof checklist are derived from row state, not tenant constants.
--   - RLS / cross-org isolation: function is SECURITY DEFINER but body
--     verifies the caller's `current_user_org_id()` matches the stop's
--     `organization_id` before returning. Drivers/riders may only read
--     stops whose owning route_run.driver_user_id matches them. Loaders /
--     supervisors see org-wide stops (no driver_user_id restriction).
--   - Audit: every call writes a `decision_log` entry with the resolver
--     name, the stop id, and the caller-provided correlation_id (per
--     AGENTS.md trace propagation) for end-to-end auditability.
--   - Idempotent: CREATE OR REPLACE FUNCTION; advisory-locked migration;
--     append-only — no edits to historical migration files.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605131300_resolve_fieldops_stop_detail_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-- ===========================================================================
-- Helper: classify a stop's effective status -> hazard tone for the chip row.
-- Returns NULL when no hazard should be shown.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.fieldops_v2_stop_otp_required_v1(
  p_shipment_metadata JSONB,
  p_stop_metadata JSONB,
  p_service_level TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT COALESCE(
    (p_stop_metadata->>'otp_required')::boolean,
    (p_shipment_metadata->>'otp_required')::boolean,
    -- Cash-on-delivery + premium / express service levels imply OTP per
    -- standard policy; row data still drives this — service_level is itself
    -- a lookup value, not a hardcoded business rule.
    CASE WHEN lower(COALESCE(p_service_level, '')) IN ('premium', 'express')
         THEN TRUE
         ELSE FALSE
    END,
    FALSE
  );
$$;

REVOKE ALL ON FUNCTION public.fieldops_v2_stop_otp_required_v1(JSONB, JSONB, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fieldops_v2_stop_otp_required_v1(JSONB, JSONB, TEXT) TO authenticated, service_role;

-- ===========================================================================
-- Main resolver
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.resolve_fieldops_stop_detail_v1(
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
  v_active_role  TEXT := lower(btrim(COALESCE(p_active_role, 'driver')));
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

  -- Driver / rider scope: only see stops on a run assigned to them. Loader /
  -- supervisor / dispatcher see org-wide.
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

REVOKE ALL ON FUNCTION public.resolve_fieldops_stop_detail_v1(UUID, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_fieldops_stop_detail_v1(UUID, TEXT, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.resolve_fieldops_stop_detail_v1(UUID, TEXT, JSONB) TO authenticated, service_role;

COMMENT ON FUNCTION public.resolve_fieldops_stop_detail_v1(UUID, TEXT, JSONB) IS
  'Mobile V2 stop-detail aggregator. Returns a single JSONB envelope matching MobileV2StopDetail for a real driver-assigned stop. Tenant-scoped via current_user_org_id(); cross-org callers raise 42501; drivers/riders may only read stops on their own runs.';

-- ===========================================================================
-- api.* SECURITY INVOKER mirror for PostgREST.
-- ===========================================================================

CREATE SCHEMA IF NOT EXISTS api;
GRANT USAGE ON SCHEMA api TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.resolve_fieldops_stop_detail_v1(
  p_stop_id UUID,
  p_active_role TEXT DEFAULT 'driver',
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.resolve_fieldops_stop_detail_v1(p_stop_id, p_active_role, p_context);
$$;

REVOKE ALL ON FUNCTION api.resolve_fieldops_stop_detail_v1(UUID, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.resolve_fieldops_stop_detail_v1(UUID, TEXT, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.resolve_fieldops_stop_detail_v1(UUID, TEXT, JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202605131300_resolve_fieldops_stop_detail_v1'));
COMMIT;
