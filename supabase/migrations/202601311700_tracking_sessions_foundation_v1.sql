-- Plan: PLAN-202601-last-mile-enterprise-readiness-v2 / Step: S04
-- Migration: Tracking sessions foundation v1 (public tracking link registry; hashed tokens)
-- Date: 2026-01-31
--
-- Goals:
--   - Add a first-class tracking session registry for customer/public tracking links.
--   - Store tokens as salted hashes (no raw token persistence).
--   - Enforce strict RLS (tenant/client/sender reads only; service-only writes).
--   - Keep behavior row-driven (lookup contracts; policy hooks via settings later).
--
-- Notes:
--   - Public/anon access should be mediated by an edge function using service_role (not direct DB access).
--   - We intentionally do NOT store raw tokens; issuers must deliver the token at creation time.
BEGIN;
SELECT pg_advisory_lock(hashtext('202601311700_tracking_sessions_foundation_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Lookups (row-driven enums; SSOT)
-------------------------------------------------------------------------------

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES ('tracking_session_status', 'Tracking session status for public tracking links', 'operations', 'tier_1', FALSE)
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
  ('active',  'Active',  'Tracking link is active', 10, TRUE,  '{}' ),
  ('revoked', 'Revoked', 'Tracking link has been revoked', 20, FALSE, '{}' ),
  ('expired', 'Expired', 'Tracking link has expired', 30, FALSE, '{}' )
) AS v(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'tracking_session_status'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

-------------------------------------------------------------------------------
-- 2) tracking_sessions: hashed-token registry (projection)
-------------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.tracking_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  -- Shipments are HASH partitioned by client_id; store client_id alongside shipment_id for deterministic joins.
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  sender_id UUID REFERENCES public.senders(id) ON DELETE SET NULL,
  shipment_id UUID NOT NULL,

  recipient_id UUID REFERENCES public.recipients(id) ON DELETE SET NULL,

  -- Raw tokens must never be persisted. Accept token only for hashing, then redact.
  token TEXT NULL,
  token_hash TEXT NULL,
  token_hint TEXT NULL,

  status TEXT NOT NULL DEFAULT 'active', -- lookup tracking_session_status
  expires_at TIMESTAMPTZ NULL,
  revoked_at TIMESTAMPTZ NULL,

  last_viewed_at TIMESTAMPTZ NULL,
  view_count INT NOT NULL DEFAULT 0,

  idempotency_key TEXT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT tracking_sessions_status_ck CHECK (btrim(status) <> '' AND status = lower(status)),
  CONSTRAINT tracking_sessions_view_count_ck CHECK (view_count >= 0),
  CONSTRAINT tracking_sessions_token_hash_nonempty CHECK (token_hash IS NULL OR btrim(token_hash) <> ''),
  CONSTRAINT tracking_sessions_token_hint_nonempty CHECK (token_hint IS NULL OR btrim(token_hint) <> ''),
  CONSTRAINT tracking_sessions_shipment_fk
    FOREIGN KEY (shipment_id, client_id) REFERENCES public.shipments(id, client_id) ON DELETE CASCADE
);

COMMENT ON TABLE public.tracking_sessions IS
  'Tracking link/session registry for customer tracking pages. Tokens are stored as salted hashes; public access must be mediated by service_role.';
COMMENT ON COLUMN public.tracking_sessions.token IS
  'Ephemeral input only; raw token is redacted. Use token_hash for comparisons.';
COMMENT ON COLUMN public.tracking_sessions.token_hash IS
  'BCrypt hash of tracking token; compare via crypt(token, token_hash) = token_hash.';
COMMENT ON COLUMN public.tracking_sessions.token_hint IS
  'Optional non-secret hint for support/debugging (e.g., first 6 chars); never sufficient to authenticate.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_tracking_sessions_org_idempotency
  ON public.tracking_sessions (organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND btrim(idempotency_key) <> '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_tracking_sessions_token_hash
  ON public.tracking_sessions (token_hash)
  WHERE token_hash IS NOT NULL AND btrim(token_hash) <> '';

-- FK supporting indexes (enterprise hygiene; non-partial).
CREATE INDEX IF NOT EXISTS idx_tracking_sessions__shipment_id_client_id__fk
  ON public.tracking_sessions (shipment_id, client_id);

CREATE INDEX IF NOT EXISTS idx_tracking_sessions__sender_id__fk
  ON public.tracking_sessions (sender_id);

CREATE INDEX IF NOT EXISTS idx_tracking_sessions__recipient_id__fk
  ON public.tracking_sessions (recipient_id);

CREATE INDEX IF NOT EXISTS idx_tracking_sessions_shipment
  ON public.tracking_sessions (client_id, shipment_id);

CREATE INDEX IF NOT EXISTS idx_tracking_sessions_org_status
  ON public.tracking_sessions (organization_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tracking_sessions_recipient
  ON public.tracking_sessions (organization_id, recipient_id, created_at DESC)
  WHERE recipient_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.tracking_sessions_enforce_org_match_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_client_org UUID;
  v_sender_org UUID;
  v_shipment_org UUID;
  v_recipient_org UUID;
BEGIN
  IF NEW.organization_id IS NULL THEN
    RAISE EXCEPTION 'tracking_sessions: organization_id is required'
      USING ERRCODE = '23502';
  END IF;

  SELECT c.organization_id
    INTO v_client_org
    FROM public.clients c
   WHERE c.id = NEW.client_id;

  IF v_client_org IS NULL THEN
    RAISE EXCEPTION 'tracking_sessions: client % not found', NEW.client_id
      USING ERRCODE = '23503';
  END IF;

  IF v_client_org IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'tracking_sessions: organization mismatch (session org %, client org %)', NEW.organization_id, v_client_org
      USING ERRCODE = '23514';
  END IF;

  IF NEW.sender_id IS NOT NULL THEN
    SELECT c.organization_id
      INTO v_sender_org
      FROM public.senders s
      JOIN public.clients c ON c.id = s.client_id
     WHERE s.id = NEW.sender_id;

    IF v_sender_org IS NULL THEN
      RAISE EXCEPTION 'tracking_sessions: sender % not found', NEW.sender_id
        USING ERRCODE = '23503';
    END IF;

    IF v_sender_org IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'tracking_sessions: organization mismatch (session org %, sender org %)', NEW.organization_id, v_sender_org
        USING ERRCODE = '23514';
    END IF;
  END IF;

  SELECT s.organization_id
    INTO v_shipment_org
    FROM public.shipments s
   WHERE s.id = NEW.shipment_id
     AND s.client_id = NEW.client_id
   LIMIT 1;

  IF v_shipment_org IS NULL THEN
    RAISE EXCEPTION 'tracking_sessions: shipment % not found for client %', NEW.shipment_id, NEW.client_id
      USING ERRCODE = '23503';
  END IF;

  IF v_shipment_org IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'tracking_sessions: organization mismatch (session org %, shipment org %)', NEW.organization_id, v_shipment_org
      USING ERRCODE = '23514';
  END IF;

  IF NEW.recipient_id IS NOT NULL THEN
    SELECT r.organization_id
      INTO v_recipient_org
      FROM public.recipients r
     WHERE r.id = NEW.recipient_id;

    IF v_recipient_org IS NULL THEN
      RAISE EXCEPTION 'tracking_sessions: recipient % not found', NEW.recipient_id
        USING ERRCODE = '23503';
    END IF;

    IF v_recipient_org IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'tracking_sessions: organization mismatch (session org %, recipient org %)', NEW.organization_id, v_recipient_org
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_tracking_sessions_enforce_org_match ON public.tracking_sessions;
CREATE TRIGGER trg_tracking_sessions_enforce_org_match
  BEFORE INSERT OR UPDATE ON public.tracking_sessions
  FOR EACH ROW
  EXECUTE FUNCTION public.tracking_sessions_enforce_org_match_v1();

CREATE OR REPLACE FUNCTION public.tracking_sessions_hash_token_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
BEGIN
  IF NEW.token IS NOT NULL THEN
    NEW.token_hash := crypt(NEW.token, gen_salt('bf'));
    NEW.token_hint := COALESCE(NEW.token_hint, left(NEW.token, 6));
    NEW.token := NULL;
  ELSIF NEW.token_hash IS NULL AND TG_OP = 'UPDATE' THEN
    NEW.token_hash := OLD.token_hash;
    NEW.token_hint := COALESCE(NEW.token_hint, OLD.token_hint);
  END IF;

  IF NEW.token_hash IS NULL THEN
    RAISE EXCEPTION 'tracking_sessions: token_hash must be set (provide token to hash)'
      USING ERRCODE = '23502';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_tracking_sessions_hash_token ON public.tracking_sessions;
CREATE TRIGGER trg_tracking_sessions_hash_token
  BEFORE INSERT OR UPDATE ON public.tracking_sessions
  FOR EACH ROW
  EXECUTE FUNCTION public.tracking_sessions_hash_token_v1();

DROP TRIGGER IF EXISTS trg_tracking_sessions_set_updated_at ON public.tracking_sessions;
CREATE TRIGGER trg_tracking_sessions_set_updated_at
  BEFORE UPDATE ON public.tracking_sessions
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-------------------------------------------------------------------------------
-- 3) RLS + grants
-------------------------------------------------------------------------------

ALTER TABLE public.tracking_sessions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.tracking_sessions FROM PUBLIC;
REVOKE ALL ON TABLE public.tracking_sessions FROM anon;
REVOKE ALL ON TABLE public.tracking_sessions FROM authenticated;

DROP POLICY IF EXISTS tracking_sessions_select ON public.tracking_sessions;
CREATE POLICY tracking_sessions_select ON public.tracking_sessions
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

DROP POLICY IF EXISTS tracking_sessions_service_policy ON public.tracking_sessions;
CREATE POLICY tracking_sessions_service_policy ON public.tracking_sessions
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

GRANT SELECT ON public.tracking_sessions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tracking_sessions TO service_role;

-------------------------------------------------------------------------------
-- 4) Contracts: table_contracts + lookup_column_contracts
-------------------------------------------------------------------------------

INSERT INTO public.table_contracts (table_schema, table_name, created_at_required, updated_at_required, audit_enabled, notes)
VALUES
  ('public', 'tracking_sessions', TRUE, TRUE, TRUE, 'Customer tracking link registry; token stored as hash; public access via edge. ')
ON CONFLICT (table_schema, table_name) DO UPDATE
SET
  created_at_required = EXCLUDED.created_at_required,
  updated_at_required = EXCLUDED.updated_at_required,
  audit_enabled = EXCLUDED.audit_enabled,
  notes = EXCLUDED.notes,
  updated_at = now();

INSERT INTO public.lookup_column_contracts (table_schema, table_name, column_name, lookup_category)
VALUES
  ('public', 'tracking_sessions', 'status', 'tracking_session_status')
ON CONFLICT (table_schema, table_name, column_name) DO UPDATE
SET lookup_category = EXCLUDED.lookup_category;

SELECT public.apply_lookup_column_contracts('public');

SELECT pg_advisory_unlock(hashtext('202601311700_tracking_sessions_foundation_v1'));
COMMIT;
