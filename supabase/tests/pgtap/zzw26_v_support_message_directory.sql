-- pgTAP: public.v_support_message_directory projection contract (shape/RLS/projection)
-- Spec-Issue: W26 (paired projection views — SUPPORT)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(8);

-- 1) View exists
SELECT has_view(
  'public', 'v_support_message_directory',
  'public.v_support_message_directory view exists'
);

-- 2) View exposes the canonical FE-projection columns
SELECT columns_are(
  'public', 'v_support_message_directory',
  ARRAY[
    'id', 'support_case_id', 'organization_id',
    'direction', 'channel',
    'actor_user_id', 'actor_system',
    'body', 'artifact_id', 'metadata', 'created_at',
    'sent_at', 'author_user_id',
    'author_role', 'author_label',
    'has_artifact'
  ],
  'v_support_message_directory exposes FE-projection columns'
);

-- 3) Service-role baseline grant
SELECT ok(
  has_table_privilege('service_role', 'public.v_support_message_directory', 'SELECT'),
  'service_role has SELECT on v_support_message_directory'
);

-- 4) anon has no SELECT
SELECT ok(
  NOT has_table_privilege('anon', 'public.v_support_message_directory', 'SELECT'),
  'anon has no SELECT on v_support_message_directory'
);

-- 5) authenticated has SELECT (registry-driven hooks read through this seam)
SELECT ok(
  has_table_privilege('authenticated', 'public.v_support_message_directory', 'SELECT'),
  'authenticated has SELECT on v_support_message_directory'
);

-- 6) Underlying base table remains SSOT
SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'support_messages'
       AND c.relkind = 'r'  -- still a regular table
  ),
  'public.support_messages remains a base table (SSOT preserved)'
);

-- 7) Projection: insert messages with each direction × actor combination,
--    verify author_role + author_label resolve correctly.
DO $$
DECLARE
  v_org      UUID := '00000000-0000-0000-0000-00000026e001';
  v_client   UUID := '00000000-0000-0000-0000-00000026e002';
  v_user     UUID := '00000000-0000-0000-0000-00000026e003';
  v_case     UUID := '00000000-0000-0000-0000-00000026e004';
  v_msg_op   UUID := '00000000-0000-0000-0000-00000026e005';
  v_msg_cust UUID := '00000000-0000-0000-0000-00000026e006';
  v_msg_sys  UUID := '00000000-0000-0000-0000-00000026e007';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'W26 Msg Org', 'w26-msg-main')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.clients (
    id, organization_id, name, slug, sla_tier, status
  )
  VALUES (
    v_client, v_org, 'W26 Msg Client',
    'w26-msg-client',
    'standard', 'active'
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (
    id, organization_id, email, full_name, user_type, status
  )
  VALUES (
    v_user, v_org, 'w26-msg-u-' || left(v_user::text, 8) || '@example.com',
    'W26 Operator', 'ops_admin', 'active'
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.support_cases (
    id, organization_id, client_id, status, priority, opened_at
  )
  VALUES (
    v_case, v_org, v_client, 'open', 'medium',
    now() - INTERVAL '1 hour'
  )
  ON CONFLICT (id) DO NOTHING;

  -- Operator outbound message (actor_user_id present)
  INSERT INTO public.support_messages (
    id, support_case_id, organization_id,
    direction, channel, actor_user_id, body
  )
  VALUES (
    v_msg_op, v_case, v_org,
    'outbound', 'email', v_user, 'Hi, looking into this for you.'
  )
  ON CONFLICT (id) DO NOTHING;

  -- Customer inbound message (no actor_user_id)
  INSERT INTO public.support_messages (
    id, support_case_id, organization_id,
    direction, channel, body
  )
  VALUES (
    v_msg_cust, v_case, v_org,
    'inbound', 'email', 'Thanks, awaiting your reply.'
  )
  ON CONFLICT (id) DO NOTHING;

  -- System internal message (actor_system present, no actor_user_id)
  INSERT INTO public.support_messages (
    id, support_case_id, organization_id,
    direction, channel, actor_system, body
  )
  VALUES (
    v_msg_sys, v_case, v_org,
    'internal', 'internal', 'Workflow', 'SLA monitor: case past due.'
  )
  ON CONFLICT (id) DO NOTHING;

END;
$$;

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.v_support_message_directory op
    JOIN public.v_support_message_directory cust
      ON cust.id = '00000000-0000-0000-0000-00000026e006'::UUID
    JOIN public.v_support_message_directory sys
      ON sys.id = '00000000-0000-0000-0000-00000026e007'::UUID
    WHERE op.id = '00000000-0000-0000-0000-00000026e005'::UUID
      AND op.author_role = 'operator'
      AND op.author_label = 'W26 Operator'
      AND op.sent_at IS NOT NULL
      AND cust.author_role = 'customer'
      AND sys.author_role = 'system'
      AND sys.author_label = 'Workflow'
  ),
  'v_support_message_directory derives author_role + author_label + sent_at across operator/customer/system'
);

-- 8) has_artifact projection: a message with artifact_id set returns TRUE,
--    a message without returns FALSE.
DO $$
DECLARE
  v_org       UUID := '00000000-0000-0000-0000-00000026e011';
  v_client    UUID := '00000000-0000-0000-0000-00000026e012';
  v_case      UUID := '00000000-0000-0000-0000-00000026e013';
  v_msg_no    UUID := '00000000-0000-0000-0000-00000026e014';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'W26 Has-Artifact Org', 'w26-art-main')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.clients (
    id, organization_id, name, slug, sla_tier, status
  )
  VALUES (
    v_client, v_org, 'W26 Has-Artifact Client',
    'w26-art-client',
    'standard', 'active'
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.support_cases (
    id, organization_id, client_id, status, priority, opened_at
  )
  VALUES (
    v_case, v_org, v_client, 'open', 'medium',
    now() - INTERVAL '30 minutes'
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.support_messages (
    id, support_case_id, organization_id,
    direction, channel, body
  )
  VALUES (
    v_msg_no, v_case, v_org,
    'inbound', 'email', 'Plain message, no artifact'
  )
  ON CONFLICT (id) DO NOTHING;

END;
$$;

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.v_support_message_directory
    WHERE id = '00000000-0000-0000-0000-00000026e014'::UUID
      AND has_artifact = FALSE
  ),
  'v_support_message_directory.has_artifact resolves FALSE for messages without artifact_id'
);

SELECT * FROM finish();
ROLLBACK;
