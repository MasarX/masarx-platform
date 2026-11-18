-- pgTAP: public.v_dispute_directory projection contract (shape/RLS/projection)
-- Spec-Issue: W25 (paired projection views — FINANCE)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(8);

-- 1) View exists
SELECT has_view(
  'public', 'v_dispute_directory',
  'public.v_dispute_directory view exists'
);

-- 2) View exposes the canonical FE-projection columns
SELECT columns_are(
  'public', 'v_dispute_directory',
  ARRAY[
    'dispute_id', 'id', 'created_at', 'updated_at',
    'request_id', 'contract_id', 'work_package_id',
    'opened_by_organization_id', 'counterparty_organization_id',
    'opened_by_user_id', 'resolved_by_user_id',
    'status', 'category', 'title', 'description',
    'resolution', 'resolved_at', 'metadata',
    'opened_by_label', 'counterparty_label',
    'opened_by_user_label', 'resolved_by_user_label',
    'contract_status', 'work_package_status', 'request_label',
    'client_id', 'shipment_client_id', 'participant_id', 'partner_id',
    'supplier_participant_profile_id',
    'shipment_ref', 'amount_sar',
    'escalation_count', 'escalation_at',
    'is_escalated', 'is_terminal',
    'age_seconds', 'age_hours'
  ],
  'v_dispute_directory exposes FE-projection columns'
);

-- 3) Service-role baseline grant
SELECT ok(
  has_table_privilege('service_role', 'public.v_dispute_directory', 'SELECT'),
  'service_role has SELECT on v_dispute_directory'
);

-- 4) anon has no SELECT
SELECT ok(
  NOT has_table_privilege('anon', 'public.v_dispute_directory', 'SELECT'),
  'anon has no SELECT on v_dispute_directory'
);

-- 5) authenticated has SELECT (registry-driven hooks read through this seam)
SELECT ok(
  has_table_privilege('authenticated', 'public.v_dispute_directory', 'SELECT'),
  'authenticated has SELECT on v_dispute_directory'
);

-- 6) Underlying base table remains SSOT
SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'marketplace_disputes'
       AND c.relkind = 'r'  -- still a regular table
  ),
  'public.marketplace_disputes remains a base table (SSOT preserved)'
);

-- 7) Projection: insert a dispute, verify metadata + label projections.
DO $$
DECLARE
  v_org_open  UUID := '00000000-0000-0000-0000-00000025d001';
  v_org_cpty  UUID := '00000000-0000-0000-0000-00000025d002';
  v_dispute   UUID := '00000000-0000-0000-0000-00000025d003';
  v_open_label TEXT;
  v_cpty_label TEXT;
  v_shipment   TEXT;
  v_amount     NUMERIC;
  v_terminal   BOOLEAN;
  v_escalated  BOOLEAN;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.organizations (id, name, slug)
  VALUES
    (v_org_open, 'W25 Opener Org', 'w25-d-opener'),
    (v_org_cpty, 'W25 Counterparty Org', 'w25-d-counterparty')
  ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name,
      slug = EXCLUDED.slug;

  INSERT INTO public.marketplace_disputes (
    id, opened_by_organization_id, counterparty_organization_id,
    status, category, title, description, metadata
  )
  VALUES (
    v_dispute,
    v_org_open,
    v_org_cpty,
    'under_review',
    'commercial',
    'W25 Test Dispute',
    'pgTAP fixture',
    jsonb_build_object('shipment_ref', 'SHP-W25-1', 'amount_sar', 480)
  )
  ON CONFLICT (id) DO UPDATE
  SET opened_by_organization_id = EXCLUDED.opened_by_organization_id,
      counterparty_organization_id = EXCLUDED.counterparty_organization_id,
      status = EXCLUDED.status,
      category = EXCLUDED.category,
      title = EXCLUDED.title,
      description = EXCLUDED.description,
      metadata = EXCLUDED.metadata,
      resolution = NULL,
      resolved_at = NULL,
      resolved_by_user_id = NULL,
      updated_at = now();

  SELECT opened_by_label, counterparty_label, shipment_ref, amount_sar, is_terminal, is_escalated
    INTO v_open_label, v_cpty_label, v_shipment, v_amount, v_terminal, v_escalated
    FROM public.v_dispute_directory
   WHERE dispute_id = v_dispute;

  PERFORM ok(
    v_open_label = 'W25 Opener Org'
      AND v_cpty_label = 'W25 Counterparty Org'
      AND v_shipment = 'SHP-W25-1'
      AND v_amount = 480
      AND v_terminal = FALSE
      AND v_escalated = FALSE,
    'v_dispute_directory derives opened_by_label + counterparty_label + shipment_ref + amount_sar + state flags'
  );
END;
$$;

-- 8) Terminal + escalation flags: resolved dispute with escalation_count > 0.
DO $$
DECLARE
  v_org_open  UUID := '00000000-0000-0000-0000-00000025d011';
  v_org_cpty  UUID := '00000000-0000-0000-0000-00000025d012';
  v_dispute   UUID := '00000000-0000-0000-0000-00000025d013';
  v_terminal  BOOLEAN;
  v_escalated BOOLEAN;
  v_count     INT;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.organizations (id, name, slug)
  VALUES
    (v_org_open, 'W25 Open Org T', 'w25-dt-opener'),
    (v_org_cpty, 'W25 Cpty Org T', 'w25-dt-counterparty')
  ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name,
      slug = EXCLUDED.slug;

  INSERT INTO public.marketplace_disputes (
    id, opened_by_organization_id, counterparty_organization_id,
    status, category, title, resolution, metadata
  )
  VALUES (
    v_dispute,
    v_org_open,
    v_org_cpty,
    'resolved',
    'commercial',
    'W25 Resolved Dispute',
    'credit',
    jsonb_build_object(
      'escalation_count', 2,
      'escalation_at', '2026-04-25T10:00:00Z'
    )
  )
  ON CONFLICT (id) DO UPDATE
  SET opened_by_organization_id = EXCLUDED.opened_by_organization_id,
      counterparty_organization_id = EXCLUDED.counterparty_organization_id,
      status = EXCLUDED.status,
      category = EXCLUDED.category,
      title = EXCLUDED.title,
      resolution = EXCLUDED.resolution,
      metadata = EXCLUDED.metadata,
      resolved_at = NULL,
      resolved_by_user_id = NULL,
      updated_at = now();

  SELECT is_terminal, is_escalated, escalation_count
    INTO v_terminal, v_escalated, v_count
    FROM public.v_dispute_directory
   WHERE dispute_id = v_dispute;

  PERFORM ok(
    v_terminal = TRUE AND v_escalated = TRUE AND v_count = 2,
    'v_dispute_directory.is_terminal/is_escalated/escalation_count for resolved+escalated dispute'
  );
END;
$$;

SELECT * FROM finish();
ROLLBACK;
