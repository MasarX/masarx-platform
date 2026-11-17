-- Plan: PLAN-202603-marketplace-network-product-complete / Step: S04
-- Migration: Reconcile legacy tenant-scoped marketplace defaults to product-complete policy rows

BEGIN;
SELECT pg_advisory_lock(hashtext('202603091040_marketplace_tenant_default_settings_reconcile_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.marketplace_policy_legacy_default_v1(p_category TEXT)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_category
    WHEN 'marketplace_policy' THEN jsonb_build_object(
      'version', 1,
      'enabled', TRUE,
      'ai', jsonb_build_object('advisory_only', TRUE),
      'private_pool', jsonb_build_object('enabled', TRUE),
      'curated_network', TRUE,
      'default_pricing_mode', 'quote',
      'request_release_order', jsonb_build_array('private_pool', 'curated_network'),
      'default_ownership_mode', 'origin_tenant',
      'default_settlement_mode', 'manual_recorded',
      'default_visibility_mode', 'private_pool_first',
      'default_negotiation_mode', 'counter',
      'default_tracking_display_mode', 'origin_brand_only',
      'freelancer_multi_tenant_enabled', TRUE,
      'provider_tenant_opt_in_requires_review', FALSE
    )
    WHEN 'marketplace_request_policy' THEN jsonb_build_object(
      'version', 1,
      'enabled', TRUE,
      'request_defaults', jsonb_build_object(
        'status', 'draft',
        'auto_publish', FALSE,
        'expire_hours', 24
      ),
      'allowed_request_kinds', jsonb_build_array('driver_shift_market', 'capacity_block')
    )
    WHEN 'marketplace_visibility_policy' THEN jsonb_build_object(
      'version', 1,
      'private_pool_first', TRUE,
      'allow_public_release', FALSE,
      'allow_curated_network_release', TRUE
    )
    WHEN 'marketplace_execution_policy' THEN jsonb_build_object(
      'version', 1,
      'work_package', jsonb_build_object(
        'auto_materialize', FALSE,
        'default_materializer_key', 'manual_bridge'
      )
    )
    WHEN 'marketplace_settlement_policy' THEN jsonb_build_object(
      'version', 1,
      'record_payables', TRUE,
      'holdback_percent', 0,
      'automated_payouts_enabled', FALSE
    )
    WHEN 'marketplace_reputation_policy' THEN jsonb_build_object(
      'version', 1,
      'weights', jsonb_build_object(
        'completion', 20,
        'cancellation', -25,
        'feedback', 20,
        'documents', 15,
        'dispute', -30
      ),
      'minimum_network_score', 50
    )
    WHEN 'marketplace_tracking_display_policy' THEN jsonb_build_object(
      'version', 1,
      'display_mode', 'origin_brand_only',
      'masked_contact_required', TRUE,
      'provider_identity_visible_to_recipient', FALSE
    )
    WHEN 'marketplace_compliance_policy' THEN jsonb_build_object(
      'version', 1,
      'enabled', TRUE,
      'turnstile', jsonb_build_object('required', TRUE),
      'rate_limit', jsonb_build_object(
        'max_requests', 10,
        'window_seconds', 60
      ),
      'dedupe', jsonb_build_object('window_seconds', 86400),
      'task', jsonb_build_object(
        'queue_key', 'marketplace',
        'task_type_key', 'marketplace_participant_review',
        'priority', 45,
        'sla_minutes', 120,
        'organization_slug', 'global-root'
      ),
      'onboarding', jsonb_build_object(
        'freelancer_driver', jsonb_build_object(
          'approval_mode', 'required',
          'public_enabled', TRUE,
          'initial_user_type', 'driver',
          'initial_role_key', 'driver'
        ),
        'provider_tenant', jsonb_build_object(
          'approval_mode', 'auto'
        )
      ),
      'email_domains', jsonb_build_object(
        'allowlist', jsonb_build_array(),
        'blocklist', jsonb_build_array()
      )
    )
    ELSE NULL
  END;
$$;

CREATE OR REPLACE FUNCTION public.reconcile_marketplace_tenant_default_settings_v1()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_category TEXT;
  v_scope_id UUID;
  v_updated INTEGER := 0;
BEGIN
  FOREACH v_category IN ARRAY ARRAY[
    'marketplace_policy',
    'marketplace_request_policy',
    'marketplace_visibility_policy',
    'marketplace_execution_policy',
    'marketplace_settlement_policy',
    'marketplace_reputation_policy',
    'marketplace_tracking_display_policy',
    'marketplace_compliance_policy'
  ]
  LOOP
    FOR v_scope_id IN
      SELECT s.scope_hash
        FROM public.settings AS s
        JOIN public.settings_versions AS sv
          ON sv.id = s.settings_version_id
       WHERE s.category = v_category
         AND s.scope_type = 'tenant'
         AND sv.value = public.marketplace_policy_legacy_default_v1(v_category)
    LOOP
      PERFORM public.upsert_settings_value_v1(
        p_category := v_category,
        p_scope_type := 'tenant',
        p_scope_id := v_scope_id,
        p_value := public.marketplace_policy_default_v1(v_category),
        p_schema_version := 1,
        p_change_reason := 'Reconcile tenant-scoped legacy marketplace defaults to product-complete policy pack'
      );
      v_updated := v_updated + 1;
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'updated_count', v_updated
  );
END;
$$;

SELECT public.reconcile_marketplace_tenant_default_settings_v1();

SELECT pg_advisory_unlock(hashtext('202603091040_marketplace_tenant_default_settings_reconcile_v1'));
COMMIT;
