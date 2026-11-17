import { attachMarketplaceClient } from "../../../../packages/api/src/marketplace-client";

describe("attachMarketplaceClient", () => {
  it("maps request-kind catalog calls to the canonical RPC contract", async () => {
    const calls: Array<{ fn: string; args: Record<string, unknown> | undefined }> = [];
    const rpc = async <T,>(fn: string, args?: Record<string, unknown>) => {
      calls.push({ fn, args });
      return { ok: true } as T;
    };

    const client = attachMarketplaceClient(rpc);
    await client.marketplaceRequestKindCatalog({
      context: { organization_id: "org-1" },
      includeInactive: true,
    });

    expect(calls).toEqual([
      {
        fn: "marketplace_request_kind_catalog_v1",
        args: {
          p_context: { organization_id: "org-1" },
          p_include_inactive: true,
        },
      },
    ]);
  });

  it("maps request creation and publish calls through the typed marketplace wrapper", async () => {
    const calls: Array<{ fn: string; args: Record<string, unknown> | undefined }> = [];
    const rpc = async <T,>(fn: string, args?: Record<string, unknown>) => {
      calls.push({ fn, args });
      return { ok: true } as T;
    };

    const client = attachMarketplaceClient(rpc);

    await client.marketplaceCreateRequest({
      requestKindKey: "driver_shift_market",
      title: "Night shift in Riyadh",
      summary: "Eight-hour shift",
      requestDetails: { city: "Riyadh" },
      items: [],
      privatePool: ["tenant-a"],
      expiresAt: "2026-03-08T00:00:00Z",
      metadata: { source: "unit-test" },
    });

    await client.marketplacePublishRequest({
      requestId: "request-1",
      releaseState: "private_pool",
    });

    expect(calls).toEqual([
      {
        fn: "marketplace_request_create_v1",
        args: {
          p_request_kind_key: "driver_shift_market",
          p_title: "Night shift in Riyadh",
          p_summary: "Eight-hour shift",
          p_request_details: { city: "Riyadh" },
          p_items: [],
          p_private_pool: ["tenant-a"],
          p_expires_at: "2026-03-08T00:00:00Z",
          p_metadata: { source: "unit-test" },
        },
      },
      {
        fn: "marketplace_request_publish_v1",
        args: {
          p_request_id: "request-1",
          p_release_state: "private_pool",
        },
      },
    ]);
  });

  it("maps review, provider opt-in, award, materialization, and dispute calls to canonical RPC args", async () => {
    const calls: Array<{ fn: string; args: Record<string, unknown> | undefined }> = [];
    const rpc = async <T,>(fn: string, args?: Record<string, unknown>) => {
      calls.push({ fn, args });
      return { ok: true } as T;
    };

    const client = attachMarketplaceClient(rpc);

    await client.marketplaceProviderOptIn({
      displayName: "Fast Fleet",
      profile: { city: "Riyadh" },
      capabilities: ["cold_chain"],
    });

    await client.marketplaceParticipantRequestReviewApply({
      requestId: "request-1",
      decision: "approved",
      reviewerUserId: "reviewer-1",
      invitedAuthUserId: "auth-1",
      inviteEmailSent: true,
      inviteRedirectTo: "https://vvmruwrtzllojrtomtlgvwju.example.invalid/auth/callback",
      approvedOrganizationId: "org-2",
      approvedUserId: "user-2",
      decisionMetadata: { source: "console" },
    });

    await client.marketplaceCancelRequest({
      requestId: "request-2",
      reason: "No longer needed",
    });

    await client.marketplacePrivatePoolUpsert({
      requestId: "request-2",
      privatePool: ["tenant-a", "tenant-b"],
      metadata: { source: "portal" },
    });

    await client.marketplaceRequestRelease({
      requestId: "request-2",
      releaseState: "curated_network",
      metadata: { released_by: "dispatcher" },
    });

    await client.marketplaceRequestReopen({
      requestId: "request-2",
      metadata: { reason: "reopened" },
    });

    await client.marketplaceRequestExpire({
      requestId: "request-2",
      reason: "Window elapsed",
      metadata: { source: "scheduler" },
    });

    await client.marketplaceWithdrawOffer({
      offerId: "offer-1",
      reason: "Capacity changed",
    });

    await client.marketplaceOfferCounter({
      offerId: "offer-1",
      terms: { sla_minutes: 45 },
      pricing: { amount: 180, currency: "SAR" },
      message: "Counter with tighter SLA",
      expiresAt: "2026-03-08T08:00:00Z",
      metadata: { source: "portal" },
    });

    await client.marketplaceAwardOffer({
      offerId: "offer-2",
      awardReason: "Best SLA",
      awardTerms: { payout_days: 7 },
      expiresAt: "2026-03-09T00:00:00Z",
      metadata: { source: "portal" },
    });

    await client.marketplaceRespondToAward({
      awardId: "award-1",
      decision: "accepted",
      metadata: { acknowledged: true },
    });

    await client.marketplaceMaterializeWorkPackage({
      workPackageId: "wp-1",
      awardId: "award-1",
      executionRef: { route_run_id: "rr-1" },
      summary: { stops: 12 },
      metadata: { source: "materializer" },
    });

    await client.marketplaceAvailabilityUpsert({
      availabilityId: "availability-1",
      startsAt: "2026-03-08T06:00:00Z",
      endsAt: "2026-03-08T14:00:00Z",
      availabilityStatus: "available",
      capacity: { shipments: 30 },
      metadata: { source: "fieldops" },
    });

    await client.marketplaceCompleteWorkPackage({
      workPackageId: "wp-1",
      proof: { proof_quality: 4.5, feedback_score: 5 },
      metadata: { source: "fieldops" },
    });

    await client.marketplaceSettlementFinalize({
      workPackageId: "wp-1",
      contractId: "contract-1",
      metadata: { source: "ops" },
    });

    await client.marketplaceSettlementReverse({
      workPackageId: "wp-1",
      reason: "Dispute upheld",
      metadata: { source: "ops" },
    });

    await client.marketplaceOpenDispute({
      contractId: "contract-1",
      workPackageId: "wp-1",
      title: "Missing POD",
      description: "Proof of delivery was not attached.",
      category: "proof",
      metadata: { severity: "high" },
    });

    await client.marketplaceApplicationStatus({
      requestId: "request-1",
    });

    await client.marketplaceApplicationStatusByToken({
      statusToken: "token-1",
    });

    await client.marketplaceRequestWorkspace({
      requestId: "request-2",
    });

    await client.marketplaceProviderWorkboard({
      includeClosed: true,
    });

    await client.marketplaceContractRoom({
      contractId: "contract-1",
    });

    await client.marketplaceDisputeWorkspace({
      disputeId: "dispute-1",
    });

    await client.marketplaceSettlementWorkspace({
      contractId: "contract-1",
      workPackageId: "wp-1",
    });

    expect(calls).toEqual([
      {
        fn: "marketplace_provider_opt_in_v1",
        args: {
          p_display_name: "Fast Fleet",
          p_profile: { city: "Riyadh" },
          p_capabilities: ["cold_chain"],
        },
      },
      {
        fn: "marketplace_participant_request_review_apply_v1",
        args: {
          p_request_id: "request-1",
          p_decision: "approved",
          p_reviewer_user_id: "reviewer-1",
          p_invited_auth_user_id: "auth-1",
          p_invite_email_sent: true,
          p_invite_redirect_to: "https://vvmruwrtzllojrtomtlgvwju.example.invalid/auth/callback",
          p_approved_organization_id: "org-2",
          p_approved_user_id: "user-2",
          p_decision_metadata: { source: "console" },
        },
      },
      {
        fn: "marketplace_request_cancel_v1",
        args: {
          p_request_id: "request-2",
          p_reason: "No longer needed",
        },
      },
      {
        fn: "marketplace_private_pool_upsert_v1",
        args: {
          p_request_id: "request-2",
          p_private_pool: ["tenant-a", "tenant-b"],
          p_metadata: { source: "portal" },
        },
      },
      {
        fn: "marketplace_request_release_v1",
        args: {
          p_request_id: "request-2",
          p_release_state: "curated_network",
          p_metadata: { released_by: "dispatcher" },
        },
      },
      {
        fn: "marketplace_request_reopen_v1",
        args: {
          p_request_id: "request-2",
          p_metadata: { reason: "reopened" },
        },
      },
      {
        fn: "marketplace_request_expire_v1",
        args: {
          p_request_id: "request-2",
          p_reason: "Window elapsed",
          p_metadata: { source: "scheduler" },
        },
      },
      {
        fn: "marketplace_offer_withdraw_v1",
        args: {
          p_offer_id: "offer-1",
          p_reason: "Capacity changed",
        },
      },
      {
        fn: "marketplace_offer_counter_v1",
        args: {
          p_offer_id: "offer-1",
          p_terms: { sla_minutes: 45 },
          p_pricing: { amount: 180, currency: "SAR" },
          p_message: "Counter with tighter SLA",
          p_expires_at: "2026-03-08T08:00:00Z",
          p_metadata: { source: "portal" },
        },
      },
      {
        fn: "marketplace_award_offer_v1",
        args: {
          p_offer_id: "offer-2",
          p_award_reason: "Best SLA",
          p_award_terms: { payout_days: 7 },
          p_expires_at: "2026-03-09T00:00:00Z",
          p_metadata: { source: "portal" },
        },
      },
      {
        fn: "marketplace_award_respond_v1",
        args: {
          p_award_id: "award-1",
          p_decision: "accepted",
          p_metadata: { acknowledged: true },
        },
      },
      {
        fn: "marketplace_work_package_materialize_v1",
        args: {
          p_work_package_id: "wp-1",
          p_award_id: "award-1",
          p_execution_ref: { route_run_id: "rr-1" },
          p_summary: { stops: 12 },
          p_metadata: { source: "materializer" },
        },
      },
      {
        fn: "marketplace_availability_upsert_v1",
        args: {
          p_availability_id: "availability-1",
          p_starts_at: "2026-03-08T06:00:00Z",
          p_ends_at: "2026-03-08T14:00:00Z",
          p_availability_status: "available",
          p_capacity: { shipments: 30 },
          p_metadata: { source: "fieldops" },
        },
      },
      {
        fn: "marketplace_work_package_complete_v1",
        args: {
          p_work_package_id: "wp-1",
          p_proof: { proof_quality: 4.5, feedback_score: 5 },
          p_metadata: { source: "fieldops" },
        },
      },
      {
        fn: "marketplace_settlement_finalize_v1",
        args: {
          p_work_package_id: "wp-1",
          p_contract_id: "contract-1",
          p_metadata: { source: "ops" },
        },
      },
      {
        fn: "marketplace_settlement_reverse_v1",
        args: {
          p_work_package_id: "wp-1",
          p_reason: "Dispute upheld",
          p_metadata: { source: "ops" },
        },
      },
      {
        fn: "marketplace_dispute_open_v1",
        args: {
          p_contract_id: "contract-1",
          p_work_package_id: "wp-1",
          p_title: "Missing POD",
          p_description: "Proof of delivery was not attached.",
          p_category: "proof",
          p_metadata: { severity: "high" },
        },
      },
      {
        fn: "marketplace_application_status_v1",
        args: {
          p_request_id: "request-1",
        },
      },
      {
        fn: "marketplace_application_status_by_token_v1",
        args: {
          p_status_token: "token-1",
        },
      },
      {
        fn: "marketplace_request_workspace_v1",
        args: {
          p_request_id: "request-2",
        },
      },
      {
        fn: "marketplace_provider_workboard_v1",
        args: {
          p_include_closed: true,
        },
      },
      {
        fn: "marketplace_contract_room_v1",
        args: {
          p_contract_id: "contract-1",
        },
      },
      {
        fn: "marketplace_dispute_workspace_v1",
        args: {
          p_dispute_id: "dispute-1",
        },
      },
      {
        fn: "marketplace_settlement_workspace_v1",
        args: {
          p_contract_id: "contract-1",
          p_work_package_id: "wp-1",
        },
      },
    ]);
  });
});
