-- pgTAP: public.v_support_case_directory projection contract (shape/RLS/projection)
-- Spec-Issue: W26 (paired projection views — SUPPORT)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(9);

-- 1) View exists
SELECT has_view(
  'public', 'v_support_case_directory',
  'public.v_support_case_directory view exists'
);

-- 2) View exposes the canonical FE-projection columns
SELECT columns_are(
  'public', 'v_support_case_directory',
  ARRAY[
    'id', 'organization_id', 'client_id', 'sender_id',
    'resource_type', 'resource_id',
    'recipient_id', 'related_shipment_id',
    'status', 'status_reason', 'priority',
    'subject', 'channel', 'tags',
    'assigned_to', 'assigned_at',
    'sla_minutes', 'sla_due_at',
    'opened_at', 'resolved_at', 'closed_at',
    'idempotency_key', 'version', 'metadata',
    'created_at', 'updated_at',
    'client_label', 'client_slug',
    'sender_label', 'sender_brand_label',
    'recipient_label', 'recipient_phone',
    'shipment_tracking_number',
    'assignee_label',
    'last_message_at', 'message_count', 'sla_breached',
    'age_seconds', 'age_hours',
    'is_open', 'is_terminal', 'resolution_label'
  ],
  'v_support_case_directory exposes FE-projection columns'
);

-- 3) Service-role baseline grant
SELECT ok(
  has_table_privilege('service_role', 'public.v_support_case_directory', 'SELECT'),
  'service_role has SELECT on v_support_case_directory'
);

-- 4) anon has no SELECT
SELECT ok(
  NOT has_table_privilege('anon', 'public.v_support_case_directory', 'SELECT'),
  'anon has no SELECT on v_support_case_directory'
);

-- 5) authenticated has SELECT (registry-driven hooks read through this seam)
SELECT ok(
  has_table_privilege('authenticated', 'public.v_support_case_directory', 'SELECT'),
  'authenticated has SELECT on v_support_case_directory'
);

-- 6) Underlying base table remains SSOT
SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'support_cases'
       AND c.relkind = 'r'  -- still a regular table
  ),
  'public.support_cases remains a base table (SSOT preserved)'
);

-- 7) Projection: insert a case + client + assigned user, verify label/age/status projections.
DO $$
DECLARE
  v_org      UUID := '00000000-0000-0000-0000-00000026f001';
  v_client   UUID := '00000000-0000-0000-0000-00000026f002';
  v_user     UUID := '00000000-0000-0000-0000-00000026f003';
  v_case     UUID := '00000000-0000-0000-0000-00000026f004';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'W26 Support Org', 'w26-sp-main')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.clients (
    id, organization_id, name, slug, sla_tier, status
  )
  VALUES (
    v_client, v_org, 'W26 Support Client',
    'w26-sp-client',
    'standard', 'active'
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (
    id, organization_id, email, full_name, user_type, status
  )
  VALUES (
    v_user, v_org, 'w26-sp-u-' || left(v_user::text, 8) || '@example.com',
    'W26 Support Agent', 'ops_admin', 'active'
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.support_cases (
    id, organization_id, client_id, status, priority,
    subject, channel, tags, assigned_to,
    opened_at, sla_due_at
  )
  VALUES (
    v_case, v_org, v_client, 'open', 'high',
    'W26 projection check subject', 'email',
    ARRAY['p1', 'pgtap']::TEXT[], v_user,
    now() - INTERVAL '2 hours',
    now() + INTERVAL '4 hours'
  )
  ON CONFLICT (id) DO NOTHING;
END;
$$;

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.v_support_case_directory
    WHERE id = '00000000-0000-0000-0000-00000026f004'::UUID
      AND client_label = 'W26 Support Client'
      AND client_slug = 'w26-sp-client'
      AND assignee_label = 'W26 Support Agent'
      AND is_open = TRUE
      AND is_terminal = FALSE
      AND age_seconds >= 7000
      AND subject = 'W26 projection check subject'
      AND channel = 'email'
      AND message_count = 0
  ),
  'v_support_case_directory derives client_label + slug + assignee_label + is_open/is_terminal + age_seconds + subject + channel + message_count'
);

UPDATE public.support_cases
SET status_reason = 'resolved'
WHERE id = '00000000-0000-0000-0000-00000026f004'::UUID;

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.v_support_case_directory
    WHERE id = '00000000-0000-0000-0000-00000026f004'::UUID
      AND is_open = TRUE
      AND is_terminal = FALSE
      AND resolution_label IS NULL
  ),
  'v_support_case_directory hides stale status_reason resolution labels for reopened/open cases'
);

-- 8) Polymorphic resource projection: shipment-typed case resolves
--    `related_shipment_id` and `shipment_tracking_number`; recipient-typed case
--    resolves `recipient_id` + `recipient_label` + `recipient_phone`.
DO $$
DECLARE
  v_org       UUID := '00000000-0000-0000-0000-00000026f011';
  v_client    UUID := '00000000-0000-0000-0000-00000026f012';
  v_recipient UUID := '00000000-0000-0000-0000-00000026f013';
  v_case_rcp  UUID := '00000000-0000-0000-0000-00000026f014';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'W26 Polymorphic Org', 'w26-poly-main')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.clients (
    id, organization_id, name, slug, sla_tier, status
  )
  VALUES (
    v_client, v_org, 'W26 Polymorphic Client',
    'w26-poly-client',
    'standard', 'active'
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.recipients (
    id, organization_id, client_id, name, phone_number, preferred_language
  )
  VALUES (
    v_recipient, v_org, v_client,
    'W26 Recipient', '+966500000026', 'en'
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.support_cases (
    id, organization_id, client_id,
    resource_type, resource_id,
    status, status_reason, priority,
    subject, channel, opened_at
  )
  VALUES (
    v_case_rcp, v_org, v_client,
    'recipient', v_recipient,
    'resolved', 'compensation_issued', 'medium',
    'W26 polymorphic recipient case', 'whatsapp',
    now() - INTERVAL '1 day'
  )
  ON CONFLICT (id) DO NOTHING;
END;
$$;

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.v_support_case_directory
    WHERE id = '00000000-0000-0000-0000-00000026f014'::UUID
      AND recipient_id = '00000000-0000-0000-0000-00000026f013'::UUID
      AND recipient_label = 'W26 Recipient'
      AND recipient_phone = '+966500000026'
      AND resolution_label = 'compensation_issued'
  ),
  'v_support_case_directory polymorphic recipient: recipient_id + recipient_label + recipient_phone + resolution_label projections resolve correctly'
);

SELECT * FROM finish();
ROLLBACK;
