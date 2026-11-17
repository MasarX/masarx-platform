-- Plan: PLAN-202603-marketplace-network-v1 / Step: S04
-- Migration: Marketplace network registry seed + RLS v1

BEGIN;
SELECT pg_advisory_lock(hashtext('202603071110_marketplace_network_registry_rls_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

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
  ('participant_type', 'employee_driver', 'Employee driver', 'Tenant-owned employee driver profile.', 10, FALSE, TRUE, jsonb_build_object('exclusive_to_tenant', TRUE)),
  ('participant_type', 'freelancer_driver', 'Freelancer driver', 'Independent driver approved for marketplace work.', 20, FALSE, TRUE, jsonb_build_object('exclusive_to_tenant', FALSE, 'onboarding_schema_category', 'marketplace_onboarding_form')),
  ('participant_type', 'provider_tenant', 'Provider tenant', 'Tenant participating as a supply provider in the MasarX Network.', 30, FALSE, TRUE, jsonb_build_object('exclusive_to_tenant', FALSE)),
  ('pricing_mode', 'quote', 'Quote', 'Supplier quotes a custom total for the request.', 10, TRUE, TRUE, '{}'::jsonb),
  ('pricing_mode', 'fixed_total', 'Fixed total', 'Requester publishes a fixed total price.', 20, FALSE, TRUE, '{}'::jsonb),
  ('pricing_mode', 'per_shipment', 'Per shipment', 'Pricing is expressed per shipment.', 30, FALSE, TRUE, '{}'::jsonb),
  ('pricing_mode', 'per_block', 'Per block', 'Pricing is expressed per block or shift.', 40, FALSE, TRUE, '{}'::jsonb),
  ('negotiation_mode', 'accept_only', 'Accept only', 'Suppliers accept published terms without counter.', 10, FALSE, TRUE, '{}'::jsonb),
  ('negotiation_mode', 'counter', 'Counter', 'Suppliers may counter with offer terms.', 20, TRUE, TRUE, '{}'::jsonb),
  ('visibility_mode', 'private_pool_first', 'Private pool first', 'Private pool first, then curated network on release.', 20, TRUE, TRUE, '{}'::jsonb),
  ('ownership_mode', 'origin_tenant', 'Origin tenant owns customer promise', 'Origin tenant remains customer-facing and commercially responsible.', 10, TRUE, TRUE, '{}'::jsonb),
  ('settlement_mode', 'manual_recorded', 'Manual recorded', 'Record payables/receivables and settle manually.', 10, TRUE, TRUE, '{}'::jsonb),
  ('materializer', 'manual_bridge', 'Manual bridge', 'Awarded work stays in a ready state until manually bridged to ops execution.', 10, TRUE, TRUE, jsonb_build_object('execution_target', 'manual')),
  ('materializer', 'route_run_bridge', 'Route run bridge', 'Awarded work maps to route-run execution primitives.', 20, FALSE, TRUE, jsonb_build_object('execution_target', 'route_run')),
  ('materializer', 'shipment_assignment_contract', 'Shipment assignment contract', 'Awarded work maps to shipment-assignment contract execution.', 30, FALSE, TRUE, jsonb_build_object('execution_target', 'shipment_assignment_contract')),
  ('capability_type', 'cold_chain', 'Cold chain', 'Can handle temperature-controlled work.', 10, FALSE, TRUE, '{}'::jsonb),
  ('capability_type', 'fragile', 'Fragile', 'Can handle fragile shipments.', 20, FALSE, TRUE, '{}'::jsonb),
  ('document_type', 'national_id', 'National ID', 'Government identity verification.', 10, FALSE, TRUE, '{}'::jsonb),
  ('document_type', 'driver_license', 'Driver license', 'Driver license verification.', 20, FALSE, TRUE, '{}'::jsonb),
  ('document_type', 'vehicle_registration', 'Vehicle registration', 'Vehicle ownership or registration document.', 30, FALSE, TRUE, '{}'::jsonb),
  ('tracking_display_mode', 'origin_brand_only', 'Origin brand only', 'Recipient sees only origin tenant branding and support identity.', 10, TRUE, TRUE, '{}'::jsonb)
ON CONFLICT (registry_type, entry_key) DO UPDATE
SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  is_default = EXCLUDED.is_default,
  is_active = EXCLUDED.is_active,
  config = EXCLUDED.config,
  updated_at = now();

INSERT INTO public.marketplace_request_kinds (
  kind_key,
  label,
  description,
  participant_type_supply_key,
  payload_schema_category,
  default_materializer_key,
  is_active,
  is_public,
  ui_config,
  lifecycle_config,
  metadata
)
VALUES
  (
    'driver_shift_market',
    'Driver shift market',
    'Freelancer drivers compete for shift-based demand posted by tenants.',
    'freelancer_driver',
    'marketplace_request_payload_driver_shift_market',
    'manual_bridge',
    TRUE,
    TRUE,
    jsonb_build_object('form_title', 'Create driver shift request', 'card_fields', jsonb_build_array('city', 'starts_at', 'ends_at', 'shipment_estimate')),
    jsonb_build_object('default_request_status', 'draft', 'offer_counter_enabled', TRUE),
    jsonb_build_object('request_unit', 'driver_shift')
  ),
  (
    'capacity_block',
    'Capacity block',
    'Tenant-to-tenant capacity exchange for shipment volume blocks.',
    'provider_tenant',
    'marketplace_request_payload_capacity_block',
    'manual_bridge',
    TRUE,
    FALSE,
    jsonb_build_object('form_title', 'Create capacity block request', 'card_fields', jsonb_build_array('city', 'service_date', 'shipment_capacity')),
    jsonb_build_object('default_request_status', 'draft', 'offer_counter_enabled', TRUE),
    jsonb_build_object('request_unit', 'capacity_block')
  ),
  (
    'shipment_batch',
    'Shipment batch',
    'Batch-level shipment transfer market.',
    'provider_tenant',
    'marketplace_request_payload_shipment_batch',
    'shipment_assignment_contract',
    FALSE,
    FALSE,
    jsonb_build_object('form_title', 'Create shipment batch request'),
    jsonb_build_object('default_request_status', 'draft'),
    jsonb_build_object('request_unit', 'shipment_batch')
  ),
  (
    'single_shipment',
    'Single shipment',
    'Per-shipment external fulfillment request.',
    'provider_tenant',
    'marketplace_request_payload_single_shipment',
    'shipment_assignment_contract',
    FALSE,
    FALSE,
    jsonb_build_object('form_title', 'Create shipment request'),
    jsonb_build_object('default_request_status', 'draft'),
    jsonb_build_object('request_unit', 'single_shipment')
  ),
  (
    'route_block',
    'Route block',
    'Route-level outsourced execution request.',
    'provider_tenant',
    'marketplace_request_payload_route_block',
    'route_run_bridge',
    FALSE,
    FALSE,
    jsonb_build_object('form_title', 'Create route block request'),
    jsonb_build_object('default_request_status', 'draft'),
    jsonb_build_object('request_unit', 'route_block')
  )
ON CONFLICT (kind_key) DO UPDATE
SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  participant_type_supply_key = EXCLUDED.participant_type_supply_key,
  payload_schema_category = EXCLUDED.payload_schema_category,
  default_materializer_key = EXCLUDED.default_materializer_key,
  is_active = EXCLUDED.is_active,
  is_public = EXCLUDED.is_public,
  ui_config = EXCLUDED.ui_config,
  lifecycle_config = EXCLUDED.lifecycle_config,
  metadata = EXCLUDED.metadata,
  updated_at = now();

CREATE OR REPLACE FUNCTION public.marketplace_system_org_id_v1()
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_org_id UUID;
BEGIN
  SELECT o.id INTO v_org_id FROM public.organizations o WHERE o.slug = 'global-root' LIMIT 1;
  RETURN COALESCE(v_org_id, '00000000-0000-0000-0000-000000000000'::uuid);
END;
$function$;

CREATE OR REPLACE FUNCTION public.marketplace_org_match_v1(p_organization_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.is_platform_user()
      OR (
        p_organization_id IS NOT NULL
        AND public.current_user_org_id() IS NOT NULL
        AND public.current_user_org_id() = p_organization_id
      );
$function$;

CREATE OR REPLACE FUNCTION public.marketplace_org_has_approved_participant_v1(p_organization_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT EXISTS (
    SELECT 1
      FROM public.marketplace_participant_profiles p
     WHERE p.organization_id = p_organization_id
       AND p.status = 'approved'
       AND p.compliance_state = 'approved'
  );
$function$;

CREATE OR REPLACE FUNCTION public.marketplace_current_org_has_approved_participant_v1()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.marketplace_org_has_approved_participant_v1(public.current_user_org_id());
$function$;

CREATE OR REPLACE FUNCTION public.marketplace_profile_network_visible_v1(p_status TEXT, p_listing_status TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT COALESCE(p_status, '') = 'approved' AND COALESCE(p_listing_status, '') IN ('curated_network', 'public');
$function$;

CREATE OR REPLACE FUNCTION public.marketplace_can_read_request_v1(p_requester_organization_id UUID, p_status TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.is_platform_user()
      OR public.marketplace_org_match_v1(p_requester_organization_id)
      OR (
        COALESCE(p_status, '') IN ('published', 'award_pending_acceptance', 'awarded', 'in_execution', 'completed')
        AND public.marketplace_current_org_has_approved_participant_v1()
      );
$function$;

CREATE OR REPLACE FUNCTION public.marketplace_can_read_contract_v1(p_requester_organization_id UUID, p_supplier_organization_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.is_platform_user()
      OR public.marketplace_org_match_v1(p_requester_organization_id)
      OR public.marketplace_org_match_v1(p_supplier_organization_id);
$function$;

DO $$
DECLARE
  v_table TEXT;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'marketplace_registry_entries',
    'marketplace_request_kinds',
    'marketplace_participant_profiles',
    'marketplace_participant_memberships',
    'marketplace_participant_requests',
    'marketplace_participant_capabilities',
    'marketplace_verification_records',
    'marketplace_availability_windows',
    'marketplace_requests',
    'marketplace_request_items',
    'marketplace_offers',
    'marketplace_awards',
    'marketplace_contracts',
    'marketplace_work_packages',
    'marketplace_disputes',
    'marketplace_reputation_events',
    'marketplace_reputation_snapshots',
    'marketplace_events'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_table);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', v_table);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon', v_table);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM authenticated', v_table);
    EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role', v_table);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', v_table || '_service_policy', v_table);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE)', v_table || '_service_policy', v_table);
  END LOOP;
END;
$$;

GRANT SELECT ON TABLE public.marketplace_registry_entries TO authenticated;
GRANT SELECT ON TABLE public.marketplace_request_kinds TO authenticated;
GRANT SELECT ON TABLE public.marketplace_participant_profiles TO authenticated;
GRANT SELECT ON TABLE public.marketplace_participant_memberships TO authenticated;
GRANT SELECT ON TABLE public.marketplace_participant_requests TO authenticated;
GRANT SELECT ON TABLE public.marketplace_participant_capabilities TO authenticated;
GRANT SELECT ON TABLE public.marketplace_verification_records TO authenticated;
GRANT SELECT ON TABLE public.marketplace_availability_windows TO authenticated;
GRANT SELECT ON TABLE public.marketplace_requests TO authenticated;
GRANT SELECT ON TABLE public.marketplace_request_items TO authenticated;
GRANT SELECT ON TABLE public.marketplace_offers TO authenticated;
GRANT SELECT ON TABLE public.marketplace_awards TO authenticated;
GRANT SELECT ON TABLE public.marketplace_contracts TO authenticated;
GRANT SELECT ON TABLE public.marketplace_work_packages TO authenticated;
GRANT SELECT ON TABLE public.marketplace_disputes TO authenticated;
GRANT SELECT ON TABLE public.marketplace_reputation_events TO authenticated;
GRANT SELECT ON TABLE public.marketplace_reputation_snapshots TO authenticated;
GRANT SELECT ON TABLE public.marketplace_events TO authenticated;

CREATE POLICY marketplace_registry_entries_read_policy ON public.marketplace_registry_entries FOR SELECT TO authenticated USING (TRUE);
CREATE POLICY marketplace_request_kinds_read_policy ON public.marketplace_request_kinds FOR SELECT TO authenticated USING (TRUE);
CREATE POLICY marketplace_participant_profiles_read_policy ON public.marketplace_participant_profiles FOR SELECT TO authenticated USING (public.user_has_resource_capability_v1('marketplace_participants', 'read') AND (public.marketplace_org_match_v1(organization_id) OR public.marketplace_profile_network_visible_v1(status, listing_status)));
CREATE POLICY marketplace_participant_memberships_read_policy ON public.marketplace_participant_memberships FOR SELECT TO authenticated USING (public.user_has_resource_capability_v1('marketplace_participants', 'read') AND EXISTS (SELECT 1 FROM public.marketplace_participant_profiles p WHERE p.id = participant_profile_id AND public.marketplace_org_match_v1(p.organization_id)));
CREATE POLICY marketplace_participant_requests_read_policy ON public.marketplace_participant_requests FOR SELECT TO authenticated USING (public.user_has_resource_capability_v1('marketplace_participant_requests', 'read') AND (public.is_platform_user() OR public.marketplace_org_match_v1(requested_organization_id) OR public.marketplace_org_match_v1(approved_organization_id)));
CREATE POLICY marketplace_participant_capabilities_read_policy ON public.marketplace_participant_capabilities FOR SELECT TO authenticated USING (public.user_has_resource_capability_v1('marketplace_participants', 'read') AND EXISTS (SELECT 1 FROM public.marketplace_participant_profiles p WHERE p.id = participant_profile_id AND public.marketplace_org_match_v1(p.organization_id)));
CREATE POLICY marketplace_verification_records_read_policy ON public.marketplace_verification_records FOR SELECT TO authenticated USING (public.user_has_resource_capability_v1('marketplace_verification_records', 'read') AND EXISTS (SELECT 1 FROM public.marketplace_participant_profiles p WHERE p.id = participant_profile_id AND public.marketplace_org_match_v1(p.organization_id)));
CREATE POLICY marketplace_availability_windows_read_policy ON public.marketplace_availability_windows FOR SELECT TO authenticated USING (public.user_has_resource_capability_v1('marketplace_participants', 'read') AND EXISTS (SELECT 1 FROM public.marketplace_participant_profiles p WHERE p.id = participant_profile_id AND public.marketplace_org_match_v1(p.organization_id)));
CREATE POLICY marketplace_requests_read_policy ON public.marketplace_requests FOR SELECT TO authenticated USING (public.user_has_resource_capability_v1('marketplace_requests', 'read') AND public.marketplace_can_read_request_v1(requester_organization_id, status));
CREATE POLICY marketplace_request_items_read_policy ON public.marketplace_request_items FOR SELECT TO authenticated USING (public.user_has_resource_capability_v1('marketplace_requests', 'read') AND EXISTS (SELECT 1 FROM public.marketplace_requests r WHERE r.id = request_id AND public.marketplace_can_read_request_v1(r.requester_organization_id, r.status)));
CREATE POLICY marketplace_offers_read_policy ON public.marketplace_offers FOR SELECT TO authenticated USING (public.user_has_resource_capability_v1('marketplace_offers', 'read') AND (public.marketplace_org_match_v1(supplier_organization_id) OR EXISTS (SELECT 1 FROM public.marketplace_requests r WHERE r.id = request_id AND public.marketplace_org_match_v1(r.requester_organization_id))));
CREATE POLICY marketplace_awards_read_policy ON public.marketplace_awards FOR SELECT TO authenticated USING (public.user_has_resource_capability_v1('marketplace_awards', 'read') AND public.marketplace_can_read_contract_v1(requester_organization_id, supplier_organization_id));
CREATE POLICY marketplace_contracts_read_policy ON public.marketplace_contracts FOR SELECT TO authenticated USING (public.user_has_resource_capability_v1('marketplace_contracts', 'read') AND public.marketplace_can_read_contract_v1(requester_organization_id, supplier_organization_id));
CREATE POLICY marketplace_work_packages_read_policy ON public.marketplace_work_packages FOR SELECT TO authenticated USING (public.user_has_resource_capability_v1('marketplace_work_packages', 'read') AND public.marketplace_can_read_contract_v1(requester_organization_id, supplier_organization_id));
CREATE POLICY marketplace_disputes_read_policy ON public.marketplace_disputes FOR SELECT TO authenticated USING (public.user_has_resource_capability_v1('marketplace_disputes', 'read') AND public.marketplace_can_read_contract_v1(opened_by_organization_id, counterparty_organization_id));
CREATE POLICY marketplace_reputation_events_read_policy ON public.marketplace_reputation_events FOR SELECT TO authenticated USING (public.user_has_resource_capability_v1('marketplace_reputation_snapshots', 'read') AND public.marketplace_org_match_v1(organization_id));
CREATE POLICY marketplace_reputation_snapshots_read_policy ON public.marketplace_reputation_snapshots FOR SELECT TO authenticated USING (public.user_has_resource_capability_v1('marketplace_reputation_snapshots', 'read') AND (public.marketplace_org_match_v1(organization_id) OR public.marketplace_current_org_has_approved_participant_v1()));
CREATE POLICY marketplace_events_read_policy ON public.marketplace_events FOR SELECT TO authenticated USING (public.user_has_resource_capability_v1('marketplace_requests', 'read') AND public.marketplace_org_match_v1(organization_id));

SELECT pg_advisory_unlock(hashtext('202603071110_marketplace_network_registry_rls_v1'));
COMMIT;
