import type {
  MarketplaceContext,
  MarketplaceRequestKindCatalog,
  MarketplaceRpcResult,
} from "./marketplace-types";

type RpcArgs = Record<string, unknown> | undefined;
type RpcCaller = <T>(fn: string, args?: RpcArgs) => Promise<T>;

function withContext(context?: MarketplaceContext | null) {
  return context ?? {};
}

export function attachMarketplaceClient(rpc: RpcCaller) {
  return {
    marketplacePolicy: (context?: MarketplaceContext | null) =>
      rpc<Record<string, unknown>>("marketplace_policy_v1", {
        p_context: withContext(context),
      }),
    marketplaceRequestPolicy: (context?: MarketplaceContext | null) =>
      rpc<Record<string, unknown>>("marketplace_request_policy_v1", {
        p_context: withContext(context),
      }),
    marketplaceVisibilityPolicy: (context?: MarketplaceContext | null) =>
      rpc<Record<string, unknown>>("marketplace_visibility_policy_v1", {
        p_context: withContext(context),
      }),
    marketplaceExecutionPolicy: (context?: MarketplaceContext | null) =>
      rpc<Record<string, unknown>>("marketplace_execution_policy_v1", {
        p_context: withContext(context),
      }),
    marketplaceSettlementPolicy: (context?: MarketplaceContext | null) =>
      rpc<Record<string, unknown>>("marketplace_settlement_policy_v1", {
        p_context: withContext(context),
      }),
    marketplaceReputationPolicy: (context?: MarketplaceContext | null) =>
      rpc<Record<string, unknown>>("marketplace_reputation_policy_v1", {
        p_context: withContext(context),
      }),
    marketplaceTrackingDisplayPolicy: (context?: MarketplaceContext | null) =>
      rpc<Record<string, unknown>>("marketplace_tracking_display_policy_v1", {
        p_context: withContext(context),
      }),
    marketplaceCompliancePolicy: (context?: MarketplaceContext | null) =>
      rpc<Record<string, unknown>>("marketplace_compliance_policy_v1", {
        p_context: withContext(context),
      }),
    marketplaceRequestKindCatalog: (params?: {
      context?: MarketplaceContext | null;
      includeInactive?: boolean | null;
    }) =>
      rpc<MarketplaceRequestKindCatalog>("marketplace_request_kind_catalog_v1", {
        p_context: withContext(params?.context),
        p_include_inactive: params?.includeInactive ?? false,
      }),
    marketplaceParticipantRequestCreate: (params: {
      requestedParticipantTypeKey: string;
      email: string;
      fullName?: string | null;
      organizationName?: string | null;
      organizationSlug?: string | null;
      websiteUrl?: string | null;
      phone?: string | null;
      notes?: string | null;
      locale?: string | null;
      pageUrl?: string | null;
      referrer?: string | null;
      origin?: string | null;
      marketing?: Record<string, unknown> | null;
      ipHash?: string | null;
      turnstileVerified?: boolean | null;
      metadata?: Record<string, unknown> | null;
    }) =>
      rpc<MarketplaceRpcResult>("marketplace_participant_request_create_v1", {
        p_requested_participant_type_key: params.requestedParticipantTypeKey,
        p_email: params.email,
        p_full_name: params.fullName ?? null,
        p_organization_name: params.organizationName ?? null,
        p_organization_slug: params.organizationSlug ?? null,
        p_website_url: params.websiteUrl ?? null,
        p_phone: params.phone ?? null,
        p_notes: params.notes ?? null,
        p_locale: params.locale ?? null,
        p_page_url: params.pageUrl ?? null,
        p_referrer: params.referrer ?? null,
        p_origin: params.origin ?? null,
        p_marketing: params.marketing ?? {},
        p_ip_hash: params.ipHash ?? null,
        p_turnstile_verified: params.turnstileVerified ?? false,
        p_metadata: params.metadata ?? {},
      }),
    marketplaceProviderOptIn: (params: {
      displayName?: string | null;
      profile?: Record<string, unknown> | null;
      capabilities?: unknown[] | null;
    }) =>
      rpc<MarketplaceRpcResult>("marketplace_provider_opt_in_v1", {
        p_display_name: params.displayName ?? null,
        p_profile: params.profile ?? {},
        p_capabilities: params.capabilities ?? [],
      }),
    marketplaceParticipantRequestReviewApply: (params: {
      requestId: string;
      decision: string;
      reviewerUserId?: string | null;
      invitedAuthUserId?: string | null;
      inviteEmailSent?: boolean | null;
      inviteRedirectTo?: string | null;
      approvedOrganizationId?: string | null;
      approvedUserId?: string | null;
      decisionMetadata?: Record<string, unknown> | null;
    }) =>
      rpc<MarketplaceRpcResult>("marketplace_participant_request_review_apply_v1", {
        p_request_id: params.requestId,
        p_decision: params.decision,
        p_reviewer_user_id: params.reviewerUserId ?? null,
        p_invited_auth_user_id: params.invitedAuthUserId ?? null,
        p_invite_email_sent: params.inviteEmailSent ?? false,
        p_invite_redirect_to: params.inviteRedirectTo ?? null,
        p_approved_organization_id: params.approvedOrganizationId ?? null,
        p_approved_user_id: params.approvedUserId ?? null,
        p_decision_metadata: params.decisionMetadata ?? {},
      }),
    marketplaceCreateRequest: (params: {
      requestKindKey: string;
      title: string;
      summary?: string | null;
      requestDetails?: Record<string, unknown> | null;
      items?: unknown[];
      privatePool?: string[] | null;
      expiresAt?: string | null;
      metadata?: Record<string, unknown> | null;
    }) =>
      rpc<MarketplaceRpcResult>("marketplace_request_create_v1", {
        p_request_kind_key: params.requestKindKey,
        p_title: params.title,
        p_summary: params.summary ?? null,
        p_request_details: params.requestDetails ?? {},
        p_items: params.items ?? [],
        p_private_pool: params.privatePool ?? [],
        p_expires_at: params.expiresAt ?? null,
        p_metadata: params.metadata ?? {},
      }),
    marketplacePublishRequest: (params: {
      requestId: string;
      releaseState?: string | null;
    }) =>
      rpc<MarketplaceRpcResult>("marketplace_request_publish_v1", {
        p_request_id: params.requestId,
        p_release_state: params.releaseState ?? null,
      }),
    marketplaceCancelRequest: (params: {
      requestId: string;
      reason?: string | null;
    }) =>
      rpc<MarketplaceRpcResult>("marketplace_request_cancel_v1", {
        p_request_id: params.requestId,
        p_reason: params.reason ?? null,
      }),
    marketplaceSubmitOffer: (params: {
      requestId: string;
      terms?: Record<string, unknown> | null;
      pricing?: Record<string, unknown> | null;
      message?: string | null;
      expiresAt?: string | null;
      metadata?: Record<string, unknown> | null;
    }) =>
      rpc<MarketplaceRpcResult>("marketplace_offer_submit_v1", {
        p_request_id: params.requestId,
        p_terms: params.terms ?? {},
        p_pricing: params.pricing ?? {},
        p_message: params.message ?? null,
        p_expires_at: params.expiresAt ?? null,
        p_metadata: params.metadata ?? {},
      }),
    marketplaceOfferCounter: (params: {
      offerId: string;
      terms?: Record<string, unknown> | null;
      pricing?: Record<string, unknown> | null;
      message?: string | null;
      expiresAt?: string | null;
      metadata?: Record<string, unknown> | null;
    }) =>
      rpc<MarketplaceRpcResult>("marketplace_offer_counter_v1", {
        p_offer_id: params.offerId,
        p_terms: params.terms ?? {},
        p_pricing: params.pricing ?? {},
        p_message: params.message ?? null,
        p_expires_at: params.expiresAt ?? null,
        p_metadata: params.metadata ?? {},
      }),
    marketplaceWithdrawOffer: (params: {
      offerId: string;
      reason?: string | null;
    }) =>
      rpc<MarketplaceRpcResult>("marketplace_offer_withdraw_v1", {
        p_offer_id: params.offerId,
        p_reason: params.reason ?? null,
      }),
    marketplacePrivatePoolUpsert: (params: {
      requestId: string;
      privatePool?: string[] | null;
      metadata?: Record<string, unknown> | null;
    }) =>
      rpc<MarketplaceRpcResult>("marketplace_private_pool_upsert_v1", {
        p_request_id: params.requestId,
        p_private_pool: params.privatePool ?? [],
        p_metadata: params.metadata ?? {},
      }),
    marketplaceRequestRelease: (params: {
      requestId: string;
      releaseState: string;
      metadata?: Record<string, unknown> | null;
    }) =>
      rpc<MarketplaceRpcResult>("marketplace_request_release_v1", {
        p_request_id: params.requestId,
        p_release_state: params.releaseState,
        p_metadata: params.metadata ?? {},
      }),
    marketplaceRequestReopen: (params: {
      requestId: string;
      metadata?: Record<string, unknown> | null;
    }) =>
      rpc<MarketplaceRpcResult>("marketplace_request_reopen_v1", {
        p_request_id: params.requestId,
        p_metadata: params.metadata ?? {},
      }),
    marketplaceRequestExpire: (params: {
      requestId: string;
      reason?: string | null;
      metadata?: Record<string, unknown> | null;
    }) =>
      rpc<MarketplaceRpcResult>("marketplace_request_expire_v1", {
        p_request_id: params.requestId,
        p_reason: params.reason ?? null,
        p_metadata: params.metadata ?? {},
      }),
    marketplaceAwardOffer: (params: {
      offerId: string;
      awardReason?: string | null;
      awardTerms?: Record<string, unknown> | null;
      expiresAt?: string | null;
      metadata?: Record<string, unknown> | null;
    }) =>
      rpc<MarketplaceRpcResult>("marketplace_award_offer_v1", {
        p_offer_id: params.offerId,
        p_award_reason: params.awardReason ?? null,
        p_award_terms: params.awardTerms ?? {},
        p_expires_at: params.expiresAt ?? null,
        p_metadata: params.metadata ?? {},
      }),
    marketplaceRespondToAward: (params: {
      awardId: string;
      decision: string;
      metadata?: Record<string, unknown> | null;
    }) =>
      rpc<MarketplaceRpcResult>("marketplace_award_respond_v1", {
        p_award_id: params.awardId,
        p_decision: params.decision,
        p_metadata: params.metadata ?? {},
      }),
    marketplaceMaterializeWorkPackage: (params: {
      workPackageId?: string | null;
      awardId?: string | null;
      executionRef?: Record<string, unknown> | null;
      summary?: Record<string, unknown> | null;
      metadata?: Record<string, unknown> | null;
    }) =>
      rpc<MarketplaceRpcResult>("marketplace_work_package_materialize_v1", {
        p_work_package_id: params.workPackageId ?? null,
        p_award_id: params.awardId ?? null,
        p_execution_ref: params.executionRef ?? {},
        p_summary: params.summary ?? {},
        p_metadata: params.metadata ?? {},
      }),
    marketplaceAvailabilityUpsert: (params: {
      availabilityId?: string | null;
      startsAt: string;
      endsAt: string;
      availabilityStatus?: string | null;
      capacity?: Record<string, unknown> | null;
      metadata?: Record<string, unknown> | null;
    }) =>
      rpc<MarketplaceRpcResult>("marketplace_availability_upsert_v1", {
        p_availability_id: params.availabilityId ?? null,
        p_starts_at: params.startsAt,
        p_ends_at: params.endsAt,
        p_availability_status: params.availabilityStatus ?? "available",
        p_capacity: params.capacity ?? {},
        p_metadata: params.metadata ?? {},
      }),
    marketplaceCompleteWorkPackage: (params: {
      workPackageId: string;
      proof?: Record<string, unknown> | null;
      metadata?: Record<string, unknown> | null;
    }) =>
      rpc<MarketplaceRpcResult>("marketplace_work_package_complete_v1", {
        p_work_package_id: params.workPackageId,
        p_proof: params.proof ?? {},
        p_metadata: params.metadata ?? {},
      }),
    marketplaceSettlementFinalize: (params: {
      workPackageId?: string | null;
      contractId?: string | null;
      metadata?: Record<string, unknown> | null;
    }) =>
      rpc<MarketplaceRpcResult>("marketplace_settlement_finalize_v1", {
        p_work_package_id: params.workPackageId ?? null,
        p_contract_id: params.contractId ?? null,
        p_metadata: params.metadata ?? {},
      }),
    marketplaceSettlementReverse: (params: {
      workPackageId: string;
      reason?: string | null;
      metadata?: Record<string, unknown> | null;
    }) =>
      rpc<MarketplaceRpcResult>("marketplace_settlement_reverse_v1", {
        p_work_package_id: params.workPackageId,
        p_reason: params.reason ?? null,
        p_metadata: params.metadata ?? {},
      }),
    marketplaceOpenDispute: (params: {
      contractId?: string | null;
      workPackageId?: string | null;
      title?: string | null;
      description?: string | null;
      category?: string | null;
      metadata?: Record<string, unknown> | null;
    }) =>
      rpc<MarketplaceRpcResult>("marketplace_dispute_open_v1", {
        p_contract_id: params.contractId ?? null,
        p_work_package_id: params.workPackageId ?? null,
        p_title: params.title ?? null,
        p_description: params.description ?? null,
        p_category: params.category ?? "general",
        p_metadata: params.metadata ?? {},
      }),
    marketplaceResolveDispute: (params: {
      disputeId: string;
      status: string;
      resolution?: string | null;
      metadata?: Record<string, unknown> | null;
    }) =>
      rpc<MarketplaceRpcResult>("marketplace_dispute_resolve_v1", {
        p_dispute_id: params.disputeId,
        p_status: params.status,
        p_resolution: params.resolution ?? null,
        p_metadata: params.metadata ?? {},
      }),
    marketplaceReputationSnapshot: (params?: {
      participantProfileId?: string | null;
      organizationId?: string | null;
    }) =>
      rpc<MarketplaceRpcResult>("marketplace_reputation_snapshot_v1", {
        p_participant_profile_id: params?.participantProfileId ?? null,
        p_organization_id: params?.organizationId ?? null,
      }),
    marketplaceMatchingSuggestions: (params: {
      requestId: string;
      limit?: number | null;
    }) =>
      rpc<MarketplaceRpcResult>("marketplace_matching_suggestions_v1", {
        p_request_id: params.requestId,
        p_limit: params.limit ?? 10,
      }),
    marketplacePricingSuggestion: (params: {
      requestKindKey: string;
      requestDetails?: Record<string, unknown> | null;
      terms?: Record<string, unknown> | null;
    }) =>
      rpc<MarketplaceRpcResult>("marketplace_pricing_suggestion_v1", {
        p_request_kind_key: params.requestKindKey,
        p_request_details: params.requestDetails ?? {},
        p_terms: params.terms ?? {},
      }),
    marketplaceApplicationStatus: (params: { requestId: string }) =>
      rpc<MarketplaceRpcResult>("marketplace_application_status_v1", {
        p_request_id: params.requestId,
      }),
    marketplaceApplicationStatusByToken: (params: { statusToken: string }) =>
      rpc<MarketplaceRpcResult>("marketplace_application_status_by_token_v1", {
        p_status_token: params.statusToken,
      }),
    marketplaceRequestWorkspace: (params: { requestId: string }) =>
      rpc<MarketplaceRpcResult>("marketplace_request_workspace_v1", {
        p_request_id: params.requestId,
      }),
    marketplacePrivatePoolsWorkspace: (params?: {
      requesterOrganizationId?: string | null;
    }) =>
      rpc<MarketplaceRpcResult>("marketplace_private_pools_workspace_v1", {
        p_requester_organization_id: params?.requesterOrganizationId ?? null,
      }),
    marketplaceProviderWorkboard: (params?: { includeClosed?: boolean | null }) =>
      rpc<MarketplaceRpcResult>("marketplace_provider_workboard_v1", {
        p_include_closed: params?.includeClosed ?? false,
      }),
    marketplaceContractRoom: (params: { contractId: string }) =>
      rpc<MarketplaceRpcResult>("marketplace_contract_room_v1", {
        p_contract_id: params.contractId,
      }),
    marketplaceDisputeWorkspace: (params: { disputeId: string }) =>
      rpc<MarketplaceRpcResult>("marketplace_dispute_workspace_v1", {
        p_dispute_id: params.disputeId,
      }),
    marketplaceSettlementWorkspace: (params: {
      contractId?: string | null;
      workPackageId?: string | null;
    }) =>
      rpc<MarketplaceRpcResult>("marketplace_settlement_workspace_v1", {
        p_contract_id: params.contractId ?? null,
        p_work_package_id: params.workPackageId ?? null,
      }),
  };
}
