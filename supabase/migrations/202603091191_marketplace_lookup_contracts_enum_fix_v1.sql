-- Plan: PLAN-202603-marketplace-network-product-complete / Step: S04
-- Migration: Replace marketplace literal enum CHECK constraints with row-driven lookup contracts

BEGIN;
SELECT pg_advisory_lock(hashtext('202603091191_marketplace_lookup_contracts_enum_fix_v1'));
SET search_path TO public, extensions, pg_temp;

-------------------------------------------------------------------------------
-- 1) Lookup categories for marketplace lifecycle/listing domains
-------------------------------------------------------------------------------

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES
  ('marketplace_participant_profile_status', 'Marketplace participant profile lifecycle status.', 'engineering', 'tier_1', FALSE),
  ('marketplace_participant_listing_status', 'Marketplace participant listing visibility state.', 'engineering', 'tier_1', FALSE),
  ('marketplace_participant_compliance_state', 'Marketplace participant compliance verification state.', 'engineering', 'tier_1', FALSE),
  ('marketplace_participant_membership_status', 'Marketplace participant membership status.', 'engineering', 'tier_1', FALSE),
  ('marketplace_participant_request_status', 'Marketplace participant request lifecycle status.', 'engineering', 'tier_1', FALSE),
  ('marketplace_participant_request_review_decision', 'Marketplace participant request review decision.', 'engineering', 'tier_1', FALSE),
  ('marketplace_participant_capability_status', 'Marketplace participant capability status.', 'engineering', 'tier_1', FALSE),
  ('marketplace_verification_status', 'Marketplace verification record status.', 'engineering', 'tier_1', FALSE),
  ('marketplace_availability_status', 'Marketplace participant availability window status.', 'engineering', 'tier_1', FALSE),
  ('marketplace_request_status', 'Marketplace request lifecycle status.', 'engineering', 'tier_1', FALSE),
  ('marketplace_request_release_state', 'Marketplace request release visibility state.', 'engineering', 'tier_1', FALSE),
  ('marketplace_request_item_status', 'Marketplace request item status.', 'engineering', 'tier_1', FALSE),
  ('marketplace_offer_status', 'Marketplace offer lifecycle status.', 'engineering', 'tier_1', FALSE),
  ('marketplace_award_status', 'Marketplace award lifecycle status.', 'engineering', 'tier_1', FALSE),
  ('marketplace_contract_status', 'Marketplace contract lifecycle status.', 'engineering', 'tier_1', FALSE),
  ('marketplace_work_package_status', 'Marketplace work package lifecycle status.', 'engineering', 'tier_1', FALSE),
  ('marketplace_work_package_materialization_state', 'Marketplace work package materialization state.', 'engineering', 'tier_1', FALSE),
  ('marketplace_dispute_status', 'Marketplace dispute lifecycle status.', 'engineering', 'tier_1', FALSE)
ON CONFLICT (category) DO UPDATE
SET
  description = EXCLUDED.description,
  owner_role = EXCLUDED.owner_role,
  approval_policy = EXCLUDED.approval_policy,
  is_mutable = EXCLUDED.is_mutable;

INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  description,
  sort_order,
  is_default,
  status
)
SELECT
  d.id,
  v.value,
  v.label,
  v.description,
  v.sort_order,
  v.is_default,
  'active'
FROM public.lookup_definitions d
JOIN (
  VALUES
    ('marketplace_participant_profile_status', 'pending', 'Pending', 'Awaiting approval.', 10, TRUE),
    ('marketplace_participant_profile_status', 'approved', 'Approved', 'Approved to operate in the network.', 20, FALSE),
    ('marketplace_participant_profile_status', 'rejected', 'Rejected', 'Rejected from the network.', 30, FALSE),
    ('marketplace_participant_profile_status', 'suspended', 'Suspended', 'Temporarily suspended from the network.', 40, FALSE),

    ('marketplace_participant_listing_status', 'private', 'Private', 'Visible only in private pools.', 10, TRUE),
    ('marketplace_participant_listing_status', 'curated_network', 'Curated network', 'Visible in the curated network.', 20, FALSE),
    ('marketplace_participant_listing_status', 'public', 'Public', 'Visible to public network listings when enabled.', 30, FALSE),

    ('marketplace_participant_compliance_state', 'pending', 'Pending', 'Awaiting compliance review.', 10, TRUE),
    ('marketplace_participant_compliance_state', 'approved', 'Approved', 'Compliance approved.', 20, FALSE),
    ('marketplace_participant_compliance_state', 'rejected', 'Rejected', 'Compliance rejected.', 30, FALSE),
    ('marketplace_participant_compliance_state', 'expired', 'Expired', 'Compliance expired and requires refresh.', 40, FALSE),
    ('marketplace_participant_compliance_state', 'suspended', 'Suspended', 'Compliance suspended.', 50, FALSE),

    ('marketplace_participant_membership_status', 'active', 'Active', 'Membership is active.', 10, TRUE),
    ('marketplace_participant_membership_status', 'inactive', 'Inactive', 'Membership is inactive.', 20, FALSE),

    ('marketplace_participant_request_status', 'pending', 'Pending', 'Participant request awaiting review.', 10, TRUE),
    ('marketplace_participant_request_status', 'approved', 'Approved', 'Participant request approved.', 20, FALSE),
    ('marketplace_participant_request_status', 'rejected', 'Rejected', 'Participant request rejected.', 30, FALSE),
    ('marketplace_participant_request_status', 'withdrawn', 'Withdrawn', 'Participant request withdrawn.', 40, FALSE),

    ('marketplace_participant_request_review_decision', 'approved', 'Approved', 'Reviewer approved the request.', 10, TRUE),
    ('marketplace_participant_request_review_decision', 'rejected', 'Rejected', 'Reviewer rejected the request.', 20, FALSE),

    ('marketplace_participant_capability_status', 'active', 'Active', 'Capability is active.', 10, TRUE),
    ('marketplace_participant_capability_status', 'inactive', 'Inactive', 'Capability is inactive.', 20, FALSE),
    ('marketplace_participant_capability_status', 'expired', 'Expired', 'Capability expired and needs renewal.', 30, FALSE),

    ('marketplace_verification_status', 'pending', 'Pending', 'Verification pending.', 10, TRUE),
    ('marketplace_verification_status', 'approved', 'Approved', 'Verification approved.', 20, FALSE),
    ('marketplace_verification_status', 'rejected', 'Rejected', 'Verification rejected.', 30, FALSE),
    ('marketplace_verification_status', 'expired', 'Expired', 'Verification expired.', 40, FALSE),

    ('marketplace_availability_status', 'available', 'Available', 'Participant is available.', 10, TRUE),
    ('marketplace_availability_status', 'unavailable', 'Unavailable', 'Participant is unavailable.', 20, FALSE),
    ('marketplace_availability_status', 'reserved', 'Reserved', 'Participant capacity is reserved.', 30, FALSE),

    ('marketplace_request_status', 'draft', 'Draft', 'Request is still being drafted.', 10, TRUE),
    ('marketplace_request_status', 'published', 'Published', 'Request has been published.', 20, FALSE),
    ('marketplace_request_status', 'negotiation', 'Negotiation', 'Request is in negotiation.', 30, FALSE),
    ('marketplace_request_status', 'awarded', 'Awarded', 'Request has been awarded.', 40, FALSE),
    ('marketplace_request_status', 'award_pending_acceptance', 'Award pending acceptance', 'Request award is pending provider acceptance.', 50, FALSE),
    ('marketplace_request_status', 'provider_accepted', 'Provider accepted', 'Provider accepted the award.', 60, FALSE),
    ('marketplace_request_status', 'materialized', 'Materialized', 'Award has materialized into execution.', 70, FALSE),
    ('marketplace_request_status', 'executing', 'Executing', 'Execution is underway.', 80, FALSE),
    ('marketplace_request_status', 'in_execution', 'In execution', 'Execution is underway.', 90, FALSE),
    ('marketplace_request_status', 'completed', 'Completed', 'Execution is complete.', 100, FALSE),
    ('marketplace_request_status', 'settled', 'Settled', 'Settlement recorded.', 110, FALSE),
    ('marketplace_request_status', 'cancelled', 'Cancelled', 'Request was cancelled.', 120, FALSE),
    ('marketplace_request_status', 'expired', 'Expired', 'Request expired without completion.', 130, FALSE),
    ('marketplace_request_status', 'disputed', 'Disputed', 'Request moved into dispute.', 140, FALSE),

    ('marketplace_request_release_state', 'private_pool', 'Private pool', 'Released only to the private pool.', 10, TRUE),
    ('marketplace_request_release_state', 'curated_network', 'Curated network', 'Released to the curated network.', 20, FALSE),
    ('marketplace_request_release_state', 'public', 'Public', 'Released to the public network.', 30, FALSE),

    ('marketplace_request_item_status', 'open', 'Open', 'Request item is open.', 10, TRUE),
    ('marketplace_request_item_status', 'closed', 'Closed', 'Request item is closed.', 20, FALSE),
    ('marketplace_request_item_status', 'cancelled', 'Cancelled', 'Request item is cancelled.', 30, FALSE),

    ('marketplace_offer_status', 'submitted', 'Submitted', 'Offer submitted.', 10, TRUE),
    ('marketplace_offer_status', 'countered', 'Countered', 'Offer was countered.', 20, FALSE),
    ('marketplace_offer_status', 'withdrawn', 'Withdrawn', 'Offer was withdrawn.', 30, FALSE),
    ('marketplace_offer_status', 'accepted', 'Accepted', 'Offer was accepted.', 40, FALSE),
    ('marketplace_offer_status', 'rejected', 'Rejected', 'Offer was rejected.', 50, FALSE),
    ('marketplace_offer_status', 'expired', 'Expired', 'Offer expired.', 60, FALSE),

    ('marketplace_award_status', 'pending_acceptance', 'Pending acceptance', 'Award awaits provider acceptance.', 10, TRUE),
    ('marketplace_award_status', 'accepted', 'Accepted', 'Award accepted.', 20, FALSE),
    ('marketplace_award_status', 'rejected', 'Rejected', 'Award rejected.', 30, FALSE),
    ('marketplace_award_status', 'materialized', 'Materialized', 'Award materialized into work package.', 40, FALSE),
    ('marketplace_award_status', 'cancelled', 'Cancelled', 'Award cancelled.', 50, FALSE),
    ('marketplace_award_status', 'expired', 'Expired', 'Award expired.', 60, FALSE),

    ('marketplace_contract_status', 'pending_acceptance', 'Pending acceptance', 'Contract awaits provider acceptance.', 10, TRUE),
    ('marketplace_contract_status', 'active', 'Active', 'Contract is active.', 20, FALSE),
    ('marketplace_contract_status', 'materialized', 'Materialized', 'Contract has materialized into execution.', 30, FALSE),
    ('marketplace_contract_status', 'executing', 'Executing', 'Contract execution is underway.', 40, FALSE),
    ('marketplace_contract_status', 'completed', 'Completed', 'Contract execution is complete.', 50, FALSE),
    ('marketplace_contract_status', 'settled', 'Settled', 'Contract is settled.', 60, FALSE),
    ('marketplace_contract_status', 'cancelled', 'Cancelled', 'Contract is cancelled.', 70, FALSE),
    ('marketplace_contract_status', 'rejected', 'Rejected', 'Contract is rejected.', 80, FALSE),
    ('marketplace_contract_status', 'disputed', 'Disputed', 'Contract is disputed.', 90, FALSE),

    ('marketplace_work_package_status', 'pending_acceptance', 'Pending acceptance', 'Work package awaits provider acceptance.', 10, TRUE),
    ('marketplace_work_package_status', 'ready', 'Ready', 'Work package is ready.', 20, FALSE),
    ('marketplace_work_package_status', 'materialized', 'Materialized', 'Work package materialized into execution artifacts.', 30, FALSE),
    ('marketplace_work_package_status', 'in_execution', 'In execution', 'Work package execution is underway.', 40, FALSE),
    ('marketplace_work_package_status', 'executing', 'Executing', 'Work package execution is underway.', 50, FALSE),
    ('marketplace_work_package_status', 'completed', 'Completed', 'Work package is complete.', 60, FALSE),
    ('marketplace_work_package_status', 'settled', 'Settled', 'Work package is settled.', 70, FALSE),
    ('marketplace_work_package_status', 'cancelled', 'Cancelled', 'Work package is cancelled.', 80, FALSE),
    ('marketplace_work_package_status', 'disputed', 'Disputed', 'Work package is disputed.', 90, FALSE),

    ('marketplace_work_package_materialization_state', 'pending', 'Pending', 'Materialization is pending.', 10, TRUE),
    ('marketplace_work_package_materialization_state', 'materialized', 'Materialized', 'Materialization succeeded.', 20, FALSE),
    ('marketplace_work_package_materialization_state', 'failed', 'Failed', 'Materialization failed.', 30, FALSE),
    ('marketplace_work_package_materialization_state', 'manual', 'Manual', 'Manual materialization required.', 40, FALSE),

    ('marketplace_dispute_status', 'open', 'Open', 'Dispute is open.', 10, TRUE),
    ('marketplace_dispute_status', 'under_review', 'Under review', 'Dispute is under review.', 20, FALSE),
    ('marketplace_dispute_status', 'resolved', 'Resolved', 'Dispute is resolved.', 30, FALSE),
    ('marketplace_dispute_status', 'rejected', 'Rejected', 'Dispute is rejected.', 40, FALSE)
) AS v(category, value, label, description, sort_order, is_default)
  ON d.category = v.category
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  is_default = EXCLUDED.is_default,
  status = EXCLUDED.status,
  retired_at = NULL,
  effective_until = NULL,
  updated_at = now();

-------------------------------------------------------------------------------
-- 2) Bind marketplace columns to lookup contracts
-------------------------------------------------------------------------------

INSERT INTO public.lookup_column_contracts (table_schema, table_name, column_name, lookup_category, allowed_values)
VALUES
  ('public', 'marketplace_participant_profiles', 'status', 'marketplace_participant_profile_status', NULL),
  ('public', 'marketplace_participant_profiles', 'listing_status', 'marketplace_participant_listing_status', NULL),
  ('public', 'marketplace_participant_profiles', 'compliance_state', 'marketplace_participant_compliance_state', NULL),
  ('public', 'marketplace_participant_memberships', 'status', 'marketplace_participant_membership_status', NULL),
  ('public', 'marketplace_participant_requests', 'status', 'marketplace_participant_request_status', NULL),
  ('public', 'marketplace_participant_requests', 'review_decision', 'marketplace_participant_request_review_decision', NULL),
  ('public', 'marketplace_participant_capabilities', 'status', 'marketplace_participant_capability_status', NULL),
  ('public', 'marketplace_verification_records', 'status', 'marketplace_verification_status', NULL),
  ('public', 'marketplace_availability_windows', 'availability_status', 'marketplace_availability_status', NULL),
  ('public', 'marketplace_requests', 'status', 'marketplace_request_status', NULL),
  ('public', 'marketplace_requests', 'release_state', 'marketplace_request_release_state', NULL),
  ('public', 'marketplace_request_items', 'status', 'marketplace_request_item_status', NULL),
  ('public', 'marketplace_offers', 'status', 'marketplace_offer_status', NULL),
  ('public', 'marketplace_awards', 'status', 'marketplace_award_status', NULL),
  ('public', 'marketplace_contracts', 'status', 'marketplace_contract_status', NULL),
  ('public', 'marketplace_work_packages', 'status', 'marketplace_work_package_status', NULL),
  ('public', 'marketplace_work_packages', 'materialization_state', 'marketplace_work_package_materialization_state', NULL),
  ('public', 'marketplace_disputes', 'status', 'marketplace_dispute_status', NULL)
ON CONFLICT ON CONSTRAINT lookup_column_contracts_unique DO UPDATE
SET
  lookup_category = EXCLUDED.lookup_category,
  allowed_values = EXCLUDED.allowed_values;

SELECT public.apply_lookup_column_contracts('public');

-------------------------------------------------------------------------------
-- 3) Remove literal-list CHECK constraints now superseded by lookup contracts
-------------------------------------------------------------------------------

ALTER TABLE public.marketplace_participant_profiles
  DROP CONSTRAINT IF EXISTS marketplace_participant_profiles_status_ck,
  DROP CONSTRAINT IF EXISTS marketplace_participant_profiles_listing_status_ck,
  DROP CONSTRAINT IF EXISTS marketplace_participant_profiles_compliance_state_ck;

ALTER TABLE public.marketplace_participant_memberships
  DROP CONSTRAINT IF EXISTS marketplace_participant_memberships_status_ck;

ALTER TABLE public.marketplace_participant_requests
  DROP CONSTRAINT IF EXISTS marketplace_participant_requests_status_ck,
  DROP CONSTRAINT IF EXISTS marketplace_participant_requests_review_decision_ck,
  DROP CONSTRAINT IF EXISTS marketplace_participant_requests_email_ck;

ALTER TABLE public.marketplace_participant_requests
  ADD CONSTRAINT marketplace_participant_requests_email_ck
  CHECK (email ~* '^[^@[:space:]]+@[^@[:space:]]+$');

ALTER TABLE public.marketplace_participant_capabilities
  DROP CONSTRAINT IF EXISTS marketplace_participant_capabilities_status_ck;

ALTER TABLE public.marketplace_verification_records
  DROP CONSTRAINT IF EXISTS marketplace_verification_records_status_ck;

ALTER TABLE public.marketplace_availability_windows
  DROP CONSTRAINT IF EXISTS marketplace_availability_windows_status_ck;

ALTER TABLE public.marketplace_requests
  DROP CONSTRAINT IF EXISTS marketplace_requests_status_ck,
  DROP CONSTRAINT IF EXISTS marketplace_requests_release_state_ck;

ALTER TABLE public.marketplace_request_items
  DROP CONSTRAINT IF EXISTS marketplace_request_items_status_ck;

ALTER TABLE public.marketplace_offers
  DROP CONSTRAINT IF EXISTS marketplace_offers_status_ck;

ALTER TABLE public.marketplace_awards
  DROP CONSTRAINT IF EXISTS marketplace_awards_status_ck;

ALTER TABLE public.marketplace_contracts
  DROP CONSTRAINT IF EXISTS marketplace_contracts_status_ck;

ALTER TABLE public.marketplace_work_packages
  DROP CONSTRAINT IF EXISTS marketplace_work_packages_status_ck,
  DROP CONSTRAINT IF EXISTS marketplace_work_packages_materialization_state_ck;

ALTER TABLE public.marketplace_disputes
  DROP CONSTRAINT IF EXISTS marketplace_disputes_status_ck;

SELECT pg_advisory_unlock(hashtext('202603091191_marketplace_lookup_contracts_enum_fix_v1'));
COMMIT;
