-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S04
-- Migration: COD settlements + reconciliation foundation (settlement SSOT + core RPCs)
-- Date: 2026-01-21

-- Goals:
--   - Introduce settlement SSOT primitives: settlement_batches (projection), settlement_events (ledger),
--     settlement_batch_finance_events (membership to finance_events).
--   - Keep behavior row-driven: statuses/kinds/scopes are lookups; settlement behavior is policy-driven
--     via settlement_policy / cod_policy resolved through the canonical ladder resolver.
--   - Enforce strict least-privilege: RLS everywhere; service-only write RPCs; tenant-scope reads only.

BEGIN;
SELECT pg_advisory_lock(hashtext('202601212860_settlement_ssot'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Lookup seeds (row-driven settlement enums; SSOT)
-------------------------------------------------------------------------------

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES ('settlement_kind', 'Settlement batch kinds (COD, billing, payouts, etc.)', 'finance', 'tier_1', FALSE)
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
  ('cod', 'COD', 'Cash-on-delivery settlements and reconciliation', 10, TRUE, '{}' ),
  ('billing', 'Billing', 'Client billing settlements (follow-up plan)', 20, FALSE, '{}' ),
  ('payout', 'Payout', 'Payout settlements (follow-up plan)', 30, FALSE, '{}' )
) AS v(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'settlement_kind'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES ('settlement_status', 'Settlement batch statuses for settlement_batches projection', 'finance', 'tier_1', FALSE)
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
  ('open', 'Open', 'Batch is collecting events; membership can change', 10, TRUE,  '{"attachments_allowed": true,  "is_final": false}' ),
  ('locked', 'Locked', 'Batch membership locked; requires approval to proceed', 20, FALSE, '{"attachments_allowed": false, "is_final": false}' ),
  ('approved', 'Approved', 'Approved by manager/accounting; ready to post/export', 30, FALSE, '{"attachments_allowed": false, "is_final": false}' ),
  ('posted', 'Posted', 'Posted/exported to accounting system', 40, FALSE, '{"attachments_allowed": false, "is_final": true}' ),
  ('canceled', 'Canceled', 'Canceled/voided; no further changes allowed', 90, FALSE, '{"attachments_allowed": false, "is_final": true}' )
) AS v(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'settlement_status'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES ('settlement_scope_type', 'Settlement batch scope types (driver_shift, branch_day, client_cycle, etc.)', 'finance', 'tier_1', FALSE)
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
  ('driver_shift', 'Driver Shift', 'Per-driver shift cash/settlement window', 10, FALSE, '{}' ),
  ('branch_day', 'Branch Day', 'Per-branch daily cash/settlement window', 20, FALSE, '{}' ),
  ('client_cycle', 'Client Cycle', 'Per-client settlement cycle window', 30, FALSE, '{}' ),
  ('accounting_period', 'Accounting Period', 'Accounting period settlement window', 40, FALSE, '{}' )
) AS v(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'settlement_scope_type'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

-------------------------------------------------------------------------------
-- 2) Settlement SSOT tables
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.settlement_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  kind TEXT NOT NULL,       -- lookup category settlement_kind
  scope_type TEXT NOT NULL, -- lookup category settlement_scope_type

  -- Policy resource scope for settlement/cod policies (branches/warehouses).
  branch_id UUID REFERENCES public.branches(id) ON DELETE SET NULL,

  -- Optional commercial scope anchors (not used for RLS yet).
  client_id UUID REFERENCES public.clients(id) ON DELETE SET NULL,
  sender_id UUID REFERENCES public.senders(id) ON DELETE SET NULL,

  -- The primary entity being settled (e.g., driver user id, branch id, client id).
  subject_type TEXT,
  subject_id UUID,

  window_start_at TIMESTAMPTZ,
  window_end_at TIMESTAMPTZ,

  status TEXT NOT NULL, -- lookup category settlement_status
  status_reason TEXT,

  idempotency_key TEXT,
  version INT NOT NULL DEFAULT 1,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT settlement_batches_kind_ck CHECK (btrim(kind) <> '' AND kind = lower(kind)),
  CONSTRAINT settlement_batches_scope_type_ck CHECK (btrim(scope_type) <> '' AND scope_type = lower(scope_type)),
  CONSTRAINT settlement_batches_status_ck CHECK (btrim(status) <> '' AND status = lower(status)),
  CONSTRAINT settlement_batches_version_ck CHECK (version > 0),
  CONSTRAINT settlement_batches_window_ck CHECK (
    window_start_at IS NULL OR window_end_at IS NULL OR window_start_at <= window_end_at
  )
);

COMMENT ON TABLE public.settlement_batches
  IS 'Settlement current-state projection (query-optimized). Updates occur only via canonical RPCs; ledger is settlement_events.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_settlement_batches_org_idempotency
  ON public.settlement_batches (organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND btrim(idempotency_key) <> '';

-- Support composite FKs that enforce organization_id matches across membership/ledger joins.
CREATE UNIQUE INDEX IF NOT EXISTS idx_settlement_batches_id_org
  ON public.settlement_batches (id, organization_id);

CREATE INDEX IF NOT EXISTS idx_settlement_batches_org_status
  ON public.settlement_batches (organization_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_settlement_batches_org_scope
  ON public.settlement_batches (organization_id, kind, scope_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_settlement_batches_subject
  ON public.settlement_batches (subject_type, subject_id)
  WHERE subject_type IS NOT NULL AND subject_id IS NOT NULL;

ALTER TABLE public.settlement_batches ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.settlement_batches FROM PUBLIC;
REVOKE ALL ON TABLE public.settlement_batches FROM anon;
REVOKE ALL ON TABLE public.settlement_batches FROM authenticated;

DROP POLICY IF EXISTS settlement_batches_select ON public.settlement_batches;
CREATE POLICY settlement_batches_select ON public.settlement_batches
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
    )
  );

DROP POLICY IF EXISTS settlement_batches_service_policy ON public.settlement_batches;
CREATE POLICY settlement_batches_service_policy ON public.settlement_batches
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

GRANT SELECT ON public.settlement_batches TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.settlement_batches TO service_role;

DROP TRIGGER IF EXISTS trg_settlement_batches_set_updated_at ON public.settlement_batches;
CREATE TRIGGER trg_settlement_batches_set_updated_at
  BEFORE UPDATE ON public.settlement_batches
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.settlement_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  settlement_batch_id UUID NOT NULL REFERENCES public.settlement_batches(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  event_type TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,

  actor_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  actor_system TEXT,

  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key TEXT,
  batch_version INT NOT NULL,

  decision_log_id UUID,
  settings_resolution_id UUID,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT settlement_events_event_type_ck CHECK (btrim(event_type) <> '' AND event_type = lower(event_type)),
  CONSTRAINT settlement_events_batch_version_ck CHECK (batch_version > 0)
);

COMMENT ON TABLE public.settlement_events
  IS 'Immutable settlement event ledger (SSOT). Event trail is authoritative; settlement_batches is the projection.';

CREATE INDEX IF NOT EXISTS idx_settlement_events_batch_created
  ON public.settlement_events (settlement_batch_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_settlement_events_batch_version
  ON public.settlement_events (settlement_batch_id, batch_version);

CREATE UNIQUE INDEX IF NOT EXISTS idx_settlement_events_idempotency
  ON public.settlement_events (settlement_batch_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND btrim(idempotency_key) <> '';

CREATE INDEX IF NOT EXISTS idx_settlement_events_org_created
  ON public.settlement_events (organization_id, created_at DESC);

ALTER TABLE public.settlement_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.settlement_events FROM PUBLIC;
REVOKE ALL ON TABLE public.settlement_events FROM anon;
REVOKE ALL ON TABLE public.settlement_events FROM authenticated;

DROP POLICY IF EXISTS settlement_events_select ON public.settlement_events;
CREATE POLICY settlement_events_select ON public.settlement_events
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
    )
  );

DROP POLICY IF EXISTS settlement_events_service_policy ON public.settlement_events;
CREATE POLICY settlement_events_service_policy ON public.settlement_events
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

GRANT SELECT ON public.settlement_events TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.settlement_events TO service_role;

CREATE TABLE IF NOT EXISTS public.settlement_batch_finance_events (
  settlement_batch_id UUID NOT NULL,
  organization_id UUID NOT NULL,

  finance_event_id UUID NOT NULL,
  finance_occurred_at TIMESTAMPTZ NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (settlement_batch_id, finance_event_id, finance_occurred_at),

  CONSTRAINT settlement_batch_finance_events_batch_fk
    FOREIGN KEY (settlement_batch_id, organization_id)
    REFERENCES public.settlement_batches(id, organization_id)
    ON DELETE CASCADE,

  CONSTRAINT settlement_batch_finance_events_finance_fk
    FOREIGN KEY (finance_event_id, organization_id, finance_occurred_at)
    REFERENCES public.finance_events(id, organization_id, occurred_at)
    ON DELETE RESTRICT
);

COMMENT ON TABLE public.settlement_batch_finance_events
  IS 'Membership table linking settlement batches to finance_events (explicit inclusion list; totals derived via joins).';

CREATE INDEX IF NOT EXISTS idx_settlement_batch_finance_events_org_event
  ON public.settlement_batch_finance_events (organization_id, finance_event_id, finance_occurred_at);

ALTER TABLE public.settlement_batch_finance_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.settlement_batch_finance_events FROM PUBLIC;
REVOKE ALL ON TABLE public.settlement_batch_finance_events FROM anon;
REVOKE ALL ON TABLE public.settlement_batch_finance_events FROM authenticated;

DROP POLICY IF EXISTS settlement_batch_finance_events_select ON public.settlement_batch_finance_events;
CREATE POLICY settlement_batch_finance_events_select ON public.settlement_batch_finance_events
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
    )
  );

DROP POLICY IF EXISTS settlement_batch_finance_events_service_policy ON public.settlement_batch_finance_events;
CREATE POLICY settlement_batch_finance_events_service_policy ON public.settlement_batch_finance_events
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

GRANT SELECT ON public.settlement_batch_finance_events TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.settlement_batch_finance_events TO service_role;

-------------------------------------------------------------------------------
-- 3) Table contracts (timestamp + audit contract; SSOT)
-------------------------------------------------------------------------------

INSERT INTO public.table_contracts (table_schema, table_name, created_at_required, updated_at_required, audit_enabled, notes)
VALUES
  ('public', 'settlement_batches', TRUE, TRUE, TRUE, 'Settlement current-state projection; updated via canonical RPCs.'),
  ('public', 'settlement_events', TRUE, FALSE, FALSE, 'Settlement SSOT event ledger (immutable); audit disabled by contract.'),
  ('public', 'settlement_batch_finance_events', TRUE, FALSE, FALSE, 'Settlement membership to finance ledger (immutable); audit disabled by contract.')
ON CONFLICT (table_schema, table_name) DO UPDATE
SET
  created_at_required = EXCLUDED.created_at_required,
  updated_at_required = EXCLUDED.updated_at_required,
  audit_enabled = EXCLUDED.audit_enabled,
  notes = EXCLUDED.notes,
  updated_at = now();

-------------------------------------------------------------------------------
-- 4) Canonical RPCs (service-only; idempotent)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_settlement_batch_v1(
  p_batch JSONB
)
RETURNS TABLE (
  settlement_batch_id UUID,
  settlement_event_id UUID,
  created BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_input JSONB := COALESCE(p_batch, '{}'::jsonb);
  v_now TIMESTAMPTZ := now();

  v_org_id UUID;
  v_branch_id UUID := NULL;
  v_client_id UUID := NULL;
  v_sender_id UUID := NULL;
  v_webhook_source_id UUID := NULL;

  v_kind TEXT := NULL;
  v_scope_type TEXT := NULL;
  v_subject_type TEXT := NULL;
  v_subject_id UUID := NULL;
  v_window_start TIMESTAMPTZ := NULL;
  v_window_end TIMESTAMPTZ := NULL;

  v_actor_user_id UUID := NULL;
  v_actor_system TEXT := NULLIF(btrim(COALESCE(v_input->>'actor_system', '')), '');

  v_idempotency TEXT := NULLIF(btrim(COALESCE(v_input->>'idempotency_key', '')), '');
  v_metadata JSONB := COALESCE(v_input->'metadata', '{}'::jsonb);

  v_policy_ctx JSONB;
  v_settlement_policy_row RECORD;
  v_cod_policy_row RECORD;
  v_has_settlement_policy BOOLEAN := FALSE;
  v_has_cod_policy BOOLEAN := FALSE;
  v_settlement_policy JSONB := '{}'::jsonb;
  v_cod_policy JSONB := '{}'::jsonb;

  v_settlement_policy_resolution_id UUID := NULL;
  v_cod_policy_resolution_id UUID := NULL;

  v_status TEXT := NULL;
  v_decision_id UUID := NULL;
BEGIN
  IF jsonb_typeof(v_input) <> 'object' THEN
    RAISE EXCEPTION 'create_settlement_batch_v1 expects JSON object input' USING ERRCODE = '23514';
  END IF;

  BEGIN v_org_id := NULLIF(v_input->>'organization_id', '')::UUID; EXCEPTION WHEN others THEN v_org_id := NULL; END;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'create_settlement_batch_v1 missing organization_id' USING ERRCODE = '23514';
  END IF;

  BEGIN v_branch_id := NULLIF(v_input->>'branch_id', '')::UUID; EXCEPTION WHEN others THEN v_branch_id := NULL; END;
  BEGIN v_client_id := NULLIF(v_input->>'client_id', '')::UUID; EXCEPTION WHEN others THEN v_client_id := NULL; END;
  BEGIN v_sender_id := NULLIF(v_input->>'sender_id', '')::UUID; EXCEPTION WHEN others THEN v_sender_id := NULL; END;
  BEGIN v_webhook_source_id := NULLIF(v_input->>'webhook_source_id', '')::UUID; EXCEPTION WHEN others THEN v_webhook_source_id := NULL; END;

  v_kind := lower(NULLIF(btrim(COALESCE(v_input->>'kind', '')), ''));
  v_scope_type := lower(NULLIF(btrim(COALESCE(v_input->>'scope_type', '')), ''));
  v_subject_type := lower(NULLIF(btrim(COALESCE(v_input->>'subject_type', '')), ''));
  BEGIN v_subject_id := NULLIF(v_input->>'subject_id', '')::UUID; EXCEPTION WHEN others THEN v_subject_id := NULL; END;
  BEGIN v_window_start := NULLIF(v_input->>'window_start_at', '')::timestamptz; EXCEPTION WHEN others THEN v_window_start := NULL; END;
  BEGIN v_window_end := NULLIF(v_input->>'window_end_at', '')::timestamptz; EXCEPTION WHEN others THEN v_window_end := NULL; END;
  BEGIN v_actor_user_id := NULLIF(v_input->>'actor_user_id', '')::UUID; EXCEPTION WHEN others THEN v_actor_user_id := NULL; END;

  IF v_scope_type IS NULL THEN
    RAISE EXCEPTION 'create_settlement_batch_v1 requires scope_type' USING ERRCODE = '23514';
  END IF;

  -- Validate/resolve kind from lookup when omitted.
  IF v_kind IS NULL THEN
    SELECT lv.value
      INTO v_kind
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'settlement_kind'
       AND lv.is_default IS TRUE
       AND lv.status = 'active'
     ORDER BY COALESCE(lv.sort_order, 0), lv.value
     LIMIT 1;
  END IF;
  IF v_kind IS NULL THEN
    RAISE EXCEPTION 'create_settlement_batch_v1 could not resolve default settlement_kind' USING ERRCODE = '23514';
  END IF;

  PERFORM 1
  FROM public.lookup_definitions ld
  JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
  WHERE ld.category = 'settlement_kind'
    AND lv.value = v_kind
    AND lv.status = 'active'
  LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'create_settlement_batch_v1 invalid kind: %', v_kind USING ERRCODE = '23514';
  END IF;

  PERFORM 1
  FROM public.lookup_definitions ld
  JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
  WHERE ld.category = 'settlement_scope_type'
    AND lv.value = v_scope_type
    AND lv.status = 'active'
  LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'create_settlement_batch_v1 invalid scope_type: %', v_scope_type USING ERRCODE = '23514';
  END IF;

  -- Default status from lookup.
  SELECT lv.value
    INTO v_status
    FROM public.lookup_definitions ld
    JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
   WHERE ld.category = 'settlement_status'
     AND lv.is_default IS TRUE
     AND lv.status = 'active'
   ORDER BY COALESCE(lv.sort_order, 0), lv.value
   LIMIT 1;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'create_settlement_batch_v1 could not resolve default settlement_status' USING ERRCODE = '23514';
  END IF;

  -- Validate commercial references (best-effort; no hardcoded branches).
  IF v_client_id IS NOT NULL THEN
    PERFORM 1
    FROM public.clients c
    WHERE c.id = v_client_id
      AND c.organization_id = v_org_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'create_settlement_batch_v1 client_id % is outside organization_id %', v_client_id, v_org_id
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF v_sender_id IS NOT NULL THEN
    PERFORM 1
    FROM public.senders s
    JOIN public.clients c ON c.id = s.client_id
    WHERE s.id = v_sender_id
      AND c.organization_id = v_org_id
      AND (v_client_id IS NULL OR s.client_id = v_client_id);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'create_settlement_batch_v1 sender_id % is invalid for organization/client context', v_sender_id
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF v_branch_id IS NOT NULL THEN
    PERFORM 1
    FROM public.branches b
    WHERE b.id = v_branch_id
      AND b.organization_id = v_org_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'create_settlement_batch_v1 branch_id % is outside organization_id %', v_branch_id, v_org_id
        USING ERRCODE = '23514';
    END IF;
  END IF;

  -- Resolve policies via canonical ladder (agreement-as-resolution).
  v_policy_ctx := jsonb_strip_nulls(jsonb_build_object(
    'organization_id', v_org_id,
    'client_id', v_client_id,
    'sender_id', v_sender_id,
    'webhook_source_id', v_webhook_source_id,
    'resource_id', v_branch_id
  ));

  SELECT * INTO v_settlement_policy_row
    FROM public.resolve_settlement_policy(v_policy_ctx)
   LIMIT 1;
  v_has_settlement_policy := FOUND;

  IF v_has_settlement_policy AND v_settlement_policy_row.value IS NOT NULL THEN
    v_settlement_policy := v_settlement_policy_row.value;
  END IF;

  -- Enforce settlement_policy.batch_scopes when present (row-driven).
  IF jsonb_typeof(v_settlement_policy->'batch_scopes') = 'array'
     AND NOT (v_settlement_policy->'batch_scopes' ? v_scope_type)
  THEN
    RAISE EXCEPTION 'create_settlement_batch_v1 scope_type % not allowed by settlement_policy.batch_scopes', v_scope_type
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_cod_policy_row
    FROM public.resolve_cod_policy(v_policy_ctx)
   LIMIT 1;
  v_has_cod_policy := FOUND;

  IF v_has_cod_policy AND v_cod_policy_row.value IS NOT NULL THEN
    v_cod_policy := v_cod_policy_row.value;
  END IF;

  -- Insert the projection row. Use idempotency to dedupe concurrent retries without side effects.
  IF v_idempotency IS NOT NULL THEN
    INSERT INTO public.settlement_batches (
      organization_id,
      kind,
      scope_type,
      branch_id,
      client_id,
      sender_id,
      subject_type,
      subject_id,
      window_start_at,
      window_end_at,
      status,
      idempotency_key,
      version,
      metadata,
      created_at,
      updated_at
    )
    VALUES (
      v_org_id,
      v_kind,
      v_scope_type,
      v_branch_id,
      v_client_id,
      v_sender_id,
      v_subject_type,
      v_subject_id,
      v_window_start,
      v_window_end,
      v_status,
      v_idempotency,
      1,
      COALESCE(v_metadata, '{}'::jsonb),
      v_now,
      v_now
    )
    ON CONFLICT (organization_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL AND btrim(idempotency_key) <> ''
    DO NOTHING
    RETURNING id INTO settlement_batch_id;

    IF settlement_batch_id IS NULL THEN
      SELECT b.id
        INTO settlement_batch_id
        FROM public.settlement_batches b
       WHERE b.organization_id = v_org_id
         AND b.idempotency_key = v_idempotency
       LIMIT 1;

      SELECT e.id
        INTO settlement_event_id
        FROM public.settlement_events e
       WHERE e.settlement_batch_id = settlement_batch_id
         AND e.idempotency_key = v_idempotency
       LIMIT 1;

      created := FALSE;
      RETURN NEXT;
      RETURN;
    END IF;
  ELSE
    INSERT INTO public.settlement_batches (
      organization_id,
      kind,
      scope_type,
      branch_id,
      client_id,
      sender_id,
      subject_type,
      subject_id,
      window_start_at,
      window_end_at,
      status,
      idempotency_key,
      version,
      metadata,
      created_at,
      updated_at
    )
    VALUES (
      v_org_id,
      v_kind,
      v_scope_type,
      v_branch_id,
      v_client_id,
      v_sender_id,
      v_subject_type,
      v_subject_id,
      v_window_start,
      v_window_end,
      v_status,
      NULL,
      1,
      COALESCE(v_metadata, '{}'::jsonb),
      v_now,
      v_now
    )
    RETURNING id INTO settlement_batch_id;
  END IF;

  created := TRUE;

  -- Provenance (only for newly-created batches).
  IF v_has_settlement_policy AND v_settlement_policy_row.value IS NOT NULL THEN
    v_settlement_policy_resolution_id := public.log_settings_resolution(
      p_organization_id := v_org_id,
      p_category := 'settlement_policy',
      p_winning_scope_type := v_settlement_policy_row.scope_type,
      p_winning_scope_id := v_settlement_policy_row.scope_id,
      p_winning_settings_id := v_settlement_policy_row.settings_id,
      p_winning_settings_version_id := v_settlement_policy_row.settings_version_id,
      p_winning_version := v_settlement_policy_row.version,
      p_scope_path := v_settlement_policy_row.scope_path,
      p_inputs := jsonb_strip_nulls(jsonb_build_object(
        'kind', v_kind,
        'scope_type', v_scope_type,
        'branch_id', v_branch_id
      )),
      p_merge_notes := NULL
    );
  END IF;

  IF v_has_cod_policy AND v_cod_policy_row.value IS NOT NULL THEN
    v_cod_policy_resolution_id := public.log_settings_resolution(
      p_organization_id := v_org_id,
      p_category := 'cod_policy',
      p_winning_scope_type := v_cod_policy_row.scope_type,
      p_winning_scope_id := v_cod_policy_row.scope_id,
      p_winning_settings_id := v_cod_policy_row.settings_id,
      p_winning_settings_version_id := v_cod_policy_row.settings_version_id,
      p_winning_version := v_cod_policy_row.version,
      p_scope_path := v_cod_policy_row.scope_path,
      p_inputs := jsonb_strip_nulls(jsonb_build_object(
        'kind', v_kind,
        'scope_type', v_scope_type,
        'branch_id', v_branch_id
      )),
      p_merge_notes := NULL
    );
  END IF;

  v_decision_id := public.log_decision(
    p_organization_id := v_org_id,
    p_decision_category := 'settlement',
    p_resource_type := 'settlement_batch',
    p_resource_id := settlement_batch_id,
    p_decision_point := 'create',
    p_decision_outcome := 'created',
    p_performed_by_system := 'create_settlement_batch_v1',
    p_correlation_id := public.current_correlation_id(),
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'kind', v_kind,
      'scope_type', v_scope_type,
      'branch_id', v_branch_id,
      'client_id', v_client_id,
      'sender_id', v_sender_id,
      'subject_type', v_subject_type,
      'subject_id', v_subject_id,
      'window_start_at', v_window_start,
      'window_end_at', v_window_end,
      'settlement_policy_settings_resolution_id', v_settlement_policy_resolution_id,
      'cod_policy_settings_resolution_id', v_cod_policy_resolution_id
    )),
    p_decision_reason := NULL,
    p_settings_resolution_id := v_settlement_policy_resolution_id
  );

  INSERT INTO public.settlement_events (
    settlement_batch_id,
    organization_id,
    event_type,
    from_status,
    to_status,
    actor_user_id,
    actor_system,
    payload,
    idempotency_key,
    batch_version,
    decision_log_id,
    settings_resolution_id,
    created_at
  )
  VALUES (
    settlement_batch_id,
    v_org_id,
    'created',
    NULL,
    v_status,
    v_actor_user_id,
    COALESCE(v_actor_system, 'create_settlement_batch_v1'),
    jsonb_strip_nulls(jsonb_build_object(
      'correlation_id', public.current_correlation_id(),
      'policy_context', v_policy_ctx,
      'settlement_policy', v_settlement_policy,
      'cod_policy', v_cod_policy
    )),
    v_idempotency,
    1,
    v_decision_id,
    v_settlement_policy_resolution_id,
    v_now
  )
  RETURNING id INTO settlement_event_id;

  RETURN NEXT;
END;
$function$;

COMMENT ON FUNCTION public.create_settlement_batch_v1(JSONB) IS
  'Service write-path: create a settlement batch projection row + ledger event (idempotent by organization_id + idempotency_key).';

REVOKE ALL ON FUNCTION public.create_settlement_batch_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_settlement_batch_v1(JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.create_settlement_batch_v1(JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.create_settlement_batch_v1(JSONB) TO service_role;

CREATE OR REPLACE FUNCTION public.transition_settlement_batch_v1(
  p_transition JSONB
)
RETURNS TABLE (
  settlement_batch_id UUID,
  settlement_event_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_input JSONB := COALESCE(p_transition, '{}'::jsonb);

  v_batch_id UUID;
  v_to_status TEXT := lower(NULLIF(btrim(COALESCE(v_input->>'to_status', '')), ''));
  v_status_reason TEXT := NULLIF(btrim(COALESCE(v_input->>'status_reason', '')), '');
  v_payload JSONB := COALESCE(v_input->'payload', '{}'::jsonb);
  v_idempotency TEXT := NULLIF(btrim(COALESCE(v_input->>'idempotency_key', '')), '');

  v_actor_user_id UUID := NULL;
  v_actor_system TEXT := NULLIF(btrim(COALESCE(v_input->>'actor_system', '')), '');

  v_batch public.settlement_batches%ROWTYPE;
  v_from_status TEXT;
  v_next_version INT;

  v_policy_ctx JSONB;
  v_settlement_policy_row RECORD;
  v_settlement_policy_resolution_id UUID := NULL;

  v_decision_id UUID := NULL;
  v_status_meta JSONB := NULL;
BEGIN
  IF jsonb_typeof(v_input) <> 'object' THEN
    RAISE EXCEPTION 'transition_settlement_batch_v1 expects JSON object input' USING ERRCODE = '23514';
  END IF;

  BEGIN v_batch_id := NULLIF(v_input->>'settlement_batch_id', '')::UUID; EXCEPTION WHEN others THEN v_batch_id := NULL; END;
  IF v_batch_id IS NULL THEN
    RAISE EXCEPTION 'transition_settlement_batch_v1 requires settlement_batch_id' USING ERRCODE = '23514';
  END IF;
  IF v_to_status IS NULL THEN
    RAISE EXCEPTION 'transition_settlement_batch_v1 requires to_status' USING ERRCODE = '23514';
  END IF;

  BEGIN v_actor_user_id := NULLIF(v_input->>'actor_user_id', '')::UUID; EXCEPTION WHEN others THEN v_actor_user_id := NULL; END;

  PERFORM 1
  FROM public.lookup_definitions ld
  JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
  WHERE ld.category = 'settlement_status'
    AND lv.value = v_to_status
    AND lv.status = 'active'
  LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'transition_settlement_batch_v1 invalid to_status: %', v_to_status USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_batch
  FROM public.settlement_batches b
  WHERE b.id = v_batch_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'transition_settlement_batch_v1 settlement_batch not found: %', v_batch_id;
  END IF;

  -- Idempotency short-circuit (must happen after locking the batch row).
  IF v_idempotency IS NOT NULL THEN
    SELECT e.id INTO settlement_event_id
    FROM public.settlement_events e
    WHERE e.settlement_batch_id = v_batch.id
      AND e.idempotency_key = v_idempotency
    LIMIT 1;
    IF FOUND THEN
      settlement_batch_id := v_batch.id;
      RETURN NEXT;
      RETURN;
    END IF;
  END IF;

  -- Disallow transitions from final statuses (row-driven via lookup metadata).
  SELECT COALESCE(lv.metadata, '{}'::jsonb)
    INTO v_status_meta
    FROM public.lookup_definitions ld
    JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
   WHERE ld.category = 'settlement_status'
     AND lv.value = v_batch.status
     AND lv.status = 'active'
   LIMIT 1;

  IF COALESCE((v_status_meta->>'is_final')::BOOLEAN, FALSE) IS TRUE THEN
    RAISE EXCEPTION 'transition_settlement_batch_v1 batch is in final status: %', v_batch.status
      USING ERRCODE = '23514';
  END IF;

  v_from_status := v_batch.status;
  v_next_version := v_batch.version + 1;

  UPDATE public.settlement_batches
     SET status = v_to_status,
         status_reason = v_status_reason,
         version = v_next_version
   WHERE id = v_batch.id
   RETURNING * INTO v_batch;

  -- Resolve settlement policy for provenance (based on batch anchors).
  v_policy_ctx := jsonb_strip_nulls(jsonb_build_object(
    'organization_id', v_batch.organization_id,
    'client_id', v_batch.client_id,
    'sender_id', v_batch.sender_id,
    'resource_id', v_batch.branch_id
  ));

  SELECT * INTO v_settlement_policy_row
    FROM public.resolve_settlement_policy(v_policy_ctx)
   LIMIT 1;

  IF FOUND AND v_settlement_policy_row.value IS NOT NULL THEN
    v_settlement_policy_resolution_id := public.log_settings_resolution(
      p_organization_id := v_batch.organization_id,
      p_category := 'settlement_policy',
      p_winning_scope_type := v_settlement_policy_row.scope_type,
      p_winning_scope_id := v_settlement_policy_row.scope_id,
      p_winning_settings_id := v_settlement_policy_row.settings_id,
      p_winning_settings_version_id := v_settlement_policy_row.settings_version_id,
      p_winning_version := v_settlement_policy_row.version,
      p_scope_path := v_settlement_policy_row.scope_path,
      p_inputs := jsonb_strip_nulls(jsonb_build_object(
        'event_type', 'status_changed',
        'from_status', v_from_status,
        'to_status', v_to_status
      )),
      p_merge_notes := NULL
    );
  END IF;

  v_decision_id := public.log_decision(
    p_organization_id := v_batch.organization_id,
    p_decision_category := 'settlement',
    p_resource_type := 'settlement_batch',
    p_resource_id := v_batch.id,
    p_decision_point := 'transition',
    p_decision_outcome := 'status_changed',
    p_performed_by_system := 'transition_settlement_batch_v1',
    p_correlation_id := public.current_correlation_id(),
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'from_status', v_from_status,
      'to_status', v_to_status,
      'status_reason', v_status_reason
    )),
    p_decision_reason := NULL,
    p_settings_resolution_id := v_settlement_policy_resolution_id
  );

  INSERT INTO public.settlement_events (
    settlement_batch_id,
    organization_id,
    event_type,
    from_status,
    to_status,
    actor_user_id,
    actor_system,
    payload,
    idempotency_key,
    batch_version,
    decision_log_id,
    settings_resolution_id
  )
  VALUES (
    v_batch.id,
    v_batch.organization_id,
    'status_changed',
    v_from_status,
    v_to_status,
    v_actor_user_id,
    COALESCE(v_actor_system, 'transition_settlement_batch_v1'),
    jsonb_strip_nulls(COALESCE(v_payload, '{}'::jsonb) || jsonb_build_object(
      'status_reason', v_status_reason,
      'correlation_id', public.current_correlation_id()
    )),
    v_idempotency,
    v_next_version,
    v_decision_id,
    v_settlement_policy_resolution_id
  )
  RETURNING id INTO settlement_event_id;

  settlement_batch_id := v_batch.id;
  RETURN NEXT;
END;
$function$;

COMMENT ON FUNCTION public.transition_settlement_batch_v1(JSONB) IS
  'Service write-path: transition settlement batch status (projection update + ledger event; idempotent by batch + idempotency_key).';

REVOKE ALL ON FUNCTION public.transition_settlement_batch_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.transition_settlement_batch_v1(JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.transition_settlement_batch_v1(JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.transition_settlement_batch_v1(JSONB) TO service_role;

CREATE OR REPLACE FUNCTION public.attach_finance_event_to_settlement_v1(
  p_attach JSONB
)
RETURNS TABLE (
  settlement_batch_id UUID,
  settlement_event_id UUID,
  attached BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_input JSONB := COALESCE(p_attach, '{}'::jsonb);

  v_batch_id UUID;
  v_finance_event_id UUID;
  v_finance_occurred_at TIMESTAMPTZ;
  v_idempotency TEXT := NULLIF(btrim(COALESCE(v_input->>'idempotency_key', '')), '');
  v_payload JSONB := COALESCE(v_input->'payload', '{}'::jsonb);

  v_actor_user_id UUID := NULL;
  v_actor_system TEXT := NULLIF(btrim(COALESCE(v_input->>'actor_system', '')), '');

  v_batch public.settlement_batches%ROWTYPE;
  v_next_version INT;

  v_status_meta JSONB := NULL;

  v_policy_ctx JSONB;
  v_settlement_policy_row RECORD;
  v_settlement_policy_resolution_id UUID := NULL;

  v_decision_id UUID := NULL;
  v_rows INT := 0;
  v_inserted BOOLEAN := FALSE;
BEGIN
  IF jsonb_typeof(v_input) <> 'object' THEN
    RAISE EXCEPTION 'attach_finance_event_to_settlement_v1 expects JSON object input' USING ERRCODE = '23514';
  END IF;

  BEGIN v_batch_id := NULLIF(v_input->>'settlement_batch_id', '')::UUID; EXCEPTION WHEN others THEN v_batch_id := NULL; END;
  BEGIN v_finance_event_id := NULLIF(v_input->>'finance_event_id', '')::UUID; EXCEPTION WHEN others THEN v_finance_event_id := NULL; END;
  BEGIN v_finance_occurred_at := NULLIF(v_input->>'finance_occurred_at', '')::timestamptz; EXCEPTION WHEN others THEN v_finance_occurred_at := NULL; END;
  BEGIN v_actor_user_id := NULLIF(v_input->>'actor_user_id', '')::UUID; EXCEPTION WHEN others THEN v_actor_user_id := NULL; END;

  IF v_batch_id IS NULL THEN
    RAISE EXCEPTION 'attach_finance_event_to_settlement_v1 requires settlement_batch_id' USING ERRCODE = '23514';
  END IF;
  IF v_finance_event_id IS NULL THEN
    RAISE EXCEPTION 'attach_finance_event_to_settlement_v1 requires finance_event_id' USING ERRCODE = '23514';
  END IF;
  IF v_idempotency IS NULL THEN
    RAISE EXCEPTION 'attach_finance_event_to_settlement_v1 requires idempotency_key' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_batch
  FROM public.settlement_batches b
  WHERE b.id = v_batch_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'attach_finance_event_to_settlement_v1 settlement_batch not found: %', v_batch_id;
  END IF;

  -- Idempotency short-circuit (must happen after locking the batch row).
  SELECT e.id INTO settlement_event_id
  FROM public.settlement_events e
  WHERE e.settlement_batch_id = v_batch.id
    AND e.idempotency_key = v_idempotency
  LIMIT 1;
  IF FOUND THEN
    settlement_batch_id := v_batch.id;
    attached := TRUE;
    RETURN NEXT;
    RETURN;
  END IF;

  -- Disallow attaching when attachments are not allowed (row-driven via lookup metadata).
  SELECT COALESCE(lv.metadata, '{}'::jsonb)
    INTO v_status_meta
    FROM public.lookup_definitions ld
    JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
   WHERE ld.category = 'settlement_status'
     AND lv.value = v_batch.status
     AND lv.status = 'active'
   LIMIT 1;

  IF COALESCE((v_status_meta->>'attachments_allowed')::BOOLEAN, TRUE) IS NOT TRUE THEN
    RAISE EXCEPTION 'attach_finance_event_to_settlement_v1 not allowed in status: %', v_batch.status
      USING ERRCODE = '23514';
  END IF;

  -- Resolve occurred_at when caller does not provide it (finance_events is partitioned by occurred_at).
  IF v_finance_occurred_at IS NULL THEN
    SELECT fe.occurred_at
      INTO v_finance_occurred_at
      FROM public.finance_events fe
     WHERE fe.id = v_finance_event_id
       AND fe.organization_id = v_batch.organization_id
     ORDER BY fe.occurred_at DESC
     LIMIT 1;
  END IF;

  -- Validate finance event exists for this organization (partition-safe composite PK).
  PERFORM 1
  FROM public.finance_events fe
  WHERE fe.id = v_finance_event_id
    AND fe.organization_id = v_batch.organization_id
    AND fe.occurred_at = v_finance_occurred_at
  LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'attach_finance_event_to_settlement_v1 finance_event not found for org/time key' USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.settlement_batch_finance_events (
    settlement_batch_id,
    organization_id,
    finance_event_id,
    finance_occurred_at,
    created_at
  )
  VALUES (
    v_batch.id,
    v_batch.organization_id,
    v_finance_event_id,
    v_finance_occurred_at,
    now()
  )
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  v_inserted := (v_rows > 0);

  v_next_version := v_batch.version + 1;

  UPDATE public.settlement_batches
     SET version = v_next_version
   WHERE id = v_batch.id;

  -- Resolve settlement policy for provenance (based on batch anchors).
  v_policy_ctx := jsonb_strip_nulls(jsonb_build_object(
    'organization_id', v_batch.organization_id,
    'client_id', v_batch.client_id,
    'sender_id', v_batch.sender_id,
    'resource_id', v_batch.branch_id
  ));

  SELECT * INTO v_settlement_policy_row
    FROM public.resolve_settlement_policy(v_policy_ctx)
   LIMIT 1;

  IF FOUND AND v_settlement_policy_row.value IS NOT NULL THEN
    v_settlement_policy_resolution_id := public.log_settings_resolution(
      p_organization_id := v_batch.organization_id,
      p_category := 'settlement_policy',
      p_winning_scope_type := v_settlement_policy_row.scope_type,
      p_winning_scope_id := v_settlement_policy_row.scope_id,
      p_winning_settings_id := v_settlement_policy_row.settings_id,
      p_winning_settings_version_id := v_settlement_policy_row.settings_version_id,
      p_winning_version := v_settlement_policy_row.version,
      p_scope_path := v_settlement_policy_row.scope_path,
      p_inputs := jsonb_strip_nulls(jsonb_build_object(
        'event_type', 'finance_event_attached',
        'finance_event_id', v_finance_event_id,
        'finance_occurred_at', v_finance_occurred_at
      )),
      p_merge_notes := NULL
    );
  END IF;

  v_decision_id := public.log_decision(
    p_organization_id := v_batch.organization_id,
    p_decision_category := 'settlement',
    p_resource_type := 'settlement_batch',
    p_resource_id := v_batch.id,
    p_decision_point := 'attach_finance_event',
    p_decision_outcome := CASE WHEN v_inserted THEN 'attached' ELSE 'already_attached' END,
    p_performed_by_system := 'attach_finance_event_to_settlement_v1',
    p_correlation_id := public.current_correlation_id(),
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'finance_event_id', v_finance_event_id,
      'finance_occurred_at', v_finance_occurred_at
    )),
    p_decision_reason := NULL,
    p_settings_resolution_id := v_settlement_policy_resolution_id
  );

  INSERT INTO public.settlement_events (
    settlement_batch_id,
    organization_id,
    event_type,
    from_status,
    to_status,
    actor_user_id,
    actor_system,
    payload,
    idempotency_key,
    batch_version,
    decision_log_id,
    settings_resolution_id
  )
  VALUES (
    v_batch.id,
    v_batch.organization_id,
    'finance_event_attached',
    v_batch.status,
    v_batch.status,
    v_actor_user_id,
    COALESCE(v_actor_system, 'attach_finance_event_to_settlement_v1'),
    jsonb_strip_nulls(COALESCE(v_payload, '{}'::jsonb) || jsonb_build_object(
      'finance_event_id', v_finance_event_id,
      'finance_occurred_at', v_finance_occurred_at,
      'correlation_id', public.current_correlation_id()
    )),
    v_idempotency,
    v_next_version,
    v_decision_id,
    v_settlement_policy_resolution_id
  )
  RETURNING id INTO settlement_event_id;

  settlement_batch_id := v_batch.id;
  attached := v_inserted;
  RETURN NEXT;
END;
$function$;

COMMENT ON FUNCTION public.attach_finance_event_to_settlement_v1(JSONB) IS
  'Service write-path: attach a finance_event to a settlement batch (membership insert + ledger event; idempotent).';

REVOKE ALL ON FUNCTION public.attach_finance_event_to_settlement_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.attach_finance_event_to_settlement_v1(JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.attach_finance_event_to_settlement_v1(JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.attach_finance_event_to_settlement_v1(JSONB) TO service_role;

SELECT pg_advisory_unlock(hashtext('202601212860_settlement_ssot'));
COMMIT;
