BEGIN;
SELECT pg_advisory_lock(hashtext('202605051240_console_v2_finance_scope_lineage_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE VIEW public.v_settlement_batch_summary
WITH (security_invoker = true) AS
WITH global_threshold AS (
  SELECT COALESCE(
    (s.cached_value->'locking'->>'max_variance_amount')::NUMERIC,
    0
  ) AS max_variance_amount
  FROM public.settings s
  WHERE s.category = 'settlement_policy'
    AND s.scope_type = 'global'
    AND s.scope_id IS NULL
  LIMIT 1
),
batch_finance AS (
  SELECT
    sbfe.settlement_batch_id,
    SUM(CASE WHEN fe.direction = 'in'  THEN fe.amount ELSE 0 END) AS sum_in,
    SUM(CASE WHEN fe.direction = 'out' THEN fe.amount ELSE 0 END) AS sum_out,
    SUM(
      CASE
        WHEN fe.event_type = 'payout'
          OR (fe.metadata ? 'event' AND lower(fe.metadata->>'event') = 'remit')
        THEN fe.amount
        ELSE 0
      END
    ) AS sum_remit,
    SUM(fe.amount) AS sum_total
  FROM public.settlement_batch_finance_events sbfe
  JOIN public.finance_events fe
    ON fe.id = sbfe.finance_event_id
   AND fe.organization_id = sbfe.organization_id
   AND fe.occurred_at = sbfe.finance_occurred_at
  GROUP BY sbfe.settlement_batch_id
),
batch_posted AS (
  SELECT
    se.settlement_batch_id,
    MAX(se.created_at) AS posted_at
  FROM public.settlement_events se
  WHERE se.to_status = 'posted'
  GROUP BY se.settlement_batch_id
)
SELECT
  sb.id,
  sb.organization_id,
  sb.kind,
  sb.scope_type,
  sb.status,
  sb.window_start_at,
  sb.window_end_at,
  sb.created_at,
  sb.updated_at,
  COALESCE(
    NULLIF(btrim(COALESCE(sb.metadata->>'expected_amount', '')), '')::NUMERIC,
    bf.sum_in,
    0
  ) AS expected_amount,
  COALESCE(
    NULLIF(btrim(COALESCE(sb.metadata->>'collected_amount', '')), '')::NUMERIC,
    bf.sum_in,
    0
  ) AS collected_amount,
  COALESCE(bf.sum_remit, 0) AS remitted_amount,
  bp.posted_at,
  CASE
    WHEN ABS(
      COALESCE(
        NULLIF(btrim(COALESCE(sb.metadata->>'expected_amount', '')), '')::NUMERIC,
        bf.sum_in,
        0
      )
      -
      COALESCE(
        NULLIF(btrim(COALESCE(sb.metadata->>'collected_amount', '')), '')::NUMERIC,
        bf.sum_in,
        0
      )
    ) > COALESCE((SELECT max_variance_amount FROM global_threshold), 0)
    THEN TRUE
    ELSE FALSE
  END AS variance_flag,
  sb.branch_id,
  sb.client_id,
  sb.sender_id,
  sb.subject_type,
  sb.subject_id,
  COALESCE(
    NULLIF(sb.metadata->>'partner_id', ''),
    CASE WHEN sb.subject_type = 'partner' THEN sb.subject_id::text ELSE NULL END
  ) AS partner_id,
  COALESCE(NULLIF(sb.metadata->>'participant_id', ''), NULLIF(sb.metadata->>'partner_id', '')) AS participant_id,
  COALESCE(NULLIF(sb.metadata->>'supplier_participant_profile_id', ''), NULLIF(sb.metadata->>'partner_id', '')) AS supplier_participant_profile_id
FROM public.settlement_batches sb
LEFT JOIN batch_finance bf ON bf.settlement_batch_id = sb.id
LEFT JOIN batch_posted bp ON bp.settlement_batch_id = sb.id;

REVOKE ALL ON public.v_settlement_batch_summary FROM PUBLIC;
REVOKE ALL ON public.v_settlement_batch_summary FROM anon;
GRANT SELECT ON public.v_settlement_batch_summary TO authenticated, service_role;

CREATE OR REPLACE VIEW public.finance_events_ledger
WITH (security_invoker = true) AS
SELECT
  fe.*,
  sb.id AS settlement_batch_id,
  sb.client_id,
  sb.sender_id,
  COALESCE(
    NULLIF(sb.metadata->>'partner_id', ''),
    CASE WHEN sb.subject_type = 'partner' THEN sb.subject_id::text ELSE NULL END
  ) AS partner_id,
  COALESCE(NULLIF(sb.metadata->>'participant_id', ''), NULLIF(sb.metadata->>'partner_id', '')) AS participant_id,
  COALESCE(NULLIF(sb.metadata->>'supplier_participant_profile_id', ''), NULLIF(sb.metadata->>'partner_id', '')) AS supplier_participant_profile_id
FROM public.finance_events fe
LEFT JOIN public.settlement_batch_finance_events sbfe
  ON sbfe.finance_event_id = fe.id
 AND sbfe.organization_id = fe.organization_id
 AND sbfe.finance_occurred_at = fe.occurred_at
LEFT JOIN public.settlement_batches sb
  ON sb.id = sbfe.settlement_batch_id
 AND sb.organization_id = sbfe.organization_id;

REVOKE ALL ON public.finance_events_ledger FROM PUBLIC;
REVOKE ALL ON public.finance_events_ledger FROM anon;
GRANT SELECT ON public.finance_events_ledger TO authenticated, service_role;

CREATE OR REPLACE VIEW public.v_dispute_directory
WITH (security_invoker = true) AS
SELECT
  d.id                AS dispute_id,
  d.id                AS id,
  d.created_at,
  d.updated_at,
  d.request_id,
  d.contract_id,
  d.work_package_id,
  d.opened_by_organization_id,
  d.counterparty_organization_id,
  d.opened_by_user_id,
  d.resolved_by_user_id,
  d.status,
  d.category,
  d.title,
  d.description,
  d.resolution,
  d.resolved_at,
  d.metadata,
  o_open.name        AS opened_by_label,
  o_cpty.name        AS counterparty_label,
  u_open.full_name   AS opened_by_user_label,
  u_resv.full_name   AS resolved_by_user_label,
  mc.status          AS contract_status,
  mwp.status         AS work_package_status,
  mr.title           AS request_label,
  NULLIF(d.metadata->>'shipment_ref', '')                AS shipment_ref,
  COALESCE(NULLIF(d.metadata->>'amount_sar', ''), '0')::NUMERIC AS amount_sar,
  COALESCE(NULLIF(d.metadata->>'escalation_count', ''), '0')::INT AS escalation_count,
  NULLIF(d.metadata->>'escalation_at', '')::TIMESTAMPTZ  AS escalation_at,
  (COALESCE(NULLIF(d.metadata->>'escalation_count', ''), '0')::INT > 0) AS is_escalated,
  (d.status IN ('resolved', 'rejected')) AS is_terminal,
  GREATEST(0, EXTRACT(EPOCH FROM (now() - d.created_at)))::BIGINT AS age_seconds,
  GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - d.created_at)) / 3600))::INT AS age_hours,
  sh.client_id AS client_id,
  sh.client_id AS shipment_client_id,
  mc.supplier_participant_profile_id::text AS partner_id,
  mc.supplier_participant_profile_id::text AS participant_id,
  mc.supplier_participant_profile_id::text AS supplier_participant_profile_id
FROM public.marketplace_disputes d
LEFT JOIN public.organizations o_open ON o_open.id = d.opened_by_organization_id
LEFT JOIN public.organizations o_cpty ON o_cpty.id = d.counterparty_organization_id
LEFT JOIN public.users u_open         ON u_open.id = d.opened_by_user_id
LEFT JOIN public.users u_resv         ON u_resv.id = d.resolved_by_user_id
LEFT JOIN public.marketplace_contracts    mc  ON mc.id = d.contract_id
LEFT JOIN public.marketplace_work_packages mwp ON mwp.id = d.work_package_id
LEFT JOIN public.marketplace_requests      mr ON mr.id = d.request_id
LEFT JOIN public.shipments sh
  ON (
    sh.tracking_number = NULLIF(d.metadata->>'shipment_ref', '')
    OR sh.client_reference_number = NULLIF(d.metadata->>'shipment_ref', '')
    OR sh.id::text = NULLIF(d.metadata->>'shipment_ref', '')
  )
 AND sh.organization_id = COALESCE(
    mc.requester_organization_id,
    mwp.requester_organization_id,
    mr.requester_organization_id,
    d.counterparty_organization_id
  );

REVOKE ALL ON public.v_dispute_directory FROM PUBLIC;
REVOKE ALL ON public.v_dispute_directory FROM anon;
GRANT SELECT ON public.v_dispute_directory TO authenticated, service_role;

DO $do$
DECLARE
  v_settings_version_id UUID;
  v_current JSONB;
  v_resource JSONB;
  v_next JSONB := '[]'::jsonb;
  v_seen_dispute_directory BOOLEAN := FALSE;
BEGIN
  SELECT s.settings_version_id, COALESCE(s.cached_value, '{"resources":[]}'::jsonb)
    INTO v_settings_version_id, v_current
    FROM public.settings s
   WHERE s.category = 'ui_read_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_settings_version_id IS NULL THEN
    RAISE EXCEPTION 'ui_read_registry global settings missing';
  END IF;

  FOR v_resource IN
    SELECT value FROM jsonb_array_elements(COALESCE(v_current->'resources', '[]'::jsonb)) AS value
  LOOP
    IF v_resource->>'key' = 'settlement_batches' THEN
      v_resource := jsonb_set(
        v_resource,
        '{filters}',
        '[
          {"key":"status","column":"status","op":"eq"},
          {"key":"kind","column":"kind","op":"eq"},
          {"key":"client_id","column":"client_id","op":"eq"},
          {"key":"sender_id","column":"sender_id","op":"eq"},
          {"key":"subject_type","column":"subject_type","op":"eq"},
          {"key":"subject_id","column":"subject_id","op":"eq"}
        ]'::jsonb,
        true
      );
    ELSIF v_resource->>'key' = 'settlement_batch_summary' THEN
      v_resource := jsonb_set(
        v_resource,
        '{filters}',
        '[
          {"key":"status","column":"status","op":"eq"},
          {"key":"kind","column":"kind","op":"eq"},
          {"key":"client_id","column":"client_id","op":"eq"},
          {"key":"sender_id","column":"sender_id","op":"eq"},
          {"key":"subject_type","column":"subject_type","op":"eq"},
          {"key":"subject_id","column":"subject_id","op":"eq"},
          {"key":"partner_id","column":"partner_id","op":"eq"},
          {"key":"participant_id","column":"participant_id","op":"eq"},
          {"key":"supplier_participant_profile_id","column":"supplier_participant_profile_id","op":"eq"}
        ]'::jsonb,
        true
      );
    ELSIF v_resource->>'key' = 'finance_events_ledger' THEN
      v_resource := jsonb_set(
        v_resource,
        '{filters}',
        '[
          {"key":"event_type","column":"event_type","op":"eq"},
          {"key":"direction","column":"direction","op":"eq"},
          {"key":"settlement_batch_id","column":"settlement_batch_id","op":"eq"},
          {"key":"client_id","column":"client_id","op":"eq"},
          {"key":"sender_id","column":"sender_id","op":"eq"},
          {"key":"subject_type","column":"subject_type","op":"eq"},
          {"key":"subject_id","column":"subject_id","op":"eq"},
          {"key":"partner_id","column":"partner_id","op":"eq"},
          {"key":"participant_id","column":"participant_id","op":"eq"},
          {"key":"supplier_participant_profile_id","column":"supplier_participant_profile_id","op":"eq"}
        ]'::jsonb,
        true
      );
    ELSIF v_resource->>'key' = 'marketplace_disputes' THEN
      v_resource := jsonb_set(v_resource, '{capability_read}', '"disputes.read"'::jsonb, true);
      v_resource := jsonb_set(v_resource, '{capability_write}', '"disputes.write"'::jsonb, true);
    ELSIF v_resource->>'key' = 'dispute_directory' THEN
      v_seen_dispute_directory := TRUE;
      v_resource := jsonb_set(v_resource, '{capability_read}', '"disputes.read"'::jsonb, true);
      v_resource := jsonb_set(
        v_resource,
        '{filters}',
        '[
          {"key":"status","column":"status","op":"eq"},
          {"key":"category","column":"category","op":"eq"},
          {"key":"client_id","column":"client_id","op":"eq"},
          {"key":"partner_id","column":"partner_id","op":"eq"},
          {"key":"participant_id","column":"participant_id","op":"eq"},
          {"key":"supplier_participant_profile_id","column":"supplier_participant_profile_id","op":"eq"}
        ]'::jsonb,
        true
      );
    END IF;
    v_next := v_next || jsonb_build_array(v_resource);
  END LOOP;

  IF NOT v_seen_dispute_directory THEN
    v_next := v_next || jsonb_build_array(
      '{
        "key":"dispute_directory",
        "relation":"public.v_dispute_directory",
        "id_column":"id",
        "capability_read":"disputes.read",
        "default_sort":{"column":"created_at","direction":"desc"},
        "filters":[
          {"key":"status","column":"status","op":"eq"},
          {"key":"category","column":"category","op":"eq"},
          {"key":"client_id","column":"client_id","op":"eq"},
          {"key":"partner_id","column":"partner_id","op":"eq"},
          {"key":"participant_id","column":"participant_id","op":"eq"},
          {"key":"supplier_participant_profile_id","column":"supplier_participant_profile_id","op":"eq"}
        ]
      }'::jsonb
    );
  END IF;

  v_current := jsonb_set(v_current, '{resources}', v_next, true);

  UPDATE public.settings_versions
     SET value = v_current,
         updated_at = now()
   WHERE id = v_settings_version_id;

  UPDATE public.settings
     SET cached_value = v_current,
         last_updated = now()
   WHERE settings_version_id = v_settings_version_id;
END;
$do$;

DO $do$
DECLARE
  v_global_resources JSONB;
  v_setting RECORD;
  v_current JSONB;
  v_resource JSONB;
  v_required_key TEXT;
  v_required_keys TEXT[] := ARRAY[
    'settlement_batches',
    'settlement_batch_summary',
    'finance_events_ledger',
    'marketplace_disputes',
    'dispute_directory'
  ];
BEGIN
  SELECT COALESCE(s.cached_value->'resources', '[]'::jsonb)
    INTO v_global_resources
    FROM public.settings s
   WHERE s.category = 'ui_read_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_global_resources IS NULL THEN
    RAISE EXCEPTION 'ui_read_registry global resources missing after finance scope repair';
  END IF;

  FOR v_setting IN
    SELECT s.id AS setting_id,
           s.settings_version_id,
           COALESCE(s.cached_value, '{"resources":[]}'::jsonb) AS cached_value
      FROM public.settings s
     WHERE s.category = 'ui_read_registry'
       AND NOT (s.scope_type = 'global' AND s.scope_id IS NULL)
  LOOP
    v_current := v_setting.cached_value;

    FOREACH v_required_key IN ARRAY v_required_keys LOOP
      SELECT value
        INTO v_resource
        FROM jsonb_array_elements(v_global_resources) AS value
       WHERE value->>'key' = v_required_key
       LIMIT 1;

      IF v_resource IS NULL THEN
        RAISE EXCEPTION 'required ui_read_registry resource % missing from global registry', v_required_key;
      END IF;

      SELECT jsonb_set(
               v_current,
               '{resources}',
               COALESCE(jsonb_agg(value), '[]'::jsonb),
               true
             )
        INTO v_current
        FROM jsonb_array_elements(COALESCE(v_current->'resources', '[]'::jsonb)) AS value
       WHERE value->>'key' <> v_required_key;

      v_current := jsonb_set(
        v_current,
        '{resources}',
        COALESCE(v_current->'resources', '[]'::jsonb) || jsonb_build_array(v_resource),
        true
      );
    END LOOP;

    UPDATE public.settings_versions
       SET value = v_current,
           updated_at = now()
     WHERE id = v_setting.settings_version_id;

    UPDATE public.settings
       SET cached_value = v_current,
           last_updated = now()
     WHERE id = v_setting.setting_id;
  END LOOP;
END;
$do$;

COMMENT ON VIEW public.finance_events_ledger IS
  'Console V2 read projection over immutable finance_events ledger with settlement/client/partner lineage for scoped finance drill-ins. Read-only; SSOT remains public.finance_events.';
COMMENT ON VIEW public.v_dispute_directory IS
  'Console V2 dispute directory with shipment/client and contract/partner lineage for scoped dispute drill-ins. Read-only; SSOT remains marketplace_disputes.';

SELECT pg_advisory_unlock(hashtext('202605051240_console_v2_finance_scope_lineage_v1'));
COMMIT;
