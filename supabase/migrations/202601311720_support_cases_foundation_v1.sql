-- Plan: PLAN-202601-last-mile-enterprise-readiness-v2 / Step: S04
-- Migration: Support cases foundation v1 (case projection + events + messages)
-- Date: 2026-01-31
--
-- Goals:
--   - Introduce an audit-grade customer support/disputes foundation:
--     - support_cases (projection)
--     - support_case_events (immutable ledger)
--     - support_messages (immutable ledger)
--   - Keep operational behavior row-driven (policies via settings later; tasks/workflows for actions later).
--   - Enforce strict RLS + least privilege for multi-tenant SaaS.
--   - Avoid hardcoded enums (lookup contracts only).
BEGIN;
SELECT pg_advisory_lock(hashtext('202601311720_support_cases_foundation_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Lookups (row-driven enums; SSOT)
-------------------------------------------------------------------------------

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES ('support_case_status', 'Support case lifecycle status (projection)', 'operations', 'tier_1', TRUE)
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
  ('open',        'Open',        'Case opened', 10, TRUE,  '{}' ),
  ('in_progress', 'In Progress', 'Case is being handled', 20, FALSE, '{}' ),
  ('resolved',    'Resolved',    'Case resolved (pending close)', 30, FALSE, '{}' ),
  ('closed',      'Closed',      'Case closed', 40, FALSE, '{"is_final": true}' ),
  ('canceled',    'Canceled',    'Case canceled/voided', 90, FALSE, '{"is_final": true}' )
) AS v(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'support_case_status'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES ('support_case_priority', 'Support case priority/urgency', 'operations', 'tier_1', TRUE)
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
  ('urgent', 'Urgent', 'Immediate handling required', 10, FALSE, '{}' ),
  ('high',   'High',   'High priority case', 20, FALSE, '{}' ),
  ('medium', 'Medium', 'Standard priority case', 30, TRUE,  '{}' ),
  ('low',    'Low',    'Low priority case', 40, FALSE, '{}' )
) AS v(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'support_case_priority'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES ('support_message_direction', 'Support message direction (inbound/outbound/internal)', 'operations', 'tier_1', TRUE)
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
  ('inbound',  'Inbound',  'Inbound from customer/client/sender', 10, TRUE,  '{}' ),
  ('outbound', 'Outbound', 'Outbound to customer/client/sender', 20, FALSE, '{}' ),
  ('internal', 'Internal', 'Internal note', 30, FALSE, '{}' )
) AS v(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'support_message_direction'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES ('support_message_channel', 'Support message channel (sms/email/whatsapp/phone/in_app/internal)', 'operations', 'tier_1', TRUE)
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
  ('in_app',   'In-App',   'In-app chat or portal', 10, TRUE,  '{}' ),
  ('whatsapp', 'WhatsApp', 'WhatsApp message', 20, FALSE, '{}' ),
  ('sms',      'SMS',      'SMS message', 30, FALSE, '{}' ),
  ('email',    'Email',    'Email message', 40, FALSE, '{}' ),
  ('phone',    'Phone',    'Phone call summary', 50, FALSE, '{}' ),
  ('internal', 'Internal', 'Internal system note', 90, FALSE, '{}' )
) AS v(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'support_message_channel'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

-------------------------------------------------------------------------------
-- 2) support_cases projection
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.support_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  client_id UUID REFERENCES public.clients(id) ON DELETE SET NULL,
  sender_id UUID REFERENCES public.senders(id) ON DELETE SET NULL,

  -- Optional link to a primary domain resource (shipment/task/return/etc.). Keep generic to avoid schema sprawl.
  resource_type TEXT,
  resource_id UUID,

  status TEXT NOT NULL DEFAULT 'open', -- lookup support_case_status
  status_reason TEXT,
  priority TEXT NOT NULL DEFAULT 'medium', -- lookup support_case_priority

  assigned_to UUID REFERENCES public.users(id) ON DELETE SET NULL,
  assigned_at TIMESTAMPTZ,

  sla_minutes INT,
  sla_due_at TIMESTAMPTZ,

  opened_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,

  idempotency_key TEXT,
  version INT NOT NULL DEFAULT 1,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT support_cases_status_ck CHECK (btrim(status) <> '' AND status = lower(status)),
  CONSTRAINT support_cases_priority_ck CHECK (btrim(priority) <> '' AND priority = lower(priority)),
  CONSTRAINT support_cases_version_ck CHECK (version > 0),
  CONSTRAINT support_cases_resource_type_ck CHECK (resource_type IS NULL OR btrim(resource_type) <> '')
);

COMMENT ON TABLE public.support_cases
  IS 'Customer support/dispute cases projection (query-optimized). Immutable audit trail is support_case_events + support_messages.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_support_cases_org_idempotency
  ON public.support_cases (organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND btrim(idempotency_key) <> '';

CREATE INDEX IF NOT EXISTS idx_support_cases_org_status
  ON public.support_cases (organization_id, status, priority, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_support_cases_client_status
  ON public.support_cases (client_id, status, created_at DESC)
  WHERE client_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_support_cases_sender_status
  ON public.support_cases (sender_id, status, created_at DESC)
  WHERE sender_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_support_cases_resource
  ON public.support_cases (resource_type, resource_id)
  WHERE resource_type IS NOT NULL AND resource_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_support_cases_sla_due
  ON public.support_cases (organization_id, sla_due_at)
  WHERE sla_due_at IS NOT NULL;

-- FK supporting indexes (enterprise hygiene; non-partial).
CREATE INDEX IF NOT EXISTS idx_support_cases__sender_id__fk
  ON public.support_cases (sender_id);

CREATE INDEX IF NOT EXISTS idx_support_cases__assigned_to__fk
  ON public.support_cases (assigned_to);

CREATE OR REPLACE FUNCTION public.support_cases_enforce_org_match_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_client_org UUID;
  v_sender_org UUID;
  v_user_org UUID;
BEGIN
  IF NEW.organization_id IS NULL THEN
    RAISE EXCEPTION 'support_cases: organization_id is required' USING ERRCODE = '23502';
  END IF;

  IF NEW.client_id IS NOT NULL THEN
    SELECT c.organization_id INTO v_client_org
    FROM public.clients c
    WHERE c.id = NEW.client_id;

    IF v_client_org IS NULL THEN
      RAISE EXCEPTION 'support_cases: client % not found', NEW.client_id USING ERRCODE = '23503';
    END IF;

    IF v_client_org IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'support_cases: organization mismatch (case org %, client org %)', NEW.organization_id, v_client_org
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.sender_id IS NOT NULL THEN
    SELECT c.organization_id
      INTO v_sender_org
      FROM public.senders s
      JOIN public.clients c ON c.id = s.client_id
     WHERE s.id = NEW.sender_id;

    IF v_sender_org IS NULL THEN
      RAISE EXCEPTION 'support_cases: sender % not found', NEW.sender_id USING ERRCODE = '23503';
    END IF;

    IF v_sender_org IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'support_cases: organization mismatch (case org %, sender org %)', NEW.organization_id, v_sender_org
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.assigned_to IS NOT NULL THEN
    SELECT u.organization_id INTO v_user_org
    FROM public.users u
    WHERE u.id = NEW.assigned_to;

    IF v_user_org IS NULL THEN
      RAISE EXCEPTION 'support_cases: user % not found', NEW.assigned_to USING ERRCODE = '23503';
    END IF;

    IF v_user_org IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'support_cases: organization mismatch (case org %, user org %)', NEW.organization_id, v_user_org
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_support_cases_enforce_org_match ON public.support_cases;
CREATE TRIGGER trg_support_cases_enforce_org_match
  BEFORE INSERT OR UPDATE ON public.support_cases
  FOR EACH ROW
  EXECUTE FUNCTION public.support_cases_enforce_org_match_v1();

DROP TRIGGER IF EXISTS trg_support_cases_set_updated_at ON public.support_cases;
CREATE TRIGGER trg_support_cases_set_updated_at
  BEFORE UPDATE ON public.support_cases
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-------------------------------------------------------------------------------
-- 3) support_case_events ledger
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.support_case_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  support_case_id UUID NOT NULL REFERENCES public.support_cases(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  event_type TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,

  actor_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  actor_system TEXT,

  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key TEXT,
  case_version INT NOT NULL,

  decision_log_id UUID,
  settings_resolution_id UUID,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT support_case_events_event_type_ck CHECK (btrim(event_type) <> '' AND event_type = lower(event_type)),
  CONSTRAINT support_case_events_case_version_ck CHECK (case_version > 0)
);

COMMENT ON TABLE public.support_case_events
  IS 'Immutable support case event ledger (SSOT). Event trail is authoritative; support_cases is the projection.';

CREATE INDEX IF NOT EXISTS idx_support_case_events_case_created
  ON public.support_case_events (support_case_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_support_case_events_case_version
  ON public.support_case_events (support_case_id, case_version);

CREATE INDEX IF NOT EXISTS idx_support_case_events_org_created
  ON public.support_case_events (organization_id, created_at DESC);

-- FK supporting indexes (enterprise hygiene; non-partial).
CREATE INDEX IF NOT EXISTS idx_support_case_events__actor_user_id__fk
  ON public.support_case_events (actor_user_id);

-------------------------------------------------------------------------------
-- 4) support_messages ledger
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.support_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  support_case_id UUID NOT NULL REFERENCES public.support_cases(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  direction TEXT NOT NULL, -- lookup support_message_direction
  channel TEXT NOT NULL, -- lookup support_message_channel

  actor_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  actor_system TEXT,

  body TEXT,
  artifact_id UUID REFERENCES public.artifacts(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT support_messages_direction_ck CHECK (btrim(direction) <> '' AND direction = lower(direction)),
  CONSTRAINT support_messages_channel_ck CHECK (btrim(channel) <> '' AND channel = lower(channel))
);

COMMENT ON TABLE public.support_messages
  IS 'Immutable support messages ledger (SSOT). Use artifact_id or artifact_links for attachments.';

CREATE INDEX IF NOT EXISTS idx_support_messages_case_created
  ON public.support_messages (support_case_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_support_messages_org_created
  ON public.support_messages (organization_id, created_at DESC);

-- FK supporting indexes (enterprise hygiene; non-partial).
CREATE INDEX IF NOT EXISTS idx_support_messages__actor_user_id__fk
  ON public.support_messages (actor_user_id);

CREATE INDEX IF NOT EXISTS idx_support_messages__artifact_id__fk
  ON public.support_messages (artifact_id);

-------------------------------------------------------------------------------
-- 5) RLS + grants
-------------------------------------------------------------------------------

ALTER TABLE public.support_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_case_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_messages ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.support_cases FROM PUBLIC;
REVOKE ALL ON TABLE public.support_cases FROM anon;
REVOKE ALL ON TABLE public.support_cases FROM authenticated;

REVOKE ALL ON TABLE public.support_case_events FROM PUBLIC;
REVOKE ALL ON TABLE public.support_case_events FROM anon;
REVOKE ALL ON TABLE public.support_case_events FROM authenticated;

REVOKE ALL ON TABLE public.support_messages FROM PUBLIC;
REVOKE ALL ON TABLE public.support_messages FROM anon;
REVOKE ALL ON TABLE public.support_messages FROM authenticated;

DROP POLICY IF EXISTS support_cases_select ON public.support_cases;
CREATE POLICY support_cases_select ON public.support_cases
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
      AND client_id IS NOT NULL
      AND client_id = public.current_user_client_id()
    )
    OR (
      public.current_user_scope_type() = 'sender'
      AND sender_id IS NOT NULL
      AND sender_id = public.current_user_sender_id()
    )
  );

DROP POLICY IF EXISTS support_cases_service_policy ON public.support_cases;
CREATE POLICY support_cases_service_policy ON public.support_cases
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS support_case_events_select ON public.support_case_events;
CREATE POLICY support_case_events_select ON public.support_case_events
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
        FROM public.support_cases sc
        WHERE sc.id = support_case_events.support_case_id
          AND sc.client_id = public.current_user_client_id()
      )
    )
    OR (
      public.current_user_scope_type() = 'sender'
      AND EXISTS (
        SELECT 1
        FROM public.support_cases sc
        WHERE sc.id = support_case_events.support_case_id
          AND sc.sender_id = public.current_user_sender_id()
      )
    )
  );

DROP POLICY IF EXISTS support_case_events_service_policy ON public.support_case_events;
CREATE POLICY support_case_events_service_policy ON public.support_case_events
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS support_messages_select ON public.support_messages;
CREATE POLICY support_messages_select ON public.support_messages
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
        FROM public.support_cases sc
        WHERE sc.id = support_messages.support_case_id
          AND sc.client_id = public.current_user_client_id()
      )
    )
    OR (
      public.current_user_scope_type() = 'sender'
      AND EXISTS (
        SELECT 1
        FROM public.support_cases sc
        WHERE sc.id = support_messages.support_case_id
          AND sc.sender_id = public.current_user_sender_id()
      )
    )
  );

DROP POLICY IF EXISTS support_messages_service_policy ON public.support_messages;
CREATE POLICY support_messages_service_policy ON public.support_messages
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

GRANT SELECT ON public.support_cases TO authenticated;
GRANT SELECT ON public.support_case_events TO authenticated;
GRANT SELECT ON public.support_messages TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.support_cases TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.support_case_events TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.support_messages TO service_role;

-------------------------------------------------------------------------------
-- 6) Contracts: table_contracts + lookup_column_contracts
-------------------------------------------------------------------------------

INSERT INTO public.table_contracts (table_schema, table_name, created_at_required, updated_at_required, audit_enabled, notes)
VALUES
  ('public', 'support_cases', TRUE, TRUE, TRUE, 'Support/dispute case projection (CX + ops).'),
  ('public', 'support_case_events', TRUE, FALSE, FALSE, 'Support case event ledger (SSOT).'),
  ('public', 'support_messages', TRUE, FALSE, FALSE, 'Support messages ledger (SSOT).')
ON CONFLICT (table_schema, table_name) DO UPDATE
SET
  created_at_required = EXCLUDED.created_at_required,
  updated_at_required = EXCLUDED.updated_at_required,
  audit_enabled = EXCLUDED.audit_enabled,
  notes = EXCLUDED.notes,
  updated_at = now();

INSERT INTO public.lookup_column_contracts (table_schema, table_name, column_name, lookup_category)
VALUES
  ('public', 'support_cases', 'status', 'support_case_status'),
  ('public', 'support_cases', 'priority', 'support_case_priority'),
  ('public', 'support_messages', 'direction', 'support_message_direction'),
  ('public', 'support_messages', 'channel', 'support_message_channel')
ON CONFLICT (table_schema, table_name, column_name) DO UPDATE
SET lookup_category = EXCLUDED.lookup_category;

SELECT public.apply_lookup_column_contracts('public');

SELECT pg_advisory_unlock(hashtext('202601311720_support_cases_foundation_v1'));
COMMIT;

