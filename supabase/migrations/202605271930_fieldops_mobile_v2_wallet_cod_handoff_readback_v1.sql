-- Migration: FieldOps Mobile V2 wallet withdrawal + COD handoff readback
-- Purpose:
--   Surface wallet-withdraw requests back through resolve_fieldops_wallet_v1
--   and register the production Mobile V2 COD Ledger route in ui_navigation.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605271930_fieldops_mobile_v2_wallet_cod_handoff_readback_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.compute_fieldops_wallet_summary_v1(
  p_organization_id UUID,
  p_user_id UUID,
  p_currency TEXT DEFAULT 'SAR'
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_currency TEXT := upper(NULLIF(btrim(COALESCE(p_currency, 'SAR')), ''));
  v_ledger_balance NUMERIC := 0;
  v_pending_withdrawals NUMERIC := 0;
  v_week_to_date NUMERIC := 0;
  v_breakdown JSONB := '[]'::jsonb;
BEGIN
  IF p_organization_id IS NULL OR p_user_id IS NULL THEN
    RETURN jsonb_build_object(
      'ledger_balance_sar', 0,
      'pending_withdrawal_sar', 0,
      'available_sar', 0,
      'week_to_date_sar', 0,
      'breakdown', '[]'::jsonb
    );
  END IF;

  SELECT COALESCE(
           sum(CASE
             WHEN fe.direction = 'in' THEN fe.amount
             WHEN fe.direction = 'out' THEN -fe.amount
             ELSE 0
           END),
           0
         )
    INTO v_ledger_balance
    FROM public.finance_events fe
   WHERE fe.organization_id = p_organization_id
     AND fe.account_type = 'driver'
     AND fe.account_id = p_user_id
     AND upper(fe.currency) = v_currency;

  SELECT COALESCE(
           sum(CASE
             WHEN COALESCE(dl.decision_inputs->>'amount_sar', '') ~ '^-?[0-9]+(\.[0-9]+)?$'
               THEN (dl.decision_inputs->>'amount_sar')::numeric
             ELSE 0
           END),
           0
         )
    INTO v_pending_withdrawals
    FROM public.decision_log dl
   WHERE dl.organization_id = p_organization_id
     AND dl.decision_category = 'fieldops_wallet_withdraw'
     AND dl.performed_by_system = 'fieldops_mobile_v2'
     AND dl.decision_outcome = 'requested'
     AND dl.decision_inputs->>'actor_user_id' = p_user_id::text;

  SELECT COALESCE(
           sum(CASE WHEN fe.direction = 'in' THEN fe.amount ELSE 0 END),
           0
         )
    INTO v_week_to_date
    FROM public.finance_events fe
   WHERE fe.organization_id = p_organization_id
     AND fe.account_type = 'driver'
     AND fe.account_id = p_user_id
     AND upper(fe.currency) = v_currency
     AND fe.occurred_at >= date_trunc('week', now());

  SELECT COALESCE(
           jsonb_agg(
             jsonb_build_object(
               'id', 'finance-' || row.event_type,
               'label', initcap(replace(row.event_type, '_', ' ')),
               'meta', row.event_count::text || CASE WHEN row.event_count = 1 THEN ' event' ELSE ' events' END,
               'sar', round(row.amount_sar)::int
             )
             ORDER BY row.event_type
           ),
           '[]'::jsonb
         )
    INTO v_breakdown
    FROM (
      SELECT
        fe.event_type,
        count(*) AS event_count,
        sum(CASE
          WHEN fe.direction = 'in' THEN fe.amount
          WHEN fe.direction = 'out' THEN -fe.amount
          ELSE 0
        END) AS amount_sar
      FROM public.finance_events fe
      WHERE fe.organization_id = p_organization_id
        AND fe.account_type = 'driver'
        AND fe.account_id = p_user_id
        AND upper(fe.currency) = v_currency
        AND fe.occurred_at >= date_trunc('day', now())
      GROUP BY fe.event_type
    ) row;

  RETURN jsonb_build_object(
    'ledger_balance_sar', round(v_ledger_balance)::int,
    'pending_withdrawal_sar', round(v_pending_withdrawals)::int,
    'available_sar', greatest(0, round(v_ledger_balance - v_pending_withdrawals)::int),
    'week_to_date_sar', greatest(0, round(v_week_to_date)::int),
    'breakdown', v_breakdown
  );
END;
$$;

REVOKE ALL ON FUNCTION public.compute_fieldops_wallet_summary_v1(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.compute_fieldops_wallet_summary_v1(UUID, UUID, TEXT) TO service_role;

COMMENT ON FUNCTION public.compute_fieldops_wallet_summary_v1(UUID, UUID, TEXT) IS
  'Internal Mobile V2 wallet summary over canonical finance_events driver ledger minus pending fieldops_mobile_v2 wallet withdrawal decisions.';

CREATE OR REPLACE FUNCTION public.resolve_fieldops_wallet_v1(
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
  v_user_id UUID := auth.uid();
  v_org UUID;
  v_wallet_summary JSONB;
  v_latest_withdrawal JSONB := NULL;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'resolve_fieldops_wallet_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  v_org := public.current_user_org_id();
  IF v_org IS NULL THEN
    RETURN jsonb_build_object(
      'wallet', jsonb_build_object(
        'balance_sar', 0,
        'week_to_date_sar', 0,
        'posts_to_bank_label', 'Posts to bank Monday'
      ),
      'week', '[]'::jsonb,
      'breakdown', '[]'::jsonb,
      'latest_withdrawal', NULL
    );
  END IF;

  v_wallet_summary := public.compute_fieldops_wallet_summary_v1(v_org, v_user_id, 'SAR');

  SELECT jsonb_build_object(
           'decision_log_id', dl.id,
           'request_id', dl.resource_id,
           'state', dl.decision_outcome,
           'amount_sar', CASE
             WHEN COALESCE(dl.decision_inputs->>'amount_sar', '') ~ '^-?[0-9]+(\.[0-9]+)?$'
               THEN round((dl.decision_inputs->>'amount_sar')::numeric)::int
             ELSE 0
           END,
           'requested_at', dl.timestamp
         )
    INTO v_latest_withdrawal
    FROM public.decision_log dl
   WHERE dl.organization_id = v_org
     AND dl.decision_category = 'fieldops_wallet_withdraw'
     AND dl.performed_by_system = 'fieldops_mobile_v2'
     AND dl.decision_inputs->>'actor_user_id' = v_user_id::text
   ORDER BY dl.timestamp DESC, dl.id DESC
   LIMIT 1;

  RETURN jsonb_build_object(
    'wallet', jsonb_build_object(
      'balance_sar', COALESCE((v_wallet_summary->>'available_sar')::int, 0),
      'week_to_date_sar', COALESCE((v_wallet_summary->>'week_to_date_sar')::int, 0),
      'posts_to_bank_label', 'Posts to bank Monday'
    ),
    'week', '[]'::jsonb,
    'breakdown', COALESCE(v_wallet_summary->'breakdown', '[]'::jsonb),
    'latest_withdrawal', v_latest_withdrawal
  );
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_fieldops_wallet_v1(TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_fieldops_wallet_v1(TEXT, JSONB) TO authenticated, service_role;

COMMENT ON FUNCTION public.resolve_fieldops_wallet_v1(TEXT, JSONB) IS
  'Mobile V2 driver wallet envelope. Returns driver finance_events wallet availability plus latest same-driver wallet-withdraw request readback from decision_log.';

CREATE OR REPLACE FUNCTION api.resolve_fieldops_wallet_v1(
  p_active_role TEXT DEFAULT 'driver',
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $$ SELECT public.resolve_fieldops_wallet_v1(p_active_role, p_context); $$;

REVOKE ALL ON FUNCTION api.resolve_fieldops_wallet_v1(TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.resolve_fieldops_wallet_v1(TEXT, JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.request_fieldops_wallet_withdraw_v1(
  p_amount_sar INT,
  p_idempotency_key UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org UUID;
  v_existing UUID;
  v_existing_request_id UUID;
  v_decision_id UUID;
  v_request_id UUID := gen_random_uuid();
  v_wallet_summary JSONB;
  v_available_sar INT := 0;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'request_fieldops_wallet_withdraw_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;
  v_org := public.current_user_org_id();
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'request_fieldops_wallet_withdraw_v1 requires organization context' USING ERRCODE = '42501';
  END IF;
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'request_fieldops_wallet_withdraw_v1 requires idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF p_amount_sar IS NULL OR p_amount_sar <= 0 THEN
    RAISE EXCEPTION 'request_fieldops_wallet_withdraw_v1: amount_sar must be > 0' USING ERRCODE = '22023';
  END IF;

  v_existing := public.fieldops_v2_existing_decision_v1(v_org, 'fieldops_wallet_withdraw', p_idempotency_key);
  IF v_existing IS NOT NULL THEN
    SELECT dl.resource_id INTO v_existing_request_id
      FROM public.decision_log dl
     WHERE dl.id = v_existing
     LIMIT 1;

    RETURN jsonb_build_object(
      'decision_log_id', v_existing,
      'ok', TRUE,
      'state', 'replayed',
      'request_id', v_existing_request_id
    );
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('fieldops_wallet_withdraw:' || v_org::text || ':' || v_user_id::text));
  v_wallet_summary := public.compute_fieldops_wallet_summary_v1(v_org, v_user_id, 'SAR');
  v_available_sar := COALESCE((v_wallet_summary->>'available_sar')::int, 0);

  IF p_amount_sar > v_available_sar THEN
    RAISE EXCEPTION 'request_fieldops_wallet_withdraw_v1: amount_sar % exceeds available balance %', p_amount_sar, v_available_sar
      USING ERRCODE = '22023';
  END IF;

  v_decision_id := public.log_decision(
    p_organization_id     := v_org,
    p_decision_category   := 'fieldops_wallet_withdraw',
    p_resource_type       := 'wallet_withdraw',
    p_resource_id         := v_request_id,
    p_decision_point      := 'request_withdraw',
    p_decision_outcome    := 'requested',
    p_performed_by_system := 'fieldops_mobile_v2',
    p_correlation_id      := p_idempotency_key,
    p_decision_inputs     := jsonb_strip_nulls(jsonb_build_object(
                               'amount_sar',           p_amount_sar,
                               'available_sar_before', v_available_sar,
                               'actor_user_id',        v_user_id
                             )),
    p_decision_reason     := NULL,
    p_settings_resolution_id := NULL
  );

  RETURN jsonb_build_object(
    'decision_log_id', v_decision_id,
    'ok', TRUE,
    'state', 'requested',
    'request_id', v_request_id,
    'available_sar_before', v_available_sar
  );
END;
$$;

COMMENT ON FUNCTION public.request_fieldops_wallet_withdraw_v1(INT, UUID) IS
  'Mobile V2 driver wallet-withdraw request write. Validates amount > 0 and <= finance_events-backed available balance, idempotent on p_idempotency_key, returns request readback identifiers.';

REVOKE ALL ON FUNCTION public.request_fieldops_wallet_withdraw_v1(INT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_fieldops_wallet_withdraw_v1(INT, UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.request_fieldops_wallet_withdraw_v1(
  p_amount_sar INT,
  p_idempotency_key UUID
)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $$ SELECT public.request_fieldops_wallet_withdraw_v1(p_amount_sar, p_idempotency_key); $$;

REVOKE ALL ON FUNCTION api.request_fieldops_wallet_withdraw_v1(INT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.request_fieldops_wallet_withdraw_v1(INT, UUID) TO authenticated, service_role;

DO $$
DECLARE
  v_scope RECORD;
  v_current JSONB;
  v_sections JSONB;
  v_new_sections JSONB;
  v_section JSONB;
  v_items JSONB;
  v_new_items JSONB;
  v_item JSONB;
  v_changed BOOLEAN;
  v_inserted BOOLEAN;
  v_cod_ledger_item JSONB := jsonb_build_object(
    'id', 'mobile-cod-ledger',
    'label', 'COD Ledger',
    'href', '/mobile/cod-ledger',
    'capability', 'cash_drop.write',
    'icon', 'cash'
  );
BEGIN
  FOR v_scope IN
    SELECT s.scope_type,
           s.scope_id,
           s.settings_version_id,
           sv.version,
           sv.value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_navigation'
  LOOP
    v_current := COALESCE(v_scope.value, '{}'::jsonb);
    v_sections := COALESCE(v_current#>'{apps,mobile,sections}', '[]'::jsonb);
    v_new_sections := '[]'::jsonb;
    v_changed := FALSE;

    FOR v_section IN SELECT * FROM jsonb_array_elements(v_sections) LOOP
      IF v_section->>'id' = 'v2-network-ops' THEN
        v_items := COALESCE(v_section->'items', '[]'::jsonb);

        IF NOT EXISTS (
          SELECT 1
            FROM jsonb_array_elements(v_items) item
           WHERE item->>'id' = 'mobile-cod-ledger'
        ) THEN
          v_new_items := '[]'::jsonb;
          v_inserted := FALSE;

          FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
            v_new_items := v_new_items || jsonb_build_array(v_item);
            IF v_item->>'id' = 'mobile-cash-drop' THEN
              v_new_items := v_new_items || jsonb_build_array(v_cod_ledger_item);
              v_inserted := TRUE;
            END IF;
          END LOOP;

          IF NOT v_inserted THEN
            v_new_items := v_new_items || jsonb_build_array(v_cod_ledger_item);
          END IF;

          v_section := jsonb_set(v_section, '{items}', v_new_items, true);
          v_changed := TRUE;
        END IF;
      END IF;

      v_new_sections := v_new_sections || jsonb_build_array(v_section);
    END LOOP;

    IF v_changed THEN
      v_current := jsonb_set(v_current, '{apps,mobile,sections}', v_new_sections, true);

      UPDATE public.settings_versions sv
         SET value = v_current,
             version = v_scope.version + 1,
             change_reason = 'FieldOps Mobile V2: register COD Ledger money handoff route',
             approved_at = now(),
             effective_from = now()
       WHERE sv.id = v_scope.settings_version_id
         AND v_current IS DISTINCT FROM sv.value;

      UPDATE public.settings s
         SET cached_value = v_current,
             last_updated = now()
       WHERE s.category = 'ui_navigation'
         AND s.scope_type = v_scope.scope_type
         AND s.scope_id IS NOT DISTINCT FROM v_scope.scope_id
         AND s.settings_version_id = v_scope.settings_version_id
         AND v_current IS DISTINCT FROM s.cached_value;
    END IF;
  END LOOP;

  DELETE FROM public.settings_cache
   WHERE cache_key LIKE 'ui_navigation:%';
END $$;

SELECT pg_advisory_unlock(hashtext('202605271930_fieldops_mobile_v2_wallet_cod_handoff_readback_v1'));

COMMIT;
