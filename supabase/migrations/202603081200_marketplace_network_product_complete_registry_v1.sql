-- Plan: PLAN-202603-marketplace-network-product-complete / Step: S04
-- Migration: Marketplace network product-complete registry and helper extensions

BEGIN;
SELECT pg_advisory_lock(hashtext('202603081200_marketplace_network_product_complete_registry_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Registry, lookup, schema, and constraint extensions
-------------------------------------------------------------------------------

INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  description,
  sort_order,
  is_default,
  metadata
)
SELECT
  ld.id,
  'marketplace_contract',
  'Marketplace contract',
  'Settlement batch scoped to a marketplace contract/work package.',
  90,
  FALSE,
  '{}'::jsonb
FROM public.lookup_definitions ld
WHERE ld.category = 'settlement_scope_type'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  metadata = EXCLUDED.metadata;

INSERT INTO public.marketplace_registry_entries (
  registry_type,
  entry_key,
  label,
  description,
  sort_order,
  is_default,
  is_active,
  config
)
VALUES
  (
    'settlement_mode',
    'auto_recorded_internal',
    'Auto recorded internal',
    'Automatically records finance and settlement batches internally after completion.',
    20,
    FALSE,
    TRUE,
    jsonb_build_object(
      'auto_finalize_on_completion', TRUE,
      'external_payout_mode', 'disabled'
    )
  ),
  (
    'materializer',
    'driver_shift_auto_bridge',
    'Driver shift auto bridge',
    'Auto-materializes freelancer driver shifts into contract-scoped execution references.',
    40,
    FALSE,
    TRUE,
    jsonb_build_object(
      'execution_target', 'driver_shift_marketplace',
      'auto_materialize_on_provider_accept', TRUE
    )
  ),
  (
    'materializer',
    'capacity_block_auto_bridge',
    'Capacity block auto bridge',
    'Auto-materializes tenant capacity blocks into contract-scoped execution references.',
    50,
    FALSE,
    TRUE,
    jsonb_build_object(
      'execution_target', 'capacity_block_marketplace',
      'auto_materialize_on_provider_accept', TRUE
    )
  ),
  (
    'materializer',
    'shipment_batch_auto_bridge',
    'Shipment batch auto bridge',
    'Auto-materializes shipment batches into contract-scoped execution references.',
    60,
    FALSE,
    TRUE,
    jsonb_build_object(
      'execution_target', 'shipment_batch_marketplace',
      'auto_materialize_on_provider_accept', TRUE
    )
  )
ON CONFLICT (registry_type, entry_key) DO UPDATE
SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  is_default = EXCLUDED.is_default,
  is_active = EXCLUDED.is_active,
  config = EXCLUDED.config,
  updated_at = now();

UPDATE public.marketplace_registry_entries
   SET is_default = CASE
     WHEN registry_type = 'settlement_mode' AND entry_key = 'auto_recorded_internal' THEN TRUE
     WHEN registry_type = 'settlement_mode' THEN FALSE
     ELSE is_default
   END,
       updated_at = now()
 WHERE registry_type = 'settlement_mode';

INSERT INTO public.schema_registry (
  category,
  version,
  schema,
  description,
  examples,
  is_active
)
VALUES
  (
    'marketplace_request_payload_shipment_batch',
    1,
    jsonb_build_object(
      '$schema', 'http://json-schema.org/draft-07/schema#',
      'type', 'object',
      'additionalProperties', TRUE,
      'required', jsonb_build_array('service_date', 'shipment_count', 'pickup_city'),
      'properties', jsonb_build_object(
        'service_date', jsonb_build_object('type', 'string', 'format', 'date'),
        'pickup_city', jsonb_build_object('type', 'string'),
        'dropoff_city', jsonb_build_object('type', 'string'),
        'shipment_count', jsonb_build_object('type', 'integer', 'minimum', 1),
        'service_level', jsonb_build_object('type', 'string'),
        'required_capabilities', jsonb_build_object(
          'type', 'array',
          'items', jsonb_build_object('type', 'string')
        ),
        'pricing_guidance', jsonb_build_object('type', 'object', 'additionalProperties', TRUE)
      )
    ),
    'Schema-driven payload for shipment-batch marketplace requests.',
    jsonb_build_array(
      jsonb_build_object(
        'service_date', '2026-03-09',
        'pickup_city', 'Riyadh',
        'dropoff_city', 'Riyadh',
        'shipment_count', 64,
        'service_level', 'same_day',
        'required_capabilities', jsonb_build_array('fragile')
      )
    ),
    TRUE
  ),
  (
    'marketplace_request_payload_single_shipment',
    1,
    jsonb_build_object(
      '$schema', 'http://json-schema.org/draft-07/schema#',
      'type', 'object',
      'additionalProperties', TRUE
    ),
    'Schema-driven payload for single-shipment marketplace requests.',
    jsonb_build_array(jsonb_build_object('shipment_reference', 'SHP-1001')),
    TRUE
  ),
  (
    'marketplace_request_payload_route_block',
    1,
    jsonb_build_object(
      '$schema', 'http://json-schema.org/draft-07/schema#',
      'type', 'object',
      'additionalProperties', TRUE
    ),
    'Schema-driven payload for route-block marketplace requests.',
    jsonb_build_array(jsonb_build_object('route_date', '2026-03-09', 'stop_count', 18)),
    TRUE
  )
ON CONFLICT (category, version) DO UPDATE
SET
  schema = EXCLUDED.schema,
  description = EXCLUDED.description,
  examples = EXCLUDED.examples,
  is_active = TRUE,
  updated_at = now();

UPDATE public.marketplace_request_kinds
   SET default_materializer_key = CASE kind_key
         WHEN 'driver_shift_market' THEN 'driver_shift_auto_bridge'
         WHEN 'capacity_block' THEN 'capacity_block_auto_bridge'
         WHEN 'shipment_batch' THEN 'shipment_batch_auto_bridge'
         ELSE default_materializer_key
       END,
       is_active = CASE WHEN kind_key = 'shipment_batch' THEN TRUE ELSE is_active END,
       ui_config = COALESCE(ui_config, '{}'::jsonb)
         || jsonb_build_object(
              'workspace_mode', 'board',
              'offer_form_mode', 'schema',
              'detail_tabs', jsonb_build_array('overview', 'offers', 'contract', 'execution', 'settlement')
            ),
       lifecycle_config = COALESCE(lifecycle_config, '{}'::jsonb)
         || jsonb_build_object(
              'default_request_status', 'draft',
              'offer_counter_enabled', TRUE,
              'auto_materialize_on_provider_accept', TRUE,
              'auto_settle_on_completion', TRUE,
              'dispute_window_hours', 72,
              'allow_split_award', FALSE,
              'release_strategy', 'private_pool_then_curated_network'
            ),
       metadata = COALESCE(metadata, '{}'::jsonb)
         || jsonb_build_object(
              'phase', 'product_complete',
              'active_in_phase', kind_key IN ('driver_shift_market', 'capacity_block', 'shipment_batch')
            ),
       updated_at = now()
 WHERE kind_key IN ('driver_shift_market', 'capacity_block', 'shipment_batch', 'route_block');

ALTER TABLE public.marketplace_requests
  ALTER COLUMN settlement_mode_key SET DEFAULT 'auto_recorded_internal';

ALTER TABLE public.marketplace_contracts
  ALTER COLUMN settlement_mode_key SET DEFAULT 'auto_recorded_internal';

ALTER TABLE public.marketplace_requests
  DROP CONSTRAINT IF EXISTS marketplace_requests_status_ck;
ALTER TABLE public.marketplace_requests
  ADD CONSTRAINT marketplace_requests_status_ck CHECK (
    status IN (
      'draft',
      'published',
      'negotiation',
      'awarded',
      'award_pending_acceptance',
      'provider_accepted',
      'materialized',
      'executing',
      'in_execution',
      'completed',
      'settled',
      'cancelled',
      'expired',
      'disputed'
    )
  );

ALTER TABLE public.marketplace_contracts
  DROP CONSTRAINT IF EXISTS marketplace_contracts_status_ck;
ALTER TABLE public.marketplace_contracts
  ADD CONSTRAINT marketplace_contracts_status_ck CHECK (
    status IN (
      'pending_acceptance',
      'active',
      'materialized',
      'executing',
      'completed',
      'settled',
      'cancelled',
      'rejected',
      'disputed'
    )
  );

ALTER TABLE public.marketplace_work_packages
  DROP CONSTRAINT IF EXISTS marketplace_work_packages_status_ck;
ALTER TABLE public.marketplace_work_packages
  ADD CONSTRAINT marketplace_work_packages_status_ck CHECK (
    status IN (
      'pending_acceptance',
      'ready',
      'materialized',
      'in_execution',
      'executing',
      'completed',
      'settled',
      'cancelled',
      'disputed'
    )
  );

-------------------------------------------------------------------------------
-- 2) Helper functions and policy/read-model defaults
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.marketplace_private_pool_contains_v1(
  p_private_pool JSONB,
  p_organization_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT EXISTS (
    SELECT 1
      FROM jsonb_array_elements_text(
             CASE
               WHEN jsonb_typeof(COALESCE(p_private_pool, '[]'::jsonb)) = 'array'
                 THEN COALESCE(p_private_pool, '[]'::jsonb)
               ELSE '[]'::jsonb
             END
           ) AS pool(value)
     WHERE lower(btrim(pool.value)) = lower(COALESCE(p_organization_id::text, ''))
  );
$function$;

CREATE OR REPLACE FUNCTION public.marketplace_materializer_config_v1(
  p_materializer_key TEXT
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT COALESCE(e.config, '{}'::jsonb)
    FROM public.marketplace_registry_entries e
   WHERE e.registry_type = 'materializer'
     AND e.entry_key = COALESCE(NULLIF(btrim(COALESCE(p_materializer_key, '')), ''), 'manual_bridge')
   LIMIT 1;
$function$;

CREATE OR REPLACE FUNCTION public.marketplace_policy_default_v1(
  p_category TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_category TEXT := lower(btrim(COALESCE(p_category, '')));
BEGIN
  CASE v_category
    WHEN 'marketplace_policy' THEN
      RETURN jsonb_build_object(
        'version', 2,
        'enabled', TRUE,
        'curated_network', TRUE,
        'default_visibility_mode', 'private_pool_first',
        'default_pricing_mode', 'quote',
        'default_negotiation_mode', 'counter',
        'default_ownership_mode', 'origin_tenant',
        'default_settlement_mode', 'auto_recorded_internal',
        'default_tracking_display_mode', 'origin_brand_only',
        'default_listing_status', 'curated_network',
        'request_release_order', jsonb_build_array('private_pool', 'curated_network'),
        'provider_tenant_opt_in_requires_review', FALSE,
        'freelancer_multi_tenant_enabled', TRUE,
        'private_pool', jsonb_build_object('enabled', TRUE),
        'execution', jsonb_build_object(
          'auto_materialize_on_provider_accept', TRUE,
          'materialize_on', 'provider_accept'
        ),
        'settlement', jsonb_build_object(
          'external_payout_mode', 'disabled',
          'auto_record_on_completion', TRUE
        ),
        'ai', jsonb_build_object('advisory_only', TRUE)
      );
    WHEN 'marketplace_request_policy' THEN
      RETURN jsonb_build_object(
        'version', 2,
        'enabled', TRUE,
        'allowed_request_kinds', jsonb_build_array('driver_shift_market', 'capacity_block', 'shipment_batch'),
        'request_defaults', jsonb_build_object(
          'status', 'draft',
          'auto_publish', FALSE,
          'expire_hours', 24,
          'release_state', 'private_pool',
          'allow_split_award', FALSE
        ),
        'lifecycle', jsonb_build_object(
          'primary', jsonb_build_array(
            'draft',
            'published',
            'negotiation',
            'awarded',
            'provider_accepted',
            'materialized',
            'executing',
            'completed',
            'settled'
          ),
          'side_paths', jsonb_build_array('cancelled', 'expired', 'disputed')
        )
      );
    WHEN 'marketplace_visibility_policy' THEN
      RETURN jsonb_build_object(
        'version', 2,
        'private_pool_first', TRUE,
        'allow_curated_network_release', TRUE,
        'allow_public_release', FALSE,
        'release_strategy', 'private_pool_then_curated_network'
      );
    WHEN 'marketplace_execution_policy' THEN
      RETURN jsonb_build_object(
        'version', 2,
        'work_package_required', TRUE,
        'default_materializer', 'capacity_block_auto_bridge',
        'bridge_mode', 'contract_scoped',
        'allow_direct_transfer', FALSE,
        'work_package', jsonb_build_object(
          'auto_materialize', TRUE,
          'auto_materialize_on_provider_accept', TRUE
        )
      );
    WHEN 'marketplace_settlement_policy' THEN
      RETURN jsonb_build_object(
        'version', 2,
        'record_payables', TRUE,
        'manual_payout_only', TRUE,
        'allow_automatic_payouts', FALSE,
        'reserve_holdback_percent', 0,
        'settlement_mode', 'auto_recorded_internal',
        'auto_record_on_completion', TRUE,
        'external_payout_mode', 'disabled',
        'dispute_lock_required', TRUE,
        'scope_type', 'marketplace_contract'
      );
    WHEN 'marketplace_reputation_policy' THEN
      RETURN jsonb_build_object(
        'version', 2,
        'enabled', TRUE,
        'composite_score', TRUE,
        'weights', jsonb_build_object(
          'completion_rate', 40,
          'cancellation_rate', -25,
          'dispute_rate', -20,
          'document_freshness', 15,
          'feedback_score', 20,
          'proof_quality', 15,
          'recipient_feedback', 15
        )
      );
    WHEN 'marketplace_tracking_display_policy' THEN
      RETURN jsonb_build_object(
        'version', 2,
        'display_mode', 'origin_brand_only',
        'mask_contact_details', TRUE,
        'show_supplier_identity_to_recipient', FALSE
      );
    WHEN 'marketplace_compliance_policy' THEN
      RETURN jsonb_build_object(
        'version', 2,
        'enabled', TRUE,
        'approval_mode', 'required',
        'turnstile', jsonb_build_object('required', TRUE),
        'rate_limit', jsonb_build_object('window_seconds', 60, 'max_requests', 10),
        'dedupe', jsonb_build_object('window_seconds', 86400),
        'participant_types', jsonb_build_object(
          'freelancer_driver', jsonb_build_object(
            'enabled', TRUE,
            'allow_public_intake', TRUE,
            'default_listing_status', 'curated_network'
          ),
          'provider_tenant', jsonb_build_object(
            'enabled', TRUE,
            'allow_public_intake', FALSE,
            'default_listing_status', 'private'
          )
        ),
        'onboarding', jsonb_build_object(
          'create_lightweight_org', TRUE,
          'initial_user_type', 'driver',
          'initial_role_key', 'driver',
          'invite_redirect_to', NULL
        ),
        'task', jsonb_build_object(
          'enabled', TRUE,
          'organization_slug', 'global-root',
          'task_type_key', 'marketplace_participant_review',
          'queue_key', 'marketplace_participant_review',
          'priority', 45,
          'sla_minutes', 120
        )
      );
    ELSE
      RETURN '{}'::jsonb;
  END CASE;
END;
$function$;

CREATE OR REPLACE FUNCTION public.marketplace_request_kind_catalog_v1(
  p_context JSONB DEFAULT '{}'::jsonb,
  p_include_inactive BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_marketplace_policy JSONB := public.marketplace_policy_v1(p_context);
  v_request_policy JSONB := public.marketplace_request_policy_v1(p_context);
  v_compliance_policy JSONB := public.marketplace_compliance_policy_v1(p_context);
  v_allowed_request_kinds JSONB := COALESCE(v_request_policy->'allowed_request_kinds', '[]'::jsonb);
  v_items JSONB := '[]'::jsonb;
BEGIN
  SELECT COALESCE(
           jsonb_agg(
             jsonb_build_object(
               'kind_key', rk.kind_key,
               'label', rk.label,
               'description', rk.description,
               'participant_type_supply_key', rk.participant_type_supply_key,
               'payload_schema_category', rk.payload_schema_category,
               'payload_schema', sr.schema,
               'default_materializer_key', rk.default_materializer_key,
               'is_active', rk.is_active,
               'is_public', rk.is_public,
               'ui_config', rk.ui_config,
               'lifecycle_config', rk.lifecycle_config,
               'metadata', rk.metadata
             )
             ORDER BY rk.kind_key
           ),
           '[]'::jsonb
         )
    INTO v_items
    FROM public.marketplace_request_kinds rk
    LEFT JOIN public.schema_registry sr
      ON sr.category = rk.payload_schema_category
     AND sr.is_active = TRUE
   WHERE (
          p_include_inactive
          OR rk.is_active = TRUE
         )
     AND (
          jsonb_typeof(v_allowed_request_kinds) <> 'array'
          OR jsonb_array_length(v_allowed_request_kinds) = 0
          OR EXISTS (
               SELECT 1
                 FROM jsonb_array_elements_text(v_allowed_request_kinds) AS allowed(kind_key)
                WHERE allowed.kind_key = rk.kind_key
             )
         );

  RETURN jsonb_build_object(
    'request_kinds', v_items,
    'marketplace_policy', v_marketplace_policy,
    'request_policy', v_request_policy,
    'compliance_policy', v_compliance_policy,
    'offer_schema', (
      SELECT sr.schema
        FROM public.schema_registry sr
       WHERE sr.category = 'marketplace_offer_terms'
         AND sr.is_active = TRUE
       ORDER BY sr.version DESC
       LIMIT 1
    ),
    'contract_schema', (
      SELECT sr.schema
        FROM public.schema_registry sr
       WHERE sr.category = 'marketplace_contract_terms'
         AND sr.is_active = TRUE
       ORDER BY sr.version DESC
       LIMIT 1
    ),
    'onboarding_schema', (
      SELECT sr.schema
        FROM public.schema_registry sr
       WHERE sr.category = 'marketplace_onboarding_form'
         AND sr.is_active = TRUE
       ORDER BY sr.version DESC
       LIMIT 1
    ),
    'verification_schema', (
      SELECT sr.schema
        FROM public.schema_registry sr
       WHERE sr.category = 'marketplace_verification_requirements'
         AND sr.is_active = TRUE
       ORDER BY sr.version DESC
       LIMIT 1
    )
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.marketplace_can_read_request_v1(
  p_requester_organization_id UUID,
  p_status TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.is_platform_user()
      OR public.marketplace_org_match_v1(p_requester_organization_id)
      OR (
        COALESCE(p_status, '') IN (
          'published',
          'negotiation',
          'awarded',
          'award_pending_acceptance',
          'provider_accepted',
          'materialized',
          'executing',
          'in_execution',
          'completed',
          'settled',
          'disputed'
        )
        AND public.marketplace_current_org_has_approved_participant_v1()
      );
$function$;

CREATE OR REPLACE FUNCTION public.marketplace_refresh_reputation_snapshot_v1(
  p_participant_profile_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_org_id UUID;
  v_score NUMERIC(10,2) := 0;
  v_event_count INTEGER := 0;
  v_completion_rate NUMERIC(10,4) := 0;
  v_cancellation_rate NUMERIC(10,4) := 0;
  v_dispute_rate NUMERIC(10,4) := 0;
  v_document_freshness NUMERIC(10,4) := 0;
  v_feedback_score NUMERIC(10,4) := 0;
  v_snapshot JSONB;
BEGIN
  SELECT p.organization_id
    INTO v_org_id
    FROM public.marketplace_participant_profiles p
   WHERE p.id = p_participant_profile_id
   LIMIT 1;

  IF v_org_id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'participant_not_found'));
  END IF;

  SELECT
    COALESCE(SUM(score_delta * weight), 0),
    COUNT(*),
    COALESCE(AVG(CASE WHEN metric_key = 'completion_rate' THEN score_delta END), 0),
    COALESCE(ABS(AVG(CASE WHEN metric_key = 'cancellation_rate' THEN score_delta END)), 0),
    COALESCE(ABS(AVG(CASE WHEN metric_key = 'dispute_rate' THEN score_delta END)), 0),
    COALESCE(AVG(CASE WHEN metric_key = 'document_freshness' THEN score_delta END), 0),
    COALESCE(AVG(CASE WHEN metric_key IN ('feedback_score', 'proof_quality', 'recipient_feedback') THEN score_delta END), 0)
    INTO
      v_score,
      v_event_count,
      v_completion_rate,
      v_cancellation_rate,
      v_dispute_rate,
      v_document_freshness,
      v_feedback_score
    FROM public.marketplace_reputation_events e
   WHERE e.participant_profile_id = p_participant_profile_id;

  v_snapshot := jsonb_build_object(
    'score', v_score,
    'event_count', v_event_count,
    'completion_rate', v_completion_rate,
    'cancellation_rate', v_cancellation_rate,
    'dispute_rate', v_dispute_rate,
    'document_freshness', v_document_freshness,
    'feedback_score', v_feedback_score
  );

  INSERT INTO public.marketplace_reputation_snapshots (
    participant_profile_id,
    organization_id,
    score,
    event_count,
    completion_rate,
    cancellation_rate,
    dispute_rate,
    document_freshness,
    feedback_score,
    snapshot,
    created_at,
    updated_at
  )
  VALUES (
    p_participant_profile_id,
    v_org_id,
    v_score,
    v_event_count,
    v_completion_rate,
    v_cancellation_rate,
    v_dispute_rate,
    v_document_freshness,
    v_feedback_score,
    v_snapshot,
    now(),
    now()
  )
  ON CONFLICT (participant_profile_id) DO UPDATE
  SET
    organization_id = EXCLUDED.organization_id,
    score = EXCLUDED.score,
    event_count = EXCLUDED.event_count,
    completion_rate = EXCLUDED.completion_rate,
    cancellation_rate = EXCLUDED.cancellation_rate,
    dispute_rate = EXCLUDED.dispute_rate,
    document_freshness = EXCLUDED.document_freshness,
    feedback_score = EXCLUDED.feedback_score,
    snapshot = EXCLUDED.snapshot,
    updated_at = now();

  UPDATE public.marketplace_participant_profiles
     SET rating_overall = v_score,
         rating_count = v_event_count,
         updated_at = now()
   WHERE id = p_participant_profile_id;

  RETURN jsonb_build_object('ok', TRUE, 'participant_profile_id', p_participant_profile_id, 'snapshot', v_snapshot);
END;
$function$;

CREATE OR REPLACE FUNCTION public.marketplace_record_finance_event_v1(
  p_organization_id UUID,
  p_event_type TEXT,
  p_direction TEXT,
  p_amount NUMERIC,
  p_currency TEXT,
  p_subject_type TEXT,
  p_subject_id UUID,
  p_metadata JSONB DEFAULT '{}'::jsonb,
  p_idempotency_key TEXT DEFAULT NULL
)
RETURNS TABLE (
  finance_event_id UUID,
  occurred_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_rows RECORD;
BEGIN
  occurred_at := now();

  SELECT *
    INTO v_rows
    FROM public.record_finance_event_v1(
      jsonb_build_object(
        'organization_id', p_organization_id,
        'event_type', COALESCE(NULLIF(btrim(COALESCE(p_event_type, '')), ''), 'marketplace_settlement'),
        'direction', COALESCE(NULLIF(btrim(COALESCE(p_direction, '')), ''), 'debit'),
        'amount', COALESCE(p_amount, 0),
        'currency', COALESCE(NULLIF(btrim(COALESCE(p_currency, '')), ''), 'SAR'),
        'account_type', 'company',
        'account_id', p_organization_id,
        'subject_type', COALESCE(NULLIF(btrim(COALESCE(p_subject_type, '')), ''), 'marketplace_contract'),
        'subject_id', p_subject_id,
        'idempotency_key', NULLIF(btrim(COALESCE(p_idempotency_key, '')), ''),
        'occurred_at', occurred_at,
        'metadata', COALESCE(p_metadata, '{}'::jsonb)
      )
    );

  finance_event_id := v_rows.finance_event_id;
  RETURN NEXT;
END;
$function$;

CREATE OR REPLACE FUNCTION public.marketplace_create_posted_settlement_batch_v1(
  p_organization_id UUID,
  p_kind TEXT,
  p_subject_id UUID,
  p_finance_event_id UUID,
  p_finance_occurred_at TIMESTAMPTZ,
  p_metadata JSONB DEFAULT '{}'::jsonb,
  p_idempotency_key TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_created RECORD;
  v_batch_id UUID;
BEGIN
  SELECT *
    INTO v_created
    FROM public.create_settlement_batch_v1(
      jsonb_build_object(
        'organization_id', p_organization_id,
        'kind', COALESCE(NULLIF(btrim(COALESCE(p_kind, '')), ''), 'billing'),
        'scope_type', 'marketplace_contract',
        'subject_type', 'marketplace_contract',
        'subject_id', p_subject_id,
        'window_start_at', COALESCE(p_finance_occurred_at, now()),
        'window_end_at', COALESCE(p_finance_occurred_at, now()),
        'actor_system', 'marketplace_create_posted_settlement_batch_v1',
        'idempotency_key', NULLIF(btrim(COALESCE(p_idempotency_key, '')), ''),
        'metadata', COALESCE(p_metadata, '{}'::jsonb)
      )
    );

  v_batch_id := v_created.settlement_batch_id;

  PERFORM public.attach_finance_event_to_settlement_v1(
    jsonb_build_object(
      'settlement_batch_id', v_batch_id,
      'finance_event_id', p_finance_event_id,
      'finance_occurred_at', COALESCE(p_finance_occurred_at, now()),
      'actor_system', 'marketplace_create_posted_settlement_batch_v1',
      'idempotency_key', COALESCE(p_idempotency_key, '') || ':attach',
      'payload', COALESCE(p_metadata, '{}'::jsonb)
    )
  );

  PERFORM public.transition_settlement_batch_v1(
    jsonb_build_object(
      'settlement_batch_id', v_batch_id,
      'to_status', 'posted',
      'status_reason', 'marketplace_auto_recorded_internal',
      'actor_system', 'marketplace_create_posted_settlement_batch_v1',
      'idempotency_key', COALESCE(p_idempotency_key, '') || ':post',
      'payload', COALESCE(p_metadata, '{}'::jsonb)
    )
  );

  RETURN v_batch_id;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.marketplace_private_pool_contains_v1(JSONB, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.marketplace_materializer_config_v1(TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.marketplace_record_finance_event_v1(UUID, TEXT, TEXT, NUMERIC, TEXT, TEXT, UUID, JSONB, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.marketplace_create_posted_settlement_batch_v1(UUID, TEXT, UUID, UUID, TIMESTAMPTZ, JSONB, TEXT) TO service_role;

SELECT pg_advisory_unlock(hashtext('202603081200_marketplace_network_product_complete_registry_v1'));
COMMIT;
