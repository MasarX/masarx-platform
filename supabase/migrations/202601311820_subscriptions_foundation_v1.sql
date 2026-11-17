-- Plan: PLAN-202601-last-mile-enterprise-readiness-v2 / Step: S04
-- Migration: Subscriptions foundation v1 (contracted plan state; projection + events)
-- Date: 2026-01-31
--
-- Goals:
--   - Track tenant commercial subscription/plan state for client/sender relationships (governance + billing readiness).
--   - Keep runtime behavior policy-driven via settings ladder (this is a governance/projection layer, not a routing engine).
--   - Enforce strict RLS (tenant-only) and gate reads behind RBAC (agreements.read).
BEGIN;
SELECT pg_advisory_lock(hashtext('202601311820_subscriptions_foundation_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Lookups (row-driven enums; SSOT)
-------------------------------------------------------------------------------

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES ('subscription_status', 'Subscription status for contracted client/sender plan state', 'finance', 'tier_1', TRUE)
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
  ('active',    'Active',    'Subscription is active', 10, TRUE,  '{}' ),
  ('paused',    'Paused',    'Subscription is paused', 20, FALSE, '{}' ),
  ('canceled',  'Canceled',  'Subscription is canceled', 90, FALSE, '{"is_final":true}' ),
  ('expired',   'Expired',   'Subscription expired (term ended)', 95, FALSE, '{"is_final":true}' )
) AS v(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'subscription_status'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

-------------------------------------------------------------------------------
-- 2) subscriptions projection
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  client_id UUID REFERENCES public.clients(id) ON DELETE SET NULL,
  sender_id UUID REFERENCES public.senders(id) ON DELETE SET NULL,

  plan_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', -- lookup subscription_status
  status_reason TEXT,

  starts_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ends_at TIMESTAMPTZ,

  currency TEXT,
  price_amount NUMERIC,

  external_ref TEXT,
  idempotency_key TEXT,
  version INT NOT NULL DEFAULT 1,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT subscriptions_plan_key_ck CHECK (btrim(plan_key) <> '' AND plan_key = lower(plan_key)),
  CONSTRAINT subscriptions_status_ck CHECK (btrim(status) <> '' AND status = lower(status)),
  CONSTRAINT subscriptions_dates_ck CHECK (ends_at IS NULL OR ends_at > starts_at),
  CONSTRAINT subscriptions_scope_ck CHECK (sender_id IS NULL OR client_id IS NOT NULL),
  CONSTRAINT subscriptions_version_ck CHECK (version > 0),
  CONSTRAINT subscriptions_idempotency_ck CHECK (idempotency_key IS NULL OR btrim(idempotency_key) <> '')
);

COMMENT ON TABLE public.subscriptions IS
  'Subscription/plan state projection for client/sender commercial relationships (governance-only). Runtime behavior remains settings-ladder driven.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_org_idempotency
  ON public.subscriptions (organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND btrim(idempotency_key) <> '';

CREATE INDEX IF NOT EXISTS idx_subscriptions_org_status
  ON public.subscriptions (organization_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_subscriptions_client_status
  ON public.subscriptions (client_id, status, created_at DESC)
  WHERE client_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_subscriptions_sender_status
  ON public.subscriptions (sender_id, status, created_at DESC)
  WHERE sender_id IS NOT NULL;

-- FK supporting indexes (enterprise hygiene; non-partial).
CREATE INDEX IF NOT EXISTS idx_subscriptions__client_id__fk
  ON public.subscriptions (client_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions__sender_id__fk
  ON public.subscriptions (sender_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions__created_by_user_id__fk
  ON public.subscriptions (created_by_user_id);

CREATE OR REPLACE FUNCTION public.subscriptions_enforce_org_match_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_client_org UUID;
  v_sender_org UUID;
  v_sender_client UUID;
  v_user_org UUID;
BEGIN
  IF NEW.organization_id IS NULL THEN
    RAISE EXCEPTION 'subscriptions: organization_id is required' USING ERRCODE = '23502';
  END IF;

  IF NEW.client_id IS NOT NULL THEN
    SELECT c.organization_id INTO v_client_org
    FROM public.clients c
    WHERE c.id = NEW.client_id;

    IF v_client_org IS NULL THEN
      RAISE EXCEPTION 'subscriptions: client % not found', NEW.client_id USING ERRCODE = '23503';
    END IF;

    IF v_client_org IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'subscriptions: organization mismatch (subscription org %, client org %)', NEW.organization_id, v_client_org
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.sender_id IS NOT NULL THEN
    SELECT c.organization_id, s.client_id
      INTO v_sender_org, v_sender_client
    FROM public.senders s
    JOIN public.clients c ON c.id = s.client_id
    WHERE s.id = NEW.sender_id;

    IF v_sender_org IS NULL THEN
      RAISE EXCEPTION 'subscriptions: sender % not found', NEW.sender_id USING ERRCODE = '23503';
    END IF;

    IF v_sender_org IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'subscriptions: organization mismatch (subscription org %, sender org %)', NEW.organization_id, v_sender_org
        USING ERRCODE = '23514';
    END IF;

    IF NEW.client_id IS NULL THEN
      RAISE EXCEPTION 'subscriptions: client_id is required when sender_id is set' USING ERRCODE = '23514';
    END IF;

    IF v_sender_client IS DISTINCT FROM NEW.client_id THEN
      RAISE EXCEPTION 'subscriptions: sender % belongs to client %, not %', NEW.sender_id, v_sender_client, NEW.client_id
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.created_by_user_id IS NOT NULL THEN
    SELECT u.organization_id INTO v_user_org
    FROM public.users u
    WHERE u.id = NEW.created_by_user_id;

    IF v_user_org IS NULL THEN
      RAISE EXCEPTION 'subscriptions: user % not found', NEW.created_by_user_id USING ERRCODE = '23503';
    END IF;

    IF v_user_org IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'subscriptions: organization mismatch (subscription org %, user org %)', NEW.organization_id, v_user_org
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_subscriptions_enforce_org_match ON public.subscriptions;
CREATE TRIGGER trg_subscriptions_enforce_org_match
  BEFORE INSERT OR UPDATE ON public.subscriptions
  FOR EACH ROW
  EXECUTE FUNCTION public.subscriptions_enforce_org_match_v1();

DROP TRIGGER IF EXISTS trg_subscriptions_set_updated_at ON public.subscriptions;
CREATE TRIGGER trg_subscriptions_set_updated_at
  BEFORE UPDATE ON public.subscriptions
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.subscriptions FROM PUBLIC;
REVOKE ALL ON TABLE public.subscriptions FROM anon;
REVOKE ALL ON TABLE public.subscriptions FROM authenticated;

DROP POLICY IF EXISTS subscriptions_select ON public.subscriptions;
CREATE POLICY subscriptions_select ON public.subscriptions
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
      AND public.user_has_permission_v1('agreements.read', organization_id)
    )
  );

DROP POLICY IF EXISTS subscriptions_service_policy ON public.subscriptions;
CREATE POLICY subscriptions_service_policy ON public.subscriptions
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

GRANT SELECT ON public.subscriptions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.subscriptions TO service_role;

-------------------------------------------------------------------------------
-- 3) subscription_events ledger
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.subscription_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id UUID NOT NULL REFERENCES public.subscriptions(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  event_type TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,

  actor_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  actor_system TEXT,

  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key TEXT,
  subscription_version INT NOT NULL,

  decision_log_id UUID,
  settings_resolution_id UUID,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT subscription_events_event_type_ck CHECK (btrim(event_type) <> '' AND event_type = lower(event_type)),
  CONSTRAINT subscription_events_subscription_version_ck CHECK (subscription_version > 0),
  CONSTRAINT subscription_events_idempotency_ck CHECK (idempotency_key IS NULL OR btrim(idempotency_key) <> '')
);

COMMENT ON TABLE public.subscription_events IS
  'Immutable subscription event ledger (SSOT). subscriptions is the projection.';

CREATE INDEX IF NOT EXISTS idx_subscription_events_subscription_created
  ON public.subscription_events (subscription_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_events_subscription_version
  ON public.subscription_events (subscription_id, subscription_version);

CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_events_idempotency
  ON public.subscription_events (subscription_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND btrim(idempotency_key) <> '';

CREATE INDEX IF NOT EXISTS idx_subscription_events_org_created
  ON public.subscription_events (organization_id, created_at DESC);

-- FK supporting indexes (enterprise hygiene; non-partial).
CREATE INDEX IF NOT EXISTS idx_subscription_events__actor_user_id__fk
  ON public.subscription_events (actor_user_id);

CREATE OR REPLACE FUNCTION public.subscription_events_enforce_org_match_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_sub_org UUID;
BEGIN
  SELECT s.organization_id INTO v_sub_org
  FROM public.subscriptions s
  WHERE s.id = NEW.subscription_id;

  IF v_sub_org IS NULL THEN
    RAISE EXCEPTION 'subscription_events: subscription % not found', NEW.subscription_id USING ERRCODE = '23503';
  END IF;

  IF NEW.organization_id IS NULL THEN
    NEW.organization_id := v_sub_org;
  END IF;

  IF NEW.organization_id IS DISTINCT FROM v_sub_org THEN
    RAISE EXCEPTION 'subscription_events: organization mismatch (event org %, subscription org %)', NEW.organization_id, v_sub_org
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_subscription_events_enforce_org_match ON public.subscription_events;
CREATE TRIGGER trg_subscription_events_enforce_org_match
  BEFORE INSERT OR UPDATE ON public.subscription_events
  FOR EACH ROW
  EXECUTE FUNCTION public.subscription_events_enforce_org_match_v1();

ALTER TABLE public.subscription_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.subscription_events FROM PUBLIC;
REVOKE ALL ON TABLE public.subscription_events FROM anon;
REVOKE ALL ON TABLE public.subscription_events FROM authenticated;

DROP POLICY IF EXISTS subscription_events_select ON public.subscription_events;
CREATE POLICY subscription_events_select ON public.subscription_events
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
      AND public.user_has_permission_v1('agreements.read', organization_id)
      AND EXISTS (
        SELECT 1
        FROM public.subscriptions s
        WHERE s.id = subscription_events.subscription_id
          AND s.organization_id = subscription_events.organization_id
      )
    )
  );

DROP POLICY IF EXISTS subscription_events_service_policy ON public.subscription_events;
CREATE POLICY subscription_events_service_policy ON public.subscription_events
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

GRANT SELECT ON public.subscription_events TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.subscription_events TO service_role;

-------------------------------------------------------------------------------
-- 4) Contracts + apply
-------------------------------------------------------------------------------

INSERT INTO public.table_contracts (table_schema, table_name, created_at_required, updated_at_required, audit_enabled, notes)
VALUES
  ('public', 'subscriptions', TRUE, TRUE, TRUE, 'Subscription/plan state projection (governance; tenant-visible; RBAC-gated reads).'),
  ('public', 'subscription_events', TRUE, FALSE, FALSE, 'Subscription event ledger (SSOT; disable double-audit).')
ON CONFLICT (table_schema, table_name) DO UPDATE
SET
  created_at_required = EXCLUDED.created_at_required,
  updated_at_required = EXCLUDED.updated_at_required,
  audit_enabled = EXCLUDED.audit_enabled,
  notes = EXCLUDED.notes,
  updated_at = now();

SELECT * FROM public.apply_table_contracts('public');
SELECT * FROM public.ensure_audit_triggers();
SELECT public.refresh_api_contract_views_v1();

SELECT pg_advisory_unlock(hashtext('202601311820_subscriptions_foundation_v1'));
COMMIT;

