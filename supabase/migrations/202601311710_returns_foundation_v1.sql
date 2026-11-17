-- Plan: PLAN-202601-last-mile-enterprise-readiness-v2 / Step: S04
-- Migration: Returns foundation v1 (reverse logistics SSOT: returns projection + return_events ledger)
-- Date: 2026-01-31
--
-- Goals:
--   - Introduce first-class returns for enterprise reverse logistics (RTO, swap returns, pickup returns).
--   - Keep operational behavior task/workflow-driven; this module is schema-only (projection + ledger + RLS).
--   - Enforce strict multi-tenant isolation with RLS and org-consistency triggers.
--   - Use dynamic lookup enforcement (lookup_column_contracts), no literal enum lists.
BEGIN;
SELECT pg_advisory_lock(hashtext('202601311710_returns_foundation_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Lookups (row-driven enums; SSOT)
-------------------------------------------------------------------------------

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES ('return_type', 'Return types (reverse logistics)', 'operations', 'tier_1', TRUE)
ON CONFLICT (category) DO NOTHING;

INSERT INTO public.lookup_values (lookup_definition_id, value, label, description, sort_order, is_default, metadata)
SELECT
  ld.id,
  v.value,
  v.label,
  v.description,
  v.sort_order,
  v.is_default,
  v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('rto',           'RTO',           'Return-to-origin (undelivered)', 10, TRUE,  '{}' ),
  ('pickup_return', 'Pickup Return', 'Customer-initiated return pickup', 20, FALSE, '{}' ),
  ('swap_return',   'Swap Return',   'Swap return leg (old item back)', 30, FALSE, '{}' )
) AS v(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'return_type'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES ('return_status', 'Return lifecycle status (projection)', 'operations', 'tier_1', TRUE)
ON CONFLICT (category) DO NOTHING;

INSERT INTO public.lookup_values (lookup_definition_id, value, label, description, sort_order, is_default, metadata)
SELECT
  ld.id,
  v.value,
  v.label,
  v.description,
  v.sort_order,
  v.is_default,
  v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('requested',  'Requested',  'Return requested / initiated', 10, TRUE,  '{}' ),
  ('authorized', 'Authorized', 'Return authorized/approved', 20, FALSE, '{}' ),
  ('in_transit', 'In Transit', 'Return is moving back to branch/warehouse', 30, FALSE, '{}' ),
  ('received',   'Received',   'Return received at branch/warehouse', 40, FALSE, '{}' ),
  ('closed',     'Closed',     'Return completed/closed', 90, FALSE, '{"is_final": true}' ),
  ('canceled',   'Canceled',   'Return canceled/voided', 95, FALSE, '{"is_final": true}' )
) AS v(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'return_status'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES ('return_qc_status', 'Return QC status', 'operations', 'tier_1', TRUE)
ON CONFLICT (category) DO NOTHING;

INSERT INTO public.lookup_values (lookup_definition_id, value, label, description, sort_order, is_default, metadata)
SELECT
  ld.id,
  v.value,
  v.label,
  v.description,
  v.sort_order,
  v.is_default,
  v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('pending', 'Pending', 'QC pending', 10, TRUE,  '{}' ),
  ('passed',  'Passed',  'QC passed', 20, FALSE, '{}' ),
  ('failed',  'Failed',  'QC failed', 30, FALSE, '{}' )
) AS v(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'return_qc_status'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES ('return_disposition', 'Return disposition / outcome (restock, scrap, etc.)', 'operations', 'tier_1', TRUE)
ON CONFLICT (category) DO NOTHING;

INSERT INTO public.lookup_values (lookup_definition_id, value, label, description, sort_order, is_default, metadata)
SELECT
  ld.id,
  v.value,
  v.label,
  v.description,
  v.sort_order,
  v.is_default,
  v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('restock',          'Restock',          'Return accepted and restocked', 10, TRUE,  '{}' ),
  ('return_to_sender', 'Return To Sender', 'Return shipped back to sender', 20, FALSE, '{}' ),
  ('scrap',            'Scrap',            'Return scrapped/discarded', 30, FALSE, '{}' )
) AS v(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'return_disposition'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

-------------------------------------------------------------------------------
-- 2) Returns projection + ledger
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.returns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  sender_id UUID REFERENCES public.senders(id) ON DELETE SET NULL,

  -- Shipments are HASH partitioned by client_id; store client_id alongside shipment_id for deterministic joins.
  shipment_id UUID NOT NULL,

  return_type TEXT NOT NULL, -- lookup return_type
  status TEXT NOT NULL DEFAULT 'requested', -- lookup return_status
  status_reason TEXT,

  branch_id UUID REFERENCES public.branches(id) ON DELETE SET NULL,

  requested_at TIMESTAMPTZ NULL,
  authorized_at TIMESTAMPTZ NULL,
  received_at TIMESTAMPTZ NULL,

  qc_status TEXT NULL, -- lookup return_qc_status
  qc_completed_at TIMESTAMPTZ NULL,
  disposition TEXT NULL, -- lookup return_disposition

  created_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,

  idempotency_key TEXT NULL,
  version INT NOT NULL DEFAULT 1,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT returns_return_type_ck CHECK (btrim(return_type) <> '' AND return_type = lower(return_type)),
  CONSTRAINT returns_status_ck CHECK (btrim(status) <> '' AND status = lower(status)),
  CONSTRAINT returns_qc_status_ck CHECK (qc_status IS NULL OR (btrim(qc_status) <> '' AND qc_status = lower(qc_status))),
  CONSTRAINT returns_disposition_ck CHECK (disposition IS NULL OR (btrim(disposition) <> '' AND disposition = lower(disposition))),
  CONSTRAINT returns_version_ck CHECK (version > 0),
  CONSTRAINT returns_shipment_fk
    FOREIGN KEY (shipment_id, client_id) REFERENCES public.shipments(id, client_id) ON DELETE CASCADE
);

COMMENT ON TABLE public.returns
  IS 'Returns projection (query-optimized) for reverse logistics. Immutable audit trail is return_events.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_returns_org_idempotency
  ON public.returns (organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND btrim(idempotency_key) <> '';

CREATE INDEX IF NOT EXISTS idx_returns_org_status
  ON public.returns (organization_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_returns_client_status
  ON public.returns (client_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_returns_sender_status
  ON public.returns (sender_id, status, created_at DESC)
  WHERE sender_id IS NOT NULL;

-- FK supporting indexes (enterprise hygiene; non-partial).
CREATE INDEX IF NOT EXISTS idx_returns__shipment_id_client_id__fk
  ON public.returns (shipment_id, client_id);

CREATE INDEX IF NOT EXISTS idx_returns__sender_id__fk
  ON public.returns (sender_id);

CREATE INDEX IF NOT EXISTS idx_returns__branch_id__fk
  ON public.returns (branch_id);

CREATE INDEX IF NOT EXISTS idx_returns__created_by_user_id__fk
  ON public.returns (created_by_user_id);

CREATE OR REPLACE FUNCTION public.returns_enforce_org_match_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_client_org UUID;
  v_sender_org UUID;
  v_ship_org UUID;
  v_branch_org UUID;
  v_user_org UUID;
BEGIN
  IF NEW.organization_id IS NULL THEN
    RAISE EXCEPTION 'returns: organization_id is required' USING ERRCODE = '23502';
  END IF;

  SELECT c.organization_id
    INTO v_client_org
    FROM public.clients c
   WHERE c.id = NEW.client_id;

  IF v_client_org IS NULL THEN
    RAISE EXCEPTION 'returns: client % not found', NEW.client_id USING ERRCODE = '23503';
  END IF;

  IF v_client_org IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'returns: organization mismatch (return org %, client org %)', NEW.organization_id, v_client_org
      USING ERRCODE = '23514';
  END IF;

  IF NEW.sender_id IS NOT NULL THEN
    SELECT c.organization_id
      INTO v_sender_org
      FROM public.senders s
      JOIN public.clients c ON c.id = s.client_id
     WHERE s.id = NEW.sender_id;

    IF v_sender_org IS NULL THEN
      RAISE EXCEPTION 'returns: sender % not found', NEW.sender_id USING ERRCODE = '23503';
    END IF;

    IF v_sender_org IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'returns: organization mismatch (return org %, sender org %)', NEW.organization_id, v_sender_org
        USING ERRCODE = '23514';
    END IF;
  END IF;

  SELECT s.organization_id
    INTO v_ship_org
    FROM public.shipments s
   WHERE s.id = NEW.shipment_id
     AND s.client_id = NEW.client_id
   LIMIT 1;

  IF v_ship_org IS NULL THEN
    RAISE EXCEPTION 'returns: shipment % not found for client %', NEW.shipment_id, NEW.client_id
      USING ERRCODE = '23503';
  END IF;

  IF v_ship_org IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'returns: organization mismatch (return org %, shipment org %)', NEW.organization_id, v_ship_org
      USING ERRCODE = '23514';
  END IF;

  IF NEW.branch_id IS NOT NULL THEN
    SELECT b.organization_id
      INTO v_branch_org
      FROM public.branches b
     WHERE b.id = NEW.branch_id;

    IF v_branch_org IS NULL THEN
      RAISE EXCEPTION 'returns: branch % not found', NEW.branch_id USING ERRCODE = '23503';
    END IF;

    IF v_branch_org IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'returns: organization mismatch (return org %, branch org %)', NEW.organization_id, v_branch_org
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.created_by_user_id IS NOT NULL THEN
    SELECT u.organization_id
      INTO v_user_org
      FROM public.users u
     WHERE u.id = NEW.created_by_user_id;

    IF v_user_org IS NULL THEN
      RAISE EXCEPTION 'returns: user % not found', NEW.created_by_user_id USING ERRCODE = '23503';
    END IF;

    IF v_user_org IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'returns: organization mismatch (return org %, user org %)', NEW.organization_id, v_user_org
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_returns_enforce_org_match ON public.returns;
CREATE TRIGGER trg_returns_enforce_org_match
  BEFORE INSERT OR UPDATE ON public.returns
  FOR EACH ROW
  EXECUTE FUNCTION public.returns_enforce_org_match_v1();

DROP TRIGGER IF EXISTS trg_returns_set_updated_at ON public.returns;
CREATE TRIGGER trg_returns_set_updated_at
  BEFORE UPDATE ON public.returns
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.return_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id UUID NOT NULL REFERENCES public.returns(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  event_type TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,

  actor_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  actor_system TEXT,

  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key TEXT,
  return_version INT NOT NULL,

  decision_log_id UUID,
  settings_resolution_id UUID,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT return_events_event_type_ck CHECK (btrim(event_type) <> '' AND event_type = lower(event_type)),
  CONSTRAINT return_events_return_version_ck CHECK (return_version > 0)
);

COMMENT ON TABLE public.return_events
  IS 'Immutable return event ledger (SSOT). Event trail is authoritative; returns is the projection.';

CREATE INDEX IF NOT EXISTS idx_return_events_return_created
  ON public.return_events (return_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_return_events_return_version
  ON public.return_events (return_id, return_version);

CREATE INDEX IF NOT EXISTS idx_return_events_org_created
  ON public.return_events (organization_id, created_at DESC);

-- FK supporting indexes (enterprise hygiene; non-partial).
CREATE INDEX IF NOT EXISTS idx_return_events__actor_user_id__fk
  ON public.return_events (actor_user_id);

-------------------------------------------------------------------------------
-- 3) RLS + grants
-------------------------------------------------------------------------------

ALTER TABLE public.returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.return_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.returns FROM PUBLIC;
REVOKE ALL ON TABLE public.returns FROM anon;
REVOKE ALL ON TABLE public.returns FROM authenticated;

REVOKE ALL ON TABLE public.return_events FROM PUBLIC;
REVOKE ALL ON TABLE public.return_events FROM anon;
REVOKE ALL ON TABLE public.return_events FROM authenticated;

DROP POLICY IF EXISTS returns_select ON public.returns;
CREATE POLICY returns_select ON public.returns
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
    )
    OR (
      public.current_user_scope_type() = 'client'
      AND client_id = public.current_user_client_id()
    )
    OR (
      public.current_user_scope_type() = 'sender'
      AND sender_id = public.current_user_sender_id()
    )
  );

DROP POLICY IF EXISTS returns_service_policy ON public.returns;
CREATE POLICY returns_service_policy ON public.returns
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS return_events_select ON public.return_events;
CREATE POLICY return_events_select ON public.return_events
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
    )
    OR (
      public.current_user_scope_type() = 'client'
      AND EXISTS (
        SELECT 1
        FROM public.returns r
        WHERE r.id = return_events.return_id
          AND r.client_id = public.current_user_client_id()
      )
    )
    OR (
      public.current_user_scope_type() = 'sender'
      AND EXISTS (
        SELECT 1
        FROM public.returns r
        WHERE r.id = return_events.return_id
          AND r.sender_id = public.current_user_sender_id()
      )
    )
  );

DROP POLICY IF EXISTS return_events_service_policy ON public.return_events;
CREATE POLICY return_events_service_policy ON public.return_events
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

GRANT SELECT ON public.returns TO authenticated;
GRANT SELECT ON public.return_events TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.returns TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.return_events TO service_role;

-------------------------------------------------------------------------------
-- 4) Contracts: table_contracts + lookup_column_contracts
-------------------------------------------------------------------------------

INSERT INTO public.table_contracts (table_schema, table_name, created_at_required, updated_at_required, audit_enabled, notes)
VALUES
  ('public', 'returns', TRUE, TRUE, TRUE, 'Reverse logistics projection (RTO/swap returns).'),
  ('public', 'return_events', TRUE, FALSE, FALSE, 'Return event ledger (SSOT).')
ON CONFLICT (table_schema, table_name) DO UPDATE
SET
  created_at_required = EXCLUDED.created_at_required,
  updated_at_required = EXCLUDED.updated_at_required,
  audit_enabled = EXCLUDED.audit_enabled,
  notes = EXCLUDED.notes,
  updated_at = now();

INSERT INTO public.lookup_column_contracts (table_schema, table_name, column_name, lookup_category)
VALUES
  ('public', 'returns', 'return_type', 'return_type'),
  ('public', 'returns', 'status', 'return_status'),
  ('public', 'returns', 'qc_status', 'return_qc_status'),
  ('public', 'returns', 'disposition', 'return_disposition')
ON CONFLICT (table_schema, table_name, column_name) DO UPDATE
SET lookup_category = EXCLUDED.lookup_category;

SELECT public.apply_lookup_column_contracts('public');

SELECT pg_advisory_unlock(hashtext('202601311710_returns_foundation_v1'));
COMMIT;

